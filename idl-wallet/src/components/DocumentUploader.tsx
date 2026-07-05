/**
 * DocumentUploader — DIDComm-native document upload / branch component.
 *
 * Sends upload or branch requests to the Document Service via DIDComm.
 * The service responds with a VP proof request; after approval the service
 * creates the document DID and sends a completion message back.
 */

import React, { useState, useRef, useCallback } from 'react';
import SDK from '@hyperledger/identus-edge-agent-sdk';
import { useAppDispatch } from '@/reducers/store';
import { sendDocumentUploadRequest, sendDocumentBranchRequest } from '@/actions/index';

const CLEARANCE_LEVELS = ['INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'SECRET'];

interface Props {
    agent: SDK.Agent;
    connection: SDK.Domain.DIDPair;
    parentDocumentDID?: string;  // if set → branch mode
    onComplete?: (documentDID: string) => void;
    onClose?: () => void;
}

export const DocumentUploader: React.FC<Props> = ({ agent, connection, parentDocumentDID, onComplete, onClose }) => {
    const dispatch = useAppDispatch();
    const fileRef  = useRef<HTMLInputElement>(null);

    const [title, setTitle]             = useState('');
    const [clearance, setClearance]     = useState('INTERNAL');
    const [releasableTo, setReleasableTo] = useState('');
    const [file, setFile]               = useState<File | null>(null);
    const [status, setStatus]           = useState<'idle' | 'sending' | 'waiting' | 'done' | 'error'>('idle');
    const [error, setError]             = useState('');

    const isBranch = !!parentDocumentDID;

    const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const f = e.target.files?.[0] ?? null;
        setFile(f);
        if (f && !title) setTitle(f.name.replace(/\.[^.]+$/, ''));
    }, [title]);

    const handleSubmit = useCallback(async (e: React.FormEvent) => {
        e.preventDefault();
        if (!file) { setError('Please select a file.'); return; }
        if (!title.trim()) { setError('Title is required.'); return; }

        setStatus('sending');
        setError('');

        try {
            const fileBuffer = await file.arrayBuffer();
            const releasableDIDs = releasableTo.split(',').map(d => d.trim()).filter(d => d.startsWith('did:'));

            if (isBranch) {
                await dispatch(sendDocumentBranchRequest({
                    agent, connection,
                    parentDocumentDID: parentDocumentDID!,
                    title: title.trim(),
                    clearanceLevel: clearance,
                    releasableTo: releasableDIDs,
                    fileBuffer, filename: file.name, mimeType: file.type || 'application/octet-stream'
                })).unwrap();
            } else {
                await dispatch(sendDocumentUploadRequest({
                    agent, connection,
                    title: title.trim(),
                    clearanceLevel: clearance,
                    releasableTo: releasableDIDs,
                    fileBuffer, filename: file.name, mimeType: file.type || 'application/octet-stream'
                })).unwrap();
            }
            setStatus('waiting');
        } catch (err: any) {
            setStatus('error');
            setError(err?.message || 'Upload failed');
        }
    }, [file, title, clearance, releasableTo, agent, connection, isBranch, parentDocumentDID, dispatch]);

    return (
        <div className="bg-slate-800 rounded-lg p-6 max-w-lg w-full">
            <div className="flex items-center justify-between mb-4">
                <h2 className="text-white font-semibold text-lg">
                    {isBranch ? '🔀 Create Document Branch' : '📤 Upload Document'}
                </h2>
                {onClose && (
                    <button onClick={onClose} className="text-slate-400 hover:text-white">✕</button>
                )}
            </div>

            {isBranch && (
                <div className="mb-4 p-3 bg-slate-700 rounded text-xs text-slate-300 font-mono break-all">
                    Parent: {parentDocumentDID}
                </div>
            )}

            {status === 'waiting' && (
                <div className="text-center py-8">
                    <div className="text-amber-400 text-2xl mb-3">⏳</div>
                    <p className="text-white font-medium">Waiting for proof request…</p>
                    <p className="text-slate-400 text-sm mt-1">
                        The document service will send a credential proof request. Check your pending requests.
                    </p>
                </div>
            )}

            {status === 'done' && (
                <div className="text-center py-8">
                    <div className="text-green-400 text-2xl mb-3">✅</div>
                    <p className="text-white font-medium">Document published!</p>
                </div>
            )}

            {(status === 'idle' || status === 'error' || status === 'sending') && (
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                        <label className="block text-sm text-slate-300 mb-1">Title</label>
                        <input
                            type="text"
                            value={title}
                            onChange={e => setTitle(e.target.value)}
                            placeholder="Document title"
                            className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-white placeholder-slate-400 text-sm focus:outline-none focus:border-blue-500"
                            required
                        />
                    </div>

                    <div>
                        <label className="block text-sm text-slate-300 mb-1">Clearance Level</label>
                        <select
                            value={clearance}
                            onChange={e => setClearance(e.target.value)}
                            className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
                        >
                            {CLEARANCE_LEVELS.map(l => (
                                <option key={l} value={l}>{l}</option>
                            ))}
                        </select>
                    </div>

                    <div>
                        <label className="block text-sm text-slate-300 mb-1">Releasable To (comma-separated DIDs)</label>
                        <input
                            type="text"
                            value={releasableTo}
                            onChange={e => setReleasableTo(e.target.value)}
                            placeholder="did:prism:company1, did:prism:company2"
                            className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-white placeholder-slate-400 text-sm focus:outline-none focus:border-blue-500"
                        />
                    </div>

                    <div>
                        <label className="block text-sm text-slate-300 mb-1">File</label>
                        <input
                            ref={fileRef}
                            type="file"
                            onChange={handleFileChange}
                            className="w-full text-slate-300 text-sm file:mr-3 file:py-1 file:px-3 file:rounded file:border-0 file:bg-slate-600 file:text-white"
                        />
                        {file && (
                            <p className="text-xs text-slate-400 mt-1">{file.name} ({(file.size / 1024).toFixed(1)} KB)</p>
                        )}
                    </div>

                    {error && (
                        <p className="text-red-400 text-sm">{error}</p>
                    )}

                    <button
                        type="submit"
                        disabled={status === 'sending'}
                        className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-slate-600 text-white rounded py-2 text-sm font-medium transition-colors"
                    >
                        {status === 'sending' ? 'Sending…' : isBranch ? 'Create Branch' : 'Upload Document'}
                    </button>
                </form>
            )}
        </div>
    );
};

export default DocumentUploader;
