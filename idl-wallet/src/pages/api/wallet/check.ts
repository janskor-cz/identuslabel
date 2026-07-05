import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs';
import path from 'path';

const REGISTRY_PATH = path.join(process.cwd(), 'data', 'wallet-registry.json');

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
        // ignore read/parse errors
    }
    return { wallets: {} };
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { credHash } = req.body;
    if (!credHash || typeof credHash !== 'string' || !/^[0-9a-f]{64}$/.test(credHash)) {
        return res.status(400).json({ error: 'credHash required (64-char hex)' });
    }

    const registry = loadRegistry();
    const entry = registry.wallets[credHash];

    if (entry) {
        return res.status(200).json({
            exists: true,
            fileId: entry.fileId,
            contentHash: entry.contentHash,
            updatedAt: entry.updatedAt,
        });
    }

    return res.status(200).json({ exists: false });
}
