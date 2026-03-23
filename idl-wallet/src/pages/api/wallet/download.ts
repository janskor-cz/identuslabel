import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs';
import path from 'path';

const REGISTRY_PATH = path.join(process.cwd(), 'data', 'wallet-registry.json');
const IAGON_BASE_URL = process.env.IAGON_DOWNLOAD_BASE_URL || 'https://gw.iagon.com/api/v2';

function loadRegistry(): Record<string, { fileId: string; updatedAt: string }> {
    try {
        if (fs.existsSync(REGISTRY_PATH)) {
            return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
        }
    } catch {
        // ignore
    }
    return {};
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { username } = req.body;
    if (!username || typeof username !== 'string') {
        return res.status(400).json({ error: 'username required' });
    }

    const accessToken = process.env.IAGON_ACCESS_TOKEN;
    const nodeId = process.env.IAGON_NODE_ID;

    if (!accessToken || !nodeId) {
        return res.status(503).json({ error: 'Iagon storage not configured on this server' });
    }

    const registry = loadRegistry();
    const entry = registry[username.toLowerCase()];

    if (!entry) {
        return res.status(404).json({ error: 'No backup found for this username' });
    }

    try {
        const response = await fetch(`${IAGON_BASE_URL}/storage/download`, {
            method: 'POST',
            headers: { 'x-api-key': accessToken, 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: entry.fileId, files: [entry.fileId] }),
        });

        if (!response.ok) {
            throw new Error(`Iagon responded with ${response.status}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const base64Data = Buffer.from(arrayBuffer).toString('base64');
        return res.status(200).json({ data: base64Data });
    } catch (err: any) {
        console.error('[wallet/download] Iagon download failed:', err.message);
        return res.status(502).json({ error: 'Failed to download backup from Iagon' });
    }
}
