# IDL Wallet

Primary SSI wallet for the Identus Label platform. Runs at `https://identuslabel.cz/wallet` (port 3002, Caddy reverse proxy).

## Running the server

The wallet runs as a **production build** (`next start`), not in dev mode. After any source change:

```bash
cd /opt/project_identuslabel/idl-wallet
yarn build
kill $(lsof -ti :3002) 2>/dev/null; sleep 1
nohup node_modules/.bin/next start --port 3002 --hostname 0.0.0.0 > /opt/project_identuslabel/idl-wallet.log 2>&1 &
```

Hard-refreshing the browser (`Ctrl+Shift+R`) alone is not enough — a rebuild is required.

## Key features

- **DID management** — Create and manage PRISM DIDs and Peer DIDs
- **Credential storage** — Hold and present Verifiable Credentials (EmployeeRole, SecurityClearance, etc.)
- **Classified document access** — VP-gated DOCX/HTML document retrieval with per-section clearance redaction
- **Document viewer** — In-browser DOCX rendering via `docx-preview`, with TTL countdown, watermark, copy/print protection, and a Download button
- **Document update** — Upload a new version of a DOCX document directly from the viewer (requires edit token from Key Authority)
- **QR scanner** — Scan DIDComm OOB invitations (short URL `/wallet/i/<token>` and full `?_oob=...` URLs)
- **DIDComm messaging** — Connect to agents via OOB invitations, process credential offers and presentation requests

## Document flow

1. User clicks a document icon in the file explorer
2. `DocumentDIDAccess` component auto-triggers the VP access flow (EmployeeRole + SecurityClearance VCs presented to `/api/access-gate/present`)
3. Server validates VP, applies clearance-level redaction, and returns the document NaCl-boxed for the wallet's ephemeral X25519 key
4. Wallet decrypts, re-encrypts locally for storage, saves to IndexedDB
5. `ClassifiedDocumentViewer` modal opens — renders DOCX in-browser or displays HTML with redacted sections
6. **Update button** (DOCX only): requests an edit token, shows inline file picker, submits updated file to `/api/document-update/submit`

## Architecture

```
src/
├── actions/index.ts           # Redux async thunks (processMessages, openDocument, …)
├── components/
│   ├── ClassifiedDocumentViewer.tsx  # Secure in-browser document viewer
│   ├── DocumentDIDAccess.tsx         # VP-gated document access flow
│   └── SectionRenderer.tsx          # Per-section HTML rendering with redaction
├── pages/
│   └── documents.tsx          # Document file explorer + My Documents list
├── reducers/
│   └── classifiedDocuments.ts # Redux slice for document state
└── utils/
    ├── documentStorage.ts     # IndexedDB persistence + decryption helpers
    ├── KeyAuthorityClient.ts  # requestDocumentAccess, requestEditAccess
    └── sectionDecryptor.ts    # AES-GCM section decryption
```

## Logs

```bash
tail -f /opt/project_identuslabel/idl-wallet.log
```
