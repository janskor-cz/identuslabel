import type { NextApiRequest, NextApiResponse } from 'next';

// In-memory store — resets on server restart (fine; invitations are ephemeral)
const store = new Map<string, string>();

function randomToken(): string {
  return Math.random().toString(36).slice(2, 8); // 6-char alphanumeric
}

function buildShortUrl(req: NextApiRequest, token: string): string {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'identuslabel.cz';
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}/wallet/i/${token}`;
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'POST') {
    const { url } = req.body;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'Missing url' });
    }
    // Dedup: return existing token if this URL was already shortened
    for (const [token, stored] of store.entries()) {
      if (stored === url) return res.status(200).json({ token, shortUrl: buildShortUrl(req, token) });
    }
    let token = randomToken();
    while (store.has(token)) token = randomToken();
    store.set(token, url);
    return res.status(200).json({ token, shortUrl: buildShortUrl(req, token) });
  }

  if (req.method === 'GET') {
    const { token } = req.query;
    const url = store.get(token as string);
    if (!url) return res.status(404).json({ error: 'Not found' });
    return res.status(200).json({ url });
  }

  res.status(405).end();
}
