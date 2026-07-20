/**
 * CredentialIssuanceRequestor — DIDComm-native credential issuance component.
 *
 * Flow (see packages/credential-issuance-didcomm/PROTOCOL.md):
 *   1. Send a credential-issuance/1.0/request (given `capability`) to the connection.
 *   2. Service replies with fields-required — the exact VC schema name/version and the field
 *      list to fill in. This component renders the form purely from that declaration; it has no
 *      hardcoded knowledge of any particular VC type's fields.
 *   3. User fills the form, submits a data-submit with the values.
 *   4. Success is NOT signaled back on this protocol — it's the native Issue-Credential-protocol
 *      credential offer the service sends as a side effect, already handled globally by
 *      CredentialOfferModal. This component just confirms the submission went out and watches
 *      for a credential-issuance/1.0/error to surface validation/issuance failures instead.
 */

import React, { useState, useEffect, useCallback } from 'react';
import SDK from '@hyperledger/identus-edge-agent-sdk';
import { useAppDispatch, useMountedApp } from '@/reducers/store';
import { sendCredentialIssuanceRequest, sendCredentialIssuanceData } from '@/actions/index';

const FIELDS_REQUIRED_TYPE = 'https://identuslabel.cz/protocols/credential-issuance/1.0/fields-required';
const ISSUANCE_ERROR_TYPE = 'https://identuslabel.cz/protocols/credential-issuance/1.0/error';

interface IssuanceField {
    key: string;
    label: string;
    type: string; // open, additive set — unrecognized types fall back to a text input
    required: boolean;
}

interface Props {
    agent: SDK.Agent;
    connection: SDK.Domain.DIDPair;
    capability: string;
    onClose?: () => void;
}

type Status = 'idle' | 'requesting' | 'awaiting_fields' | 'form' | 'submitting' | 'waiting_offer' | 'error';

function parseEnvelope(message: SDK.Domain.Message, type: string): any | null {
    try {
        const body = typeof message.body === 'string' ? JSON.parse(message.body) : message.body;
        const raw = (body as any)?.content ?? '';
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed?.type !== type) return null;
        return parsed;
    } catch {
        return null;
    }
}

export const CredentialIssuanceRequestor: React.FC<Props> = ({ agent, connection, capability, onClose }) => {
    const dispatch = useAppDispatch();
    const app = useMountedApp();

    const [status, setStatus] = useState<Status>('idle');
    const [error, setError] = useState('');
    const [requestId, setRequestId] = useState<string | null>(null);
    const [schemaName, setSchemaName] = useState('');
    const [schemaVersion, setSchemaVersion] = useState('');
    const [fields, setFields] = useState<IssuanceField[]>([]);
    const [values, setValues] = useState<Record<string, string>>({});

    // Watch for fields-required (while awaiting_fields) or error (while awaiting_fields or
    // waiting_offer) — both keyed by thid === requestId and sent from the connection we asked.
    useEffect(() => {
        if (status !== 'awaiting_fields' && status !== 'waiting_offer') return;
        if (!requestId) return;
        const senderDID = connection.receiver.toString();

        for (const msg of (app.messages ?? []) as SDK.Domain.Message[]) {
            if (msg.from?.toString() !== senderDID) continue;

            if (status === 'awaiting_fields') {
                const fr = parseEnvelope(msg, FIELDS_REQUIRED_TYPE);
                if (fr && fr.thid === requestId) {
                    setSchemaName(fr.body?.schemaName || '');
                    setSchemaVersion(fr.body?.schemaVersion || '');
                    setFields(Array.isArray(fr.body?.fields) ? fr.body.fields : []);
                    setStatus('form');
                    return;
                }
            }

            const err = parseEnvelope(msg, ISSUANCE_ERROR_TYPE);
            if (err && err.thid === requestId) {
                setError(err.body?.message || err.body?.error || 'Issuance failed.');
                setStatus('error');
                return;
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [app.messages, status, requestId, connection]);

    const handleRequest = useCallback(async () => {
        setStatus('requesting');
        setError('');
        try {
            const rid = await dispatch(sendCredentialIssuanceRequest({ agent, connection, capability })).unwrap();
            setRequestId(rid);
            setStatus('awaiting_fields');
        } catch (err: any) {
            setStatus('error');
            setError(err.message || 'Failed to send issuance request');
        }
    }, [agent, connection, capability, dispatch]);

    const handleFieldChange = (key: string, value: string) => {
        setValues(prev => ({ ...prev, [key]: value }));
    };

    const handleSubmit = useCallback(async () => {
        if (!requestId) return;
        setStatus('submitting');
        setError('');
        try {
            await dispatch(sendCredentialIssuanceData({ agent, connection, capability, requestId, values })).unwrap();
            setStatus('waiting_offer');
        } catch (err: any) {
            setStatus('error');
            setError(err.message || 'Failed to submit data');
        }
    }, [agent, connection, capability, requestId, values, dispatch]);

    const missingRequired = fields.some(f => f.required && !values[f.key]?.trim());

    return (
        <div className="bg-slate-800 rounded-lg p-6 max-w-lg w-full">
            <div className="flex items-center justify-between mb-4">
                <h2 className="text-white font-semibold text-lg">🪪 Request Credential</h2>
                {onClose && (
                    <button onClick={onClose} className="text-slate-400 hover:text-white">✕</button>
                )}
            </div>

            {status === 'idle' && (
                <button
                    onClick={handleRequest}
                    className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded py-2 text-sm font-medium transition-colors"
                >
                    Request via DIDComm
                </button>
            )}

            {status === 'requesting' && (
                <p className="text-slate-300 text-sm text-center py-4">Sending request…</p>
            )}

            {status === 'awaiting_fields' && (
                <div className="text-center py-6">
                    <div className="text-blue-400 text-2xl mb-3">⏳</div>
                    <p className="text-white font-medium">Waiting to hear which fields are needed…</p>
                </div>
            )}

            {status === 'form' && (
                <div className="space-y-4">
                    {schemaName && (
                        <div className="text-xs text-slate-400">
                            You're applying for a {schemaName}{schemaVersion ? ` v${schemaVersion}` : ''} credential.
                        </div>
                    )}
                    {fields.map(f => (
                        <div key={f.key}>
                            <label className="block text-xs text-slate-300 mb-1">
                                {f.label}{f.required ? ' *' : ''}
                            </label>
                            <input
                                type={f.type === 'date' ? 'date' : 'text'}
                                value={values[f.key] || ''}
                                onChange={e => handleFieldChange(f.key, e.target.value)}
                                className="w-full bg-slate-700 text-white rounded px-3 py-2 text-sm border border-slate-600 focus:border-blue-500 focus:outline-none"
                            />
                        </div>
                    ))}
                    <button
                        onClick={handleSubmit}
                        disabled={fields.length === 0 || missingRequired}
                        className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-slate-600 disabled:cursor-not-allowed text-white rounded py-2 text-sm font-medium transition-colors"
                    >
                        Submit
                    </button>
                </div>
            )}

            {status === 'submitting' && (
                <p className="text-slate-300 text-sm text-center py-4">Submitting…</p>
            )}

            {status === 'waiting_offer' && (
                <div className="text-center py-6">
                    <div className="text-green-400 text-2xl mb-3">✅</div>
                    <p className="text-white font-medium">Submitted</p>
                    <p className="text-slate-400 text-sm mt-1">
                        Check your pending credential offers for the issued credential.
                    </p>
                </div>
            )}

            {status === 'error' && (
                <div className="space-y-3">
                    <div className="text-center">
                        <div className="text-red-400 text-2xl mb-2">❌</div>
                        <p className="text-red-400 text-sm">{error}</p>
                    </div>
                    <button
                        onClick={() => { setStatus('idle'); setError(''); setRequestId(null); setFields([]); setValues({}); }}
                        className="w-full bg-slate-600 hover:bg-slate-500 text-white rounded py-2 text-sm"
                    >
                        Try Again
                    </button>
                </div>
            )}
        </div>
    );
};

export default CredentialIssuanceRequestor;
