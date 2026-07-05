/**
 * DocumentAccessRequestor — DIDComm-native document access component.
 *
 * Flow:
 *   1. Send a service-access/1.0/request (capability: "document-access") to the Document
 *      Service connection — see packages/service-access-didcomm/PROTOCOL.md
 *   2. Service sends VP proof request (handled by existing proof request flow)
 *   3. After VP approval, service sends a service-access/1.0/grant (mode: "payload") whose
 *      `result` carries the DEK + Iagon link
 *   4. This component watches messages for the grant, downloads from Iagon, decrypts, renders
 *
 * The grant's `result`:
 *   { documentDID, deliveryId, iagonDownloadUrl, sections: [{ id, dek, fileIv, fileAuthTag, contentHash }] }
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import SDK from '@hyperledger/identus-edge-agent-sdk';
import { useAppDispatch, useMountedApp } from '@/reducers/store';
import { sendDocumentAccessRequest } from '@/actions/index';
import { parseServiceAccessGrant, isTrustedGrantSender, ServiceAccessGrant } from '@/utils/serviceAccessGrant';

interface DocumentAccessGrant extends ServiceAccessGrant {
    result: { documentDID: string; deliveryId: string; iagonDownloadUrl: string; filename?: string; sections: any[] };
}

interface Props {
    agent: SDK.Agent;
    connection: SDK.Domain.DIDPair;
    documentDID: string;
    onClose?: () => void;
}

type Status = 'idle' | 'requesting' | 'waiting_proof' | 'waiting_grant' | 'downloading' | 'done' | 'error';

// Find a trusted, matching grant in the messages array. Trust-checked against the message's
// actual sender DID (not merely "did a document-access/1.0/grant-shaped message arrive") —
// mirrors GlobalGrantWatcher / Chat.tsx's getTrustedGrant.
function extractGrant(
    messages: SDK.Domain.Message[],
    connection: SDK.Domain.DIDPair,
    documentDID: string
): DocumentAccessGrant | null {
    for (const msg of messages) {
        const parsed = parseServiceAccessGrant(msg);
        if (!parsed || parsed.mode !== 'payload' || parsed.capability !== 'document-access') continue;
        const result = parsed.result as any;
        if (result?.documentDID !== documentDID) continue;

        const { trusted } = isTrustedGrantSender(msg, [connection], 'document-access');
        if (!trusted) {
            console.warn('[DocumentAccessRequestor] Ignoring document-access grant from untrusted sender');
            continue;
        }
        return parsed as any;
    }
    return null;
}

async function decryptAESGCM(
    ciphertextBase64: string,
    dekBase64: string,
    ivBase64: string,
    authTagBase64: string
): Promise<ArrayBuffer> {
    const keyBytes  = Uint8Array.from(atob(dekBase64), c => c.charCodeAt(0));
    const iv        = Uint8Array.from(atob(ivBase64),  c => c.charCodeAt(0));
    const ciphertext= Uint8Array.from(atob(ciphertextBase64), c => c.charCodeAt(0));
    const authTag   = Uint8Array.from(atob(authTagBase64),    c => c.charCodeAt(0));

    // AES-GCM: ciphertext + authTag concatenated
    const ciphertextWithTag = new Uint8Array(ciphertext.length + authTag.length);
    ciphertextWithTag.set(ciphertext);
    ciphertextWithTag.set(authTag, ciphertext.length);

    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertextWithTag);
}

export const DocumentAccessRequestor: React.FC<Props> = ({ agent, connection, documentDID, onClose }) => {
    const dispatch   = useAppDispatch();
    const app        = useMountedApp();
    const seenGrants = useRef<Set<string>>(new Set());

    const [status, setStatus]     = useState<Status>('idle');
    const [error, setError]       = useState('');
    const [requestId, setRequestId] = useState<string | null>(null);
    const [decryptedBlob, setDecryptedBlob] = useState<{ url: string; mimeType: string; filename: string } | null>(null);

    // Watch for grant messages
    useEffect(() => {
        if (status !== 'waiting_grant' && status !== 'waiting_proof') return;
        const grant = extractGrant((app.messages ?? []) as SDK.Domain.Message[], connection, documentDID);
        if (!grant) return;

        const grantId = grant.id || grant.result?.deliveryId;
        if (seenGrants.current.has(grantId)) return;
        seenGrants.current.add(grantId);

        processGrant(grant);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [app.messages, status, documentDID, requestId]);

    const processGrant = useCallback(async (grant: DocumentAccessGrant) => {
        setStatus('downloading');
        try {
            const section = grant.result?.sections?.[0];
            const iagonUrl = grant.result?.iagonDownloadUrl;
            if (!section || !iagonUrl) throw new Error('Malformed grant message');

            // Download encrypted blob from Iagon
            const blobRes = await fetch(iagonUrl);
            if (!blobRes.ok) throw new Error(`Iagon download failed: HTTP ${blobRes.status}`);
            const ciphertextBuf = await blobRes.arrayBuffer();

            // Decrypt with DEK from grant message
            const { dek, fileIv, fileAuthTag, contentHash } = section;
            if (!dek || !fileIv || !fileAuthTag) throw new Error('Missing DEK or IV in grant');

            const ciphertextBase64 = btoa(String.fromCharCode(...new Uint8Array(ciphertextBuf)));
            const plaintext = await decryptAESGCM(ciphertextBase64, dek, fileIv, fileAuthTag);

            // Optional content hash verification
            if (contentHash) {
                const hashBuf = await crypto.subtle.digest('SHA-256', plaintext);
                const hashHex = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
                const expected = contentHash.replace(/^sha256:/, '');
                if (hashHex !== expected) {
                    throw new Error('Content hash mismatch — document may have been tampered with');
                }
            }

            // Create object URL for display
            const mimeType = section.mimeType || 'application/octet-stream';
            const blob     = new Blob([plaintext], { type: mimeType });
            const url      = URL.createObjectURL(blob);

            setDecryptedBlob({ url, mimeType, filename: grant.result.filename || 'document' });
            setStatus('done');
        } catch (err: any) {
            console.error('[DocumentAccessRequestor] Grant processing failed:', err);
            setStatus('error');
            setError(err.message || 'Failed to process document grant');
        }
    }, []);

    const handleRequest = useCallback(async () => {
        setStatus('requesting');
        setError('');
        try {
            const rid = `dar-${Date.now().toString(36)}`;
            setRequestId(rid);
            await dispatch(sendDocumentAccessRequest({ agent, connection, documentDID })).unwrap();
            setStatus('waiting_proof');
        } catch (err: any) {
            setStatus('error');
            setError(err.message || 'Failed to send access request');
        }
    }, [agent, connection, documentDID, dispatch]);

    return (
        <div className="bg-slate-800 rounded-lg p-6 max-w-lg w-full">
            <div className="flex items-center justify-between mb-4">
                <h2 className="text-white font-semibold text-lg">🔐 Document Access</h2>
                {onClose && (
                    <button onClick={onClose} className="text-slate-400 hover:text-white">✕</button>
                )}
            </div>

            <div className="mb-4 p-3 bg-slate-700 rounded text-xs text-slate-300 font-mono break-all">
                {documentDID}
            </div>

            {status === 'idle' && (
                <button
                    onClick={handleRequest}
                    className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded py-2 text-sm font-medium transition-colors"
                >
                    Request Access via DIDComm
                </button>
            )}

            {status === 'requesting' && (
                <p className="text-slate-300 text-sm text-center py-4">Sending access request…</p>
            )}

            {status === 'waiting_proof' && (
                <div className="text-center py-6">
                    <div className="text-amber-400 text-2xl mb-3">🔏</div>
                    <p className="text-white font-medium">Credential proof requested</p>
                    <p className="text-slate-400 text-sm mt-1">
                        Select your EmployeeRole credential in the pending requests tab to prove access.
                    </p>
                </div>
            )}

            {status === 'waiting_grant' && (
                <div className="text-center py-6">
                    <div className="text-blue-400 text-2xl mb-3">⏳</div>
                    <p className="text-white font-medium">Waiting for access grant…</p>
                </div>
            )}

            {status === 'downloading' && (
                <div className="text-center py-6">
                    <div className="text-blue-400 text-2xl mb-3">⬇️</div>
                    <p className="text-white font-medium">Downloading and decrypting…</p>
                </div>
            )}

            {status === 'done' && decryptedBlob && (
                <div className="space-y-3">
                    <div className="text-center">
                        <div className="text-green-400 text-2xl mb-2">✅</div>
                        <p className="text-white font-medium">Document decrypted successfully</p>
                    </div>
                    <a
                        href={decryptedBlob.url}
                        download={decryptedBlob.filename}
                        className="block w-full text-center bg-green-600 hover:bg-green-700 text-white rounded py-2 text-sm font-medium transition-colors"
                    >
                        ⬇️ Download {decryptedBlob.filename}
                    </a>
                    {decryptedBlob.mimeType.startsWith('image/') && (
                        <img src={decryptedBlob.url} alt={decryptedBlob.filename} className="w-full rounded" />
                    )}
                    {decryptedBlob.mimeType === 'application/pdf' && (
                        <iframe src={decryptedBlob.url} className="w-full h-96 rounded" title={decryptedBlob.filename} />
                    )}
                    {decryptedBlob.mimeType.startsWith('text/') && (
                        <iframe src={decryptedBlob.url} className="w-full h-64 rounded bg-white" title={decryptedBlob.filename} />
                    )}
                </div>
            )}

            {status === 'error' && (
                <div className="space-y-3">
                    <div className="text-center">
                        <div className="text-red-400 text-2xl mb-2">❌</div>
                        <p className="text-red-400 text-sm">{error}</p>
                    </div>
                    <button
                        onClick={() => { setStatus('idle'); setError(''); }}
                        className="w-full bg-slate-600 hover:bg-slate-500 text-white rounded py-2 text-sm"
                    >
                        Try Again
                    </button>
                </div>
            )}
        </div>
    );
};

export default DocumentAccessRequestor;
