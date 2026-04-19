/**
 * DocumentDIDAccess.tsx
 *
 * Access a document directly by its PRISM DID.
 *
 * Flow (DIDComm two-step, server-initiated):
 *  1. User pastes a document DID
 *  2. Identity auto-detected from wallet (or selected via credential picker modal)
 *  3. POST /documents/:did/access-initiate { employeeId }
 *     → server sends DIDComm RequestPresentation to enterprise wallet (EmployeeRole)
 *       and personal wallet (SecurityClearance)
 *  4. User approves both presentation requests in their wallet(s)
 *  5. Client polls /documents/:did/access-status/:sessionId until 'authorized'
 *  6. POST /documents/:did/access-complete { sessionId, ephemeralPublicKey }
 *  7. Decrypt NaCl-boxed response → trigger file download
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import nacl from 'tweetnacl';
import { DocumentIcon, LockClosedIcon, UserCircleIcon, XIcon, CheckIcon, ShieldCheckIcon } from '@heroicons/react/solid';
import { getItem, setItem } from '@/utils/prefixedStorage';
import { storeDocument, StoredDocument } from '@/utils/documentStorage';
import { getCredentialType, getCredentialSubject } from '@/utils/credentialTypeDetector';
import { requestDocumentAccess } from '@/utils/KeyAuthorityClient';
import { SectionRenderer } from '@/components/SectionRenderer';

interface DocumentDIDAccessProps {
  credentials: any[];
  enterpriseDIDs?: string[];
  initialDID?: string;
  autoTrigger?: boolean;
  onDocumentSaved?: (ephemeralDID: string) => void;
}

type Phase =
  | 'idle'
  | 'initiating'
  | 'awaiting_wallet'
  | 'downloading'
  | 'decrypting'
  | 'done'
  | 'error';

// Metadata returned by KA for a rendered HTML document
interface RenderedDoc {
  sections: import('@/utils/sectionDecryptor').SectionResult[];
  documentTitle: string;
  overallClassification: string;
  userClearance: string;
}

const DOC_SERVICE_BASE = 'https://identuslabel.cz/document-service';

// Credential types that can serve as identity proof
const IDENTITY_TYPES = new Set([
  'CertificationAuthorityIdentity',
  'RealPersonIdentity',
  'SecurityClearance',
  'EmployeeRole',
]);

// Credential types eligible for VP presentation
const PRESENTABLE_TYPES = new Set(['EmployeeRole', 'SecurityClearance']);

/** Build a label for a credential in the picker */
function credentialPickerLabel(cred: any): { type: string; detail: string } {
  const type = getCredentialType(cred);
  const subject = getCredentialSubject(cred);
  let detail = '';
  if (type === 'EmployeeRole') {
    detail = subject?.email || subject?.employeeId || subject?.role || '';
  } else if (type === 'SecurityClearance') {
    detail = subject?.clearanceLevel || subject?.holderName || '';
  }
  return { type, detail };
}

/** Credential Picker Modal — user manually selects which VCs to present */
function CredentialPickerModal({
  credentials,
  onConfirm,
  onClose,
}: {
  credentials: any[];
  onConfirm: (selected: any[]) => void;
  onClose: () => void;
}) {
  const presentable = credentials.filter(c => PRESENTABLE_TYPES.has(getCredentialType(c)));
  const [checked, setChecked] = React.useState<Set<number>>(
    () => new Set(presentable.map((_, i) => i))  // pre-select all by default
  );

  const toggle = (i: number) =>
    setChecked(prev => { const s = new Set(prev); s.has(i) ? s.delete(i) : s.add(i); return s; });

  const handleConfirm = () => {
    const selected = presentable.filter((_, i) => checked.has(i));
    if (selected.length === 0) return;
    onConfirm(selected);
  };

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[10000] flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-slate-900 border border-slate-700/50 rounded-2xl p-5 max-w-md w-full mx-4 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <ShieldCheckIcon className="w-5 h-5 text-cyan-400" />
            <h2 className="text-base font-semibold text-white">Select Credentials to Present</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-slate-400 mb-4">
          Choose which credentials to include in your Verifiable Presentation.
          Only selected credentials will be sent to the document server.
        </p>

        {presentable.length === 0 ? (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 mb-4">
            <p className="text-xs text-amber-300">
              No EmployeeRole or SecurityClearance credentials found in wallet.
            </p>
          </div>
        ) : (
          <div className="space-y-2 mb-4">
            {presentable.map((cred, i) => {
              const { type, detail } = credentialPickerLabel(cred);
              const isChecked = checked.has(i);
              return (
                <button
                  key={i}
                  onClick={() => toggle(i)}
                  className={`w-full text-left p-3 rounded-xl border transition-all ${
                    isChecked
                      ? 'bg-cyan-500/20 border-cyan-500/50'
                      : 'bg-slate-800/50 border-slate-700/50 hover:border-slate-500/50'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                      isChecked ? 'bg-cyan-500 border-cyan-500' : 'border-slate-500'
                    }`}>
                      {isChecked && <CheckIcon className="w-3 h-3 text-white" />}
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-cyan-400">{type}</div>
                      {detail && <div className="text-xs text-slate-300 truncate">{detail}</div>}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 bg-slate-700/50 border border-slate-600 text-slate-300 text-sm rounded-xl hover:bg-slate-600/50 transition-all"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={checked.size === 0 || presentable.length === 0}
            className="flex-1 px-4 py-2 bg-cyan-500/20 border border-cyan-500/40 text-cyan-300 text-sm font-medium rounded-xl hover:bg-cyan-500/30 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            Present ({checked.size})
          </button>
        </div>
      </div>
    </div>
  );
}

function extractIdentityFromCredential(
  cred: any,
  personalFallbackDID?: string | null
): { label: string; value: string } | null {
  const type = getCredentialType(cred);
  const subject = getCredentialSubject(cred);
  if (!subject) return null;

  // Prefer email for EmployeeRole
  if (type === 'EmployeeRole' && subject.email) {
    return { label: `${subject.email} (EmployeeRole)`, value: subject.email };
  }

  // Extract subject DID (credentialSubject.id)
  const subjectId = subject.id || subject.did;
  if (subjectId && subjectId.startsWith('did:')) {
    const shortDID = subjectId.length > 50
      ? `${subjectId.slice(0, 22)}…${subjectId.slice(-16)}`
      : subjectId;
    return { label: `${shortDID} (${type})`, value: subjectId };
  }

  // Personal wallet credentials (SecurityClearance, RealPersonIdentity, etc.)
  // don't embed a DID in the subject — use the stored personal PRISM DID as value
  if (personalFallbackDID) {
    const name =
      subject.holderName ||
      (subject.firstName ? `${subject.firstName} ${subject.lastName || ''}`.trim() : null) ||
      subject.name ||
      type;
    const shortDID = personalFallbackDID.length > 50
      ? `${personalFallbackDID.slice(0, 22)}…${personalFallbackDID.slice(-16)}`
      : personalFallbackDID;
    return { label: `${name} · ${shortDID} (${type})`, value: personalFallbackDID };
  }

  return null;
}

/** Identity picker modal */
function IdentityPickerModal({
  credentials,
  enterpriseDIDs,
  storedDID,
  onSelect,
  onClose,
}: {
  credentials: any[];
  enterpriseDIDs: string[];
  storedDID: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string>(storedDID || '');
  const [manual, setManual] = useState('');

  // Build list of identity options
  const options: { label: string; value: string; type: string }[] = [];

  // Enterprise agent DIDs (highest priority — directly usable as employeeId)
  for (const did of enterpriseDIDs) {
    if (options.some(o => o.value === did)) continue;
    const short = did.length > 50 ? `${did.slice(0, 22)}…${did.slice(-16)}` : did;
    options.push({ label: short, value: did, type: 'Enterprise PRISM DID' });
  }

  // Stored personal wallet PRISM DID
  if (storedDID && !options.some(o => o.value === storedDID)) {
    const short = storedDID.length > 50
      ? `${storedDID.slice(0, 22)}…${storedDID.slice(-16)}`
      : storedDID;
    options.push({ label: short, value: storedDID, type: 'Personal PRISM DID' });
  }

  // DIDs extracted from credential subjects (pass storedDID as personal fallback)
  for (const cred of credentials) {
    const type = getCredentialType(cred);
    if (!IDENTITY_TYPES.has(type)) continue;
    const identity = extractIdentityFromCredential(cred, storedDID);
    if (!identity || options.some(o => o.value === identity.value)) continue;
    options.push({ label: identity.label, value: identity.value, type });
  }

  const handleConfirm = () => {
    const val = selected || manual.trim();
    if (val) onSelect(val);
  };

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[10000] flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-slate-900 border border-slate-700/50 rounded-2xl p-5 max-w-md w-full mx-4 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <UserCircleIcon className="w-5 h-5 text-cyan-400" />
            <h2 className="text-base font-semibold text-white">Select Your Identity</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-slate-400 mb-4">
          Your identity is used to find your enterprise wallet connection for credential verification.
        </p>

        {/* Credential options */}
        {options.length > 0 ? (
          <div className="space-y-2 mb-4">
            {options.map(opt => (
              <button
                key={opt.value}
                onClick={() => setSelected(opt.value)}
                className={`w-full text-left p-3 rounded-xl border transition-all ${
                  selected === opt.value
                    ? 'bg-cyan-500/20 border-cyan-500/50'
                    : 'bg-slate-800/50 border-slate-700/50 hover:border-slate-500/50'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <div className="text-xs text-cyan-400 font-medium mb-0.5">{opt.type}</div>
                    <div className="text-xs font-mono text-slate-300 truncate">{opt.label}</div>
                  </div>
                  {selected === opt.value && (
                    <CheckIcon className="w-4 h-4 text-cyan-400 flex-shrink-0 ml-2" />
                  )}
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 mb-4">
            <p className="text-xs text-amber-300">No identity credentials detected in wallet.</p>
          </div>
        )}

        {/* Manual fallback */}
        <div className="mb-4">
          <div className="text-xs text-slate-500 mb-1.5">Or enter manually:</div>
          <input
            type="text"
            value={manual}
            onChange={e => { setManual(e.target.value); setSelected(''); }}
            placeholder="enterprise email or did:prism:…"
            className="w-full text-xs font-mono bg-slate-800/50 border border-slate-600 rounded-lg px-3 py-2 text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
          />
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 bg-slate-700/50 border border-slate-600 text-slate-300 text-sm rounded-xl hover:bg-slate-600/50 transition-all"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!selected && !manual.trim()}
            className="flex-1 px-4 py-2 bg-cyan-500/20 border border-cyan-500/40 text-cyan-300 text-sm font-medium rounded-xl hover:bg-cyan-500/30 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            Use this identity
          </button>
        </div>
      </div>
    </div>
  );
}

export function DocumentDIDAccess({ credentials, enterpriseDIDs = [], initialDID, autoTrigger, onDocumentSaved }: DocumentDIDAccessProps) {
  const [did, setDid]                         = useState(initialDID || '');
  const [employeeId, setEmployeeId]           = useState<string | null>(null);
  const [showPicker, setShowPicker]           = useState(false);
  const [showCredPicker, setShowCredPicker]   = useState(false);
  const [phase, setPhase]                     = useState<Phase>('idle');
  const [status, setStatus]                   = useState('');
  const [renderedDoc, setRenderedDoc]         = useState<RenderedDoc | null>(null);
  const autoTriggeredRef                      = useRef(false);
  // Credentials the user manually selected for presentation
  const selectedCredsRef                      = useRef<any[] | null>(null);

  // Stored PRISM DID (from CA connection)
  const storedDIDRef = useRef<string | null>(null);

  // Always load personal PRISM DID into the ref (used by picker modal regardless of auto-detect winner)
  useEffect(() => {
    const prismDID = getItem('ca-connection-prism-did');
    if (prismDID) storedDIDRef.current = prismDID;
  }, []);

  // Auto-detect best default identity when enterprise DIDs load
  useEffect(() => {
    // 1. Enterprise PRISM DID (most authoritative — directly in employee DB)
    if (enterpriseDIDs.length > 0) {
      setEmployeeId(enterpriseDIDs[0]);
      return;
    }

    // 2. Stored personal PRISM DID (from CA connection flow)
    if (storedDIDRef.current) {
      setEmployeeId(storedDIDRef.current);
      return;
    }

    // 3. Extract from wallet credentials
    for (const cred of credentials) {
      const type = getCredentialType(cred);
      if (!IDENTITY_TYPES.has(type)) continue;
      const identity = extractIdentityFromCredential(cred);
      if (identity) {
        setEmployeeId(identity.value);
        return;
      }
    }
  }, [enterpriseDIDs, credentials]);

  // Refs to avoid stale closures in polling
  const sessionIdRef   = useRef<string | null>(null);
  const pollTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ephemeralKpRef = useRef<nacl.BoxKeyPair | null>(null);

  const stopPolling = () => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  const reset = useCallback(() => {
    stopPolling();
    sessionIdRef.current = null;
    if (ephemeralKpRef.current) {
      ephemeralKpRef.current.secretKey.fill(0);
      ephemeralKpRef.current = null;
    }
    setPhase('idle');
    setStatus('');
    setRenderedDoc(null);
    // employeeId intentionally preserved across resets
  }, []);

  /** Poll until authorized, then complete */
  const startPolling = useCallback((documentDID: string, sessionId: string) => {
    const poll = async () => {
      try {
        const r = await fetch(
          `${DOC_SERVICE_BASE}/documents/${encodeURIComponent(documentDID)}/access-status/${sessionId}`
        );
        const json = await r.json();

        if (!r.ok) throw new Error(json.message || json.error || 'Status error');

        if (json.status === 'denied') {
          throw new Error('Credential request was rejected');
        }

        if (json.status === 'authorized') {
          setPhase('downloading');
          setStatus('Credentials verified — downloading document…');

          const kp  = ephemeralKpRef.current!;
          const pub = Buffer.from(kp.publicKey).toString('base64');

          const completeRes = await fetch(
            `${DOC_SERVICE_BASE}/documents/${encodeURIComponent(documentDID)}/access-complete`,
            {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify({ sessionId, ephemeralPublicKey: pub })
            }
          );
          const completeJson = await completeRes.json();
          if (!completeRes.ok || !completeJson.success) {
            throw new Error(completeJson.message || completeJson.error || 'Access denied');
          }

          setPhase('decrypting');
          setStatus('Decrypting…');

          const { ciphertext, nonce: encNonce, senderPublicKey } = completeJson.encryptedDocument;
          const decrypted = nacl.box.open(
            new Uint8Array(Buffer.from(ciphertext,      'base64')),
            new Uint8Array(Buffer.from(encNonce,        'base64')),
            new Uint8Array(Buffer.from(senderPublicKey, 'base64')),
            kp.secretKey
          );
          kp.secretKey.fill(0); // PFS
          ephemeralKpRef.current = null;

          if (!decrypted) throw new Error('Decryption failed');

          const filename = completeJson.filename || 'document';
          const mime     = completeJson.mimeType  || 'application/octet-stream';
          const blob     = new Blob([decrypted as unknown as BlobPart], { type: mime });
          const url      = URL.createObjectURL(blob);
          const a        = document.createElement('a');
          a.href = url; a.download = filename;
          document.body.appendChild(a); a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);

          setPhase('done');
          setStatus(`Downloaded "${filename}"  ·  copyId: ${completeJson.copyId}`);
          return;
        }

        // Still waiting — poll again in 2 s
        pollTimerRef.current = setTimeout(poll, 2000);

      } catch (err: any) {
        console.error('[DocumentDIDAccess] poll error:', err);
        setPhase('error');
        setStatus(err.message || 'Unknown error');
      }
    };

    pollTimerRef.current = setTimeout(poll, 2000);
  }, []);

  const handleAccess = useCallback(async (overrideId?: string, overrideCreds?: any[]) => {
    const documentDID = did.trim();
    const empId       = (overrideId || employeeId || '').trim();

    if (!documentDID.startsWith('did:')) {
      setStatus('Enter a valid document DID (must start with did:)');
      setPhase('error');
      return;
    }

    // If no identity detected yet, open the identity picker
    if (!empId) {
      setShowPicker(true);
      return;
    }

    // Auto-select all presentable credentials; only show picker if none available
    if (!overrideCreds) {
      const auto = credentials.filter(c => PRESENTABLE_TYPES.has(getCredentialType(c)));
      if (auto.length > 0) {
        handleAccess(overrideId, auto);
        return;
      }
      setShowCredPicker(true);
      return;
    }

    reset();
    setPhase('initiating');
    setStatus('Requesting document access from Key Authority…');

    try {
      const kp = nacl.box.keyPair();
      ephemeralKpRef.current = kp;

      // ── Access-gate flow: challenge → VP presentation ─────────────────────────
      const accessResponse = await requestDocumentAccess(documentDID, overrideCreds, kp);

      setPhase('decrypting');
      const { ciphertext, nonce, serverPublicKey, filename, mimeType } = accessResponse.encryptedDocument;
      setStatus(`Decrypting document…`);

      const decrypted = nacl.box.open(
        new Uint8Array(Buffer.from(ciphertext,      'base64')),
        new Uint8Array(Buffer.from(nonce,           'base64')),
        new Uint8Array(Buffer.from(serverPublicKey, 'base64')),
        kp.secretKey
      );

      // PFS
      kp.secretKey.fill(0);
      ephemeralKpRef.current = null;

      if (!decrypted) throw new Error('Decryption failed — wrong key or corrupted data');

      const isDocx = mimeType.includes('wordprocessingml') || filename?.endsWith('.docx');
      const docTitle = accessResponse.documentMetadata?.title || filename || 'Document';
      const docClassification = accessResponse.documentMetadata?.overallClassification ||
        accessResponse.encryptedDocument.classificationLevel || 'UNCLASSIFIED';
      const userClearance = accessResponse.clearanceLevel || 'INTERNAL';

      // ── Store in "My Documents" ───────────────────────────────────────────────
      try {
        const localKP  = nacl.box.keyPair();
        const senderKP = nacl.box.keyPair();
        const localNonce = nacl.randomBytes(nacl.box.nonceLength);
        const reEncrypted = nacl.box(
          decrypted as Uint8Array,
          localNonce,
          localKP.publicKey,
          senderKP.secretKey
        );
        const secretKeyB64  = Buffer.from(localKP.secretKey).toString('base64');
        const senderPubB64  = Buffer.from(senderKP.publicKey).toString('base64');
        const nonceB64      = Buffer.from(localNonce).toString('base64');
        localKP.secretKey.fill(0);
        senderKP.secretKey.fill(0);

        setItem(`ephemeral-key-${did}`, { secretKey: secretKeyB64, ephemeralDID: did });

        const storedDoc: StoredDocument = {
          ephemeralDID: did,
          originalDocumentDID: did,
          title: docTitle,
          overallClassification: docClassification,
          encryptedContent: reEncrypted.buffer.slice(
            reEncrypted.byteOffset,
            reEncrypted.byteOffset + reEncrypted.byteLength
          ) as ArrayBuffer,
          encryptionInfo: { serverPublicKey: senderPubB64, nonce: nonceB64, algorithm: 'X25519-XSalsa20-Poly1305' },
          sectionSummary: {
            totalSections: 1, visibleCount: 1, redactedCount: 0,
            clearanceLevelsUsed: [userClearance],
            visibleSections: [{ sectionId: 'full', clearance: userClearance }],
            redactedSections: []
          },
          sourceInfo: { filename, format: isDocx ? 'docx' : 'html' },
          receivedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          viewCount: 0,
          maxViews: -1,
          status: 'active'
        };
        await storeDocument(storedDoc);
        onDocumentSaved?.(did);
      } catch (storeErr: any) {
        console.warn('[DocumentDIDAccess] Could not save to My Documents:', storeErr.message);
        onDocumentSaved?.(did);
      }

      setPhase('done');
      setStatus(`"${docTitle}" — opening in viewer…`);

    } catch (err: any) {
      console.error('[DocumentDIDAccess]', err);
      setPhase('error');
      setStatus(err.message || 'Unknown error');
    }
  }, [did, employeeId, reset, startPolling]);

  const handleIdentitySelected = useCallback((id: string) => {
    setEmployeeId(id);
    setShowPicker(false);
    // After identity picked, show credential picker next
    setShowCredPicker(true);
  }, []);

  const handleCredsSelected = useCallback((selected: any[]) => {
    selectedCredsRef.current = selected;
    setShowCredPicker(false);
    handleAccess(employeeId || undefined, selected);
  }, [handleAccess, employeeId]);

  // Auto-trigger KA flow when initialDID + autoTrigger are set and identity is ready
  useEffect(() => {
    if (!autoTrigger || !initialDID || autoTriggeredRef.current) return;
    if (!employeeId) return; // wait for identity detection
    autoTriggeredRef.current = true;
    handleAccess();
  }, [autoTrigger, initialDID, employeeId, handleAccess]);

  const busy = phase === 'initiating' || phase === 'awaiting_wallet' ||
               phase === 'downloading' || phase === 'decrypting';

  // Short display for detected identity
  const identityDisplay = employeeId
    ? (employeeId.length > 44
        ? `${employeeId.slice(0, 20)}…${employeeId.slice(-14)}`
        : employeeId)
    : null;

  return (
    <>
      {showPicker && (
        <IdentityPickerModal
          credentials={credentials}
          enterpriseDIDs={enterpriseDIDs}
          storedDID={storedDIDRef.current}
          onSelect={handleIdentitySelected}
          onClose={() => setShowPicker(false)}
        />
      )}
      {showCredPicker && (
        <CredentialPickerModal
          credentials={credentials}
          onConfirm={handleCredsSelected}
          onClose={() => setShowCredPicker(false)}
        />
      )}

      <div className="mb-6 p-4 bg-slate-800/30 rounded-2xl border border-cyan-500/30 backdrop-blur-sm">
        <div className="flex items-center gap-2 mb-3">
          <LockClosedIcon className="w-4 h-4 text-cyan-400" />
          <span className="text-sm font-semibold text-white">Access Document by DID</span>
          <span className="text-xs text-slate-400">— paste a PRISM document DID to download directly</span>
        </div>

        {/* Document DID + Download row */}
        <div className="flex gap-2 mb-2">
          <input
            type="text"
            value={did}
            onChange={e => { setDid(e.target.value); if (phase !== 'idle') reset(); }}
            placeholder="did:prism:… (document DID)"
            disabled={busy}
            className="flex-1 text-xs font-mono bg-slate-900/50 border border-slate-600 rounded-lg px-3 py-2 text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 disabled:opacity-50"
          />
          <button
            onClick={() => handleAccess()}
            disabled={busy || !did.trim()}
            className="flex items-center gap-1.5 px-4 py-2 bg-cyan-500/20 border border-cyan-500/40 text-cyan-300 text-sm font-medium rounded-lg hover:bg-cyan-500/30 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap transition-all"
          >
            <DocumentIcon className="w-4 h-4" />
            {busy ? 'Working…' : 'Download'}
          </button>
          {(phase === 'done' || phase === 'error') && (
            <button
              onClick={reset}
              className="px-3 py-2 bg-slate-700/50 border border-slate-600 text-slate-300 text-sm rounded-lg hover:bg-slate-600/50 transition-all"
            >
              Reset
            </button>
          )}
        </div>

        {/* Identity pill */}
        <div className="flex items-center gap-2">
          <UserCircleIcon className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
          {identityDisplay ? (
            <span className="text-xs text-slate-400">
              Identity:{' '}
              <span className="font-mono text-slate-300">{identityDisplay}</span>
              {!busy && (
                <button
                  onClick={() => setShowPicker(true)}
                  className="ml-2 text-cyan-500 hover:text-cyan-300 underline"
                >
                  change
                </button>
              )}
            </span>
          ) : (
            <button
              onClick={() => setShowPicker(true)}
              className="text-xs text-amber-400 hover:text-amber-300 underline"
            >
              Select identity…
            </button>
          )}
        </div>

        {phase === 'awaiting_wallet' && (
          <div className="mt-2 p-2 bg-amber-500/10 border border-amber-500/30 rounded-lg">
            <p className="text-xs text-amber-300 font-medium">
              ⚠ Check your enterprise wallet — approve the incoming credential request there.
            </p>
          </div>
        )}

        {status && (
          <p className={`mt-2 text-xs font-medium ${
            phase === 'error'           ? 'text-red-400' :
            phase === 'done'            ? 'text-emerald-400' :
            phase === 'awaiting_wallet' ? 'text-amber-300' :
            'text-cyan-300'
          }`}>
            {status}
          </p>
        )}
      </div>

      {/* Inline document viewer — shown after client-side decryption */}
      {renderedDoc && (
        <div className="mt-4">
          <SectionRenderer
            sections={renderedDoc.sections}
            documentTitle={renderedDoc.documentTitle}
            overallClassification={renderedDoc.overallClassification}
            userClearance={renderedDoc.userClearance}
          />
        </div>
      )}
    </>
  );
}

export default DocumentDIDAccess;
