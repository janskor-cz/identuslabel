import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs';
import path from 'path';

const REGISTRY_PATH = path.join(process.cwd(), 'data', 'wallet-registry.json');

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

export default function handler(req: NextApiRequest, res: NextApiResponse) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { username } = req.body;
    if (!username || typeof username !== 'string') {
        return res.status(400).json({ error: 'username required' });
    }

    const registry = loadRegistry();
    const entry = registry[username.toLowerCase()];

    if (entry) {
        return res.status(200).json({ exists: true, fileId: entry.fileId, updatedAt: entry.updatedAt });
    }

    return res.status(200).json({ exists: false });
}
