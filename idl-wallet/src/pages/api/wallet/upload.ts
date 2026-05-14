import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs';
import path from 'path';
import FormData from 'form-data';
import axios from 'axios';

const REGISTRY_PATH = path.join(process.cwd(), 'data', 'wallet-registry.json');
const IAGON_BASE_URL = process.env.IAGON_DOWNLOAD_BASE_URL || 'https://gw.iagon.com/api/v2';

interface RegistryEntry {
    fileId: string;
    contentHash: string;
    updatedAt: string;
}

interface Registry {
    wallets: Record<string, RegistryEntry>;
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

function saveRegistry(registry: Registry) {
    const dir = path.dirname(REGISTRY_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf-8');
}

export const config = {
    api: { bodyParser: { sizeLimit: '10mb' } },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { credHash, contentHash, data } = req.body;
    if (!credHash || typeof credHash !== 'string' || !/^[0-9a-f]{64}$/.test(credHash)) {
        return res.status(400).json({ error: 'credHash required (64-char hex)' });
    }
    if (!contentHash || typeof contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(contentHash)) {
        return res.status(400).json({ error: 'contentHash required (64-char hex)' });
    }
    if (!data || typeof data !== 'string') {
        return res.status(400).json({ error: 'data required' });
    }

    const accessToken = process.env.IAGON_ACCESS_TOKEN;
    const nodeId = process.env.IAGON_NODE_ID;

    if (!accessToken || !nodeId) {
        return res.status(503).json({ error: 'Iagon storage not configured on this server' });
    }

    const fileBuffer = Buffer.from(data, 'base64');
    // Filename includes contentHash so each wallet version is a unique file on Iagon.
    // This avoids "file already exists" errors without needing to delete old versions first.
    // Old versions become orphaned on Iagon (acceptable — storage is cheap, correctness matters).
    const filename = `wallets-${credHash.substring(0, 16)}-${contentHash.substring(0, 16)}.jwe`;

    const registry = loadRegistry();

    const formData = new FormData();
    formData.append('file', fileBuffer, { filename, contentType: 'application/octet-stream' });
    formData.append('node_id', nodeId);

    try {
        const response = await axios.post(`${IAGON_BASE_URL}/storage/upload`, formData, {
            headers: {
                ...formData.getHeaders(),
                'x-api-key': accessToken,
            },
            timeout: 120000,
            maxContentLength: 10 * 1024 * 1024,
            maxBodyLength: 10 * 1024 * 1024,
        });

        if (response.status !== 200 && response.status !== 201) {
            throw new Error(`Iagon responded with ${response.status}`);
        }

        const json = response.data as any;
        const fileId = json?.data?._id;
        if (!fileId) {
            return res.status(502).json({ error: 'Iagon did not return a file ID' });
        }

        registry.wallets[credHash] = { fileId, contentHash, updatedAt: new Date().toISOString() };
        saveRegistry(registry);

        return res.status(200).json({ success: true, fileId });
    } catch (err: any) {
        const body = err.response?.data ? JSON.stringify(err.response.data).substring(0, 300) : '(no body)';
        console.error('[wallet/upload] Iagon upload failed:', err.message, '| response:', body);
        return res.status(502).json({ error: 'Failed to upload backup to Iagon' });
    }
}
