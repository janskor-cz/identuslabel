import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs';
import path from 'path';
import axios from 'axios';

const REGISTRY_PATH = path.join(process.cwd(), 'data', 'wallet-registry.json');
const IAGON_BASE_URL = process.env.IAGON_DOWNLOAD_BASE_URL || 'https://gw.iagon.com/api/v2';

interface Registry {
    wallets: Record<string, { fileId: string; contentHash: string; updatedAt: string }>;
}

function saveRegistry(registry: Registry) {
    const dir = path.dirname(REGISTRY_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf-8');
}

function loadRegistry(): Registry {
    try {
        if (fs.existsSync(REGISTRY_PATH)) {
            const parsed = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
            if (!parsed.wallets) return { wallets: {} };
            return parsed as Registry;
        }
    } catch {
        // ignore
    }
    return { wallets: {} };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { credHash } = req.body;
    if (!credHash || typeof credHash !== 'string' || !/^[0-9a-f]{64}$/.test(credHash)) {
        return res.status(400).json({ error: 'credHash required (64-char hex)' });
    }

    const accessToken = process.env.IAGON_ACCESS_TOKEN;
    const nodeId = process.env.IAGON_NODE_ID;

    if (!accessToken || !nodeId) {
        return res.status(503).json({ error: 'Iagon storage not configured on this server' });
    }

    const registry = loadRegistry();
    const entry = registry.wallets[credHash];

    if (!entry) {
        return res.status(404).json({ error: 'No backup found for these credentials' });
    }

    try {
        const response = await axios.post(
            `${IAGON_BASE_URL}/storage/download`,
            { id: entry.fileId, files: [entry.fileId] },
            {
                headers: { 'x-api-key': accessToken, 'Content-Type': 'application/json' },
                responseType: 'arraybuffer',
                timeout: 120000,
            }
        );

        const base64Data = Buffer.from(response.data).toString('base64');
        return res.status(200).json({ data: base64Data });
    } catch (err: any) {
        const body = err.response?.data ? Buffer.from(err.response.data).toString('utf8').substring(0, 200) : '(no body)';
        console.error('[wallet/download] Iagon download failed:', err.message, '| response:', body);
        // If Iagon says the file is missing, remove the stale registry entry so the next sync re-uploads
        if (err.response?.status === 400 || err.response?.status === 404) {
            try {
                const reg = loadRegistry();
                if (reg.wallets[credHash]) {
                    delete reg.wallets[credHash];
                    saveRegistry(reg);
                    console.log('[wallet/download] Removed stale registry entry for', credHash.substring(0, 8));
                }
            } catch { /* ignore */ }
            return res.status(404).json({ error: 'Backup file not found on Iagon (stale registry entry removed)' });
        }
        return res.status(502).json({ error: 'Failed to download backup from Iagon' });
    }
}
