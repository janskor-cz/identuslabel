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

function saveRegistry(registry: Record<string, { fileId: string; updatedAt: string }>) {
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

    const { username, data } = req.body;
    if (!username || typeof username !== 'string' || !data || typeof data !== 'string') {
        return res.status(400).json({ error: 'username and data required' });
    }

    const accessToken = process.env.IAGON_ACCESS_TOKEN;
    const nodeId = process.env.IAGON_NODE_ID;

    if (!accessToken || !nodeId) {
        return res.status(503).json({ error: 'Iagon storage not configured on this server' });
    }

    const fileBuffer = Buffer.from(data, 'base64');
    const filename = `wallet-idl-${username.toLowerCase()}.enc`;

    // Build multipart form data manually using the Blob/FormData API (Node 18+)
    const formData = new FormData();
    formData.append('file', new Blob([fileBuffer], { type: 'application/octet-stream' }), filename);
    formData.append('node_id', nodeId);

    try {
        const response = await fetch(`${IAGON_BASE_URL}/storage/upload`, {
            method: 'POST',
            headers: { 'x-api-key': accessToken },
            body: formData,
        });

        if (!response.ok) {
            throw new Error(`Iagon responded with ${response.status}`);
        }

        const json = await response.json() as any;
        const fileId = json?.data?._id;
        if (!fileId) {
            return res.status(502).json({ error: 'Iagon did not return a file ID' });
        }

        // Update server-side registry: username → fileId
        const registry = loadRegistry();
        registry[username.toLowerCase()] = { fileId, updatedAt: new Date().toISOString() };
        saveRegistry(registry);

        return res.status(200).json({ success: true, fileId });
    } catch (err: any) {
        console.error('[wallet/upload] Iagon upload failed:', err.message);
        return res.status(502).json({ error: 'Failed to upload backup to Iagon' });
    }
}
