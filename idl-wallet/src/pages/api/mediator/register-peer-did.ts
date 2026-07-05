import type { NextApiRequest, NextApiResponse } from 'next';
import { MongoClient } from 'mongodb';

// Direct MongoDB fallback for mediator keylist registration.
// The Identus mediator (fmgp/did-framework) has a ZIO fiber bug: when hostDID
// has no service endpoint (SW10 = empty services), keylist-update responses
// can't be delivered, causing the DB write to be rolled back — even though
// the mediator returns HTTP 200 and the SDK believes registration succeeded.
//
// IMPORTANT: mediationHandler.mediator?.hostDID is NOT the account's `did` field.
// It is itself a peer DID registered as an ALIAS inside the account. We must
// find accounts via alias lookup, not via did lookup.

const MONGO_URI = 'mongodb://admin:admin@127.0.0.1:27017/mediator?authSource=admin';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { peerDid, existingPeerDids = [] } = req.body;

    if (!peerDid || typeof peerDid !== 'string') {
        return res.status(400).json({ error: 'peerDid is required' });
    }
    if (!peerDid.startsWith('did:peer:')) {
        return res.status(400).json({ error: 'Invalid DID format' });
    }

    let client: MongoClient | null = null;
    try {
        client = new MongoClient(MONGO_URI);
        await client.connect();
        const accounts = client.db('mediator').collection('user.account');

        // Step 1: Check if peerDid is already registered in ANY account.
        // If yes, the SDK's internal registration worked — nothing to do.
        const alreadyIn = await accounts.findOne({ alias: peerDid });
        if (alreadyIn) {
            console.log(`[mediator/register-peer-did] Already registered: ${peerDid.substring(0, 50)}... in account ${alreadyIn.did.substring(0, 40)}...`);
            return res.status(200).json({
                success: true,
                alreadyRegistered: true,
                accountDid: alreadyIn.did,
            });
        }

        // Step 2: peerDid not registered. Find the correct account by searching
        // for the wallet's OTHER known peer DIDs in alias arrays.
        let targetAccount: any = null;
        if (Array.isArray(existingPeerDids) && existingPeerDids.length > 0) {
            targetAccount = await accounts.findOne({ alias: { $in: existingPeerDids } });
        }

        if (targetAccount) {
            await accounts.updateOne(
                { _id: targetAccount._id },
                { $addToSet: { alias: peerDid } }
            );
            console.log(`[mediator/register-peer-did] Added ${peerDid.substring(0, 50)}... to account ${targetAccount.did.substring(0, 40)}...`);
            return res.status(200).json({
                success: true,
                wasAdded: true,
                accountDid: targetAccount.did,
            });
        }

        // Step 3: Cannot identify account. Do NOT upsert — a blindly created
        // account won't be known to the mediator's pickup protocol.
        console.warn(`[mediator/register-peer-did] No account found for peerDid=${peerDid.substring(0, 50)}... existingPeerDids count=${existingPeerDids.length}`);
        return res.status(404).json({
            error: 'Could not identify mediator account for this wallet. Mediation may need to be re-established.',
        });

    } catch (err: any) {
        console.error('[mediator/register-peer-did] Error:', err.message);
        return res.status(500).json({ error: err.message });
    } finally {
        if (client) await client.close();
    }
}
