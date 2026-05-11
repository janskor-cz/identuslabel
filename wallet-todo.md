# IDL Wallet – Iagon Login Feature TODO

## Effort Assessment

| Phase | Description | Estimate |
|-------|-------------|----------|
| **Completed** | Initial implementation (login UI, API routes, encryption, Redux state, backup/restore actions) | ~5h |
| **Critical fixes** | Seed timing bug, storage prefix, useEffect races | ~4–6h |
| **Hardening** | Error handling, input validation, registry locking | ~3–4h |
| **Testing** | Full E2E + unit tests | ~4–6h |
| **Total remaining to production-ready** | | **~11–16h** |

The core architecture is sound. The most dangerous issue is the **seed restoration timing bug** — without fixing it, wallet restore will always produce a fresh wallet instead of restoring the user's data.

---

## Critical Bugs (Must fix before first real user)

### C1 — Seed restoration timing (CRITICAL — breaks restore entirely)
**File:** `src/actions/index.ts` — `restoreFromIagon`
**File:** `src/components/PageHeader.tsx` — auto-restore `useEffect`

**Problem:** `restoreFromIagon` calls `dispatch(reduxActions.setDefaultSeed(restoredSeed))` AFTER the agent has already been initialized via `initAgent()`. By that point the SDK agent is immutable — the seed change has no effect on the keys used for `agent.backup.restore(jwe)`. The JWE was encrypted with the original wallet keys; a freshly-initialized agent with a different (random) seed cannot decrypt it.

**Fix:** Restore the seed in Redux **before** `initAgent` is called. This requires:
1. During `handleLogin()`, if backup exists: download + decrypt the Iagon backup immediately (before connecting DB) to extract `seedValue`.
2. `dispatch(reduxActions.setDefaultSeed(restoredSeed))` before calling `connectDatabase`.
3. Remove the seed restoration step from `restoreFromIagon` (seed is already set).
4. `initAgent` will then use `app.defaultSeed` which is the restored seed.

**Revised login flow for returning users:**
```
handleLogin()
  → /api/wallet/download → decrypt → get seedValue
  → dispatch(setDefaultSeed(restoredSeed))
  → connectDatabase({ username, encryptionKey })
  → [auto] initAgent (uses restored seed ✓)
  → [auto] startAgent
  → agent.backup.restore(jwe)   ← now works because keys match
  → refresh Redux from DB
```

---

### C2 — Storage prefix not per-user (security isolation gap)
**File:** `src/reducers/app.ts` line 14 (`storagePrefix: 'wallet-idl-'`)
**File:** `src/utils/prefixedStorage.ts`

**Problem:** All users on the same browser share `localStorage` prefix `wallet-idl-`. This means CA pinning data, company identity pins, and security keys stored in `localStorage` are shared across all users. Alice logging in after Bob sees Bob's pinned CA — a TOFU security bypass.

**Fix:** In `connectDatabase`, after setting `username`, also update `state.wallet.storagePrefix`:
```typescript
// In app.ts reducer (setUsername action or connectDatabase.fulfilled):
state.wallet.storagePrefix = `wallet-idl-${username.toLowerCase()}-`;
```
This requires `storagePrefix` to be computed dynamically, not static from `initialState`.

---

### C3 — Missing `iagonStatus` dependency in backup useEffect
**File:** `src/components/PageHeader.tsx` lines 53–67

**Problem:** The auto-backup `useEffect` depends only on `[app.agent.hasStarted]` but reads `iagonStatus` inside the callback. React keeps a stale closure on `iagonStatus`. If a first backup fails and status goes to `'error'` then back to `'idle'`, the effect won't re-run because `hasStarted` didn't change.

**Fix:**
```typescript
}, [app.agent.hasStarted, iagonStatus]); // add iagonStatus dependency
```
Also add a guard to prevent re-triggering if backup is already in progress:
```typescript
const alreadyHandled = ['uploading', 'synced', 'error', 'downloading', 'restoring', 'checking'].includes(iagonStatus);
if (alreadyHandled) return;
```

---

## High Priority Fixes

### H1 — Re-download seed before DB connect (architecture change from C1)
As part of fixing C1, the login flow needs to eagerly download + decrypt the Iagon backup during `handleLogin()`, **not** wait for agent start. This means:
- The encrypted backup is downloaded in `handleLogin()` immediately after `/api/wallet/check` returns `exists: true`
- `decryptBackup()` is called in the component (client-side, uses WebCrypto)
- The decrypted `seedValue` is dispatched to Redux before `connectDatabase`
- The JWE string is stored in a `useRef` in PageHeader for later restore call
- After agent starts: call `agent.backup.restore(jweRef.current)`

This change should be entirely within `PageHeader.tsx` (and possibly a small update to `restoreFromIagon` to accept an already-decrypted JWE).

---

### H2 — Wrap `/api/wallet/check` in try-catch
**File:** `src/components/PageHeader.tsx` lines 89–94

**Problem:** Network errors during the check call are unhandled — they'll cause an unhandled promise rejection and leave status stuck on `'checking'`.

**Fix:**
```typescript
let checkData: { exists: boolean } = { exists: false };
try {
    const checkRes = await fetch('/api/wallet/check', { ... });
    if (checkRes.ok) checkData = await checkRes.json();
} catch {
    // Iagon check failed — proceed as new wallet, backup will happen after start
    console.warn('[PageHeader] Iagon check failed, continuing as new wallet');
}
```

---

### H3 — Wrap `agent.backup.restore(jwe)` in try-catch
**File:** `src/actions/index.ts` — `restoreFromIagon`

If the JWE is malformed or was created with different keys, `restore()` will throw. Currently this propagates and leaves Redux in a bad state.

**Fix:** catch the error, log it, and continue (wallet stays fresh but functional):
```typescript
try {
    await (agent as any).backup.restore(payload.jwe);
} catch (restoreErr: any) {
    console.error('[restoreFromIagon] JWE restore failed:', restoreErr.message);
    // Wallet remains fresh — user will need to re-earn credentials
    // Still mark as synced so backup flow continues
}
```

---

### H4 — Validate username format
**File:** `src/pages/api/wallet/check.ts`, `upload.ts`, `download.ts`

Add validation to all three API routes:
```typescript
const VALID_USERNAME = /^[a-zA-Z0-9._-]{1,64}$/;
if (!VALID_USERNAME.test(username)) {
    return res.status(400).json({ error: 'Invalid username format' });
}
```

---

## Medium Priority

### M1 — Atomic registry writes (prevent data loss under concurrent requests)
**File:** `src/pages/api/wallet/upload.ts`

Two simultaneous uploads for different users can race: both read registry, both write back, one overwrites the other's entry. Use a write-then-rename pattern or a simple file lock:
```typescript
// Write to temp file, then rename atomically
const tmpPath = REGISTRY_PATH + '.tmp.' + Date.now();
fs.writeFileSync(tmpPath, JSON.stringify(registry, null, 2), 'utf-8');
fs.renameSync(tmpPath, REGISTRY_PATH);
```

---

### M2 — Rate limit the API routes
**File:** `src/pages/api/wallet/*.ts`

Currently there is no rate limiting. Anyone can hammer the check endpoint to enumerate usernames. Add a simple in-memory rate limiter per IP or use a middleware approach. For the Next.js context, a minimal approach:
```typescript
// 10 requests per minute per IP
import { RateLimiter } from 'limiter'; // or use a simple Map<ip, count>
```
Alternatively, document this as "behind Caddy rate limiting" if Caddy is already configured.

---

### M3 — Store Iagon `fileId` update on each backup (not just first upload)
**File:** `src/pages/api/wallet/upload.ts`

Each call to `/api/wallet/upload` uploads a NEW file to Iagon (different fileId each time). The old backup is orphaned on Iagon (no delete call). Two options:
- **Option A (simple):** Before uploading new backup, delete the old file from Iagon using the stored `fileId`. Then update registry with new `fileId`.
- **Option B (immutable):** Keep all backups (versioned), update registry to point to latest.

Option A is recommended for cost/storage reasons.

**Delete endpoint to add to IagonStorageClient pattern:**
```typescript
// Add to upload.ts before uploading new file:
const oldEntry = registry[username.toLowerCase()];
if (oldEntry?.fileId) {
    await fetch(`${IAGON_BASE_URL}/files/delete`, {
        method: 'DELETE',
        headers: { 'x-api-key': accessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: oldEntry.fileId }),
    }).catch(() => { /* ignore delete failures */ });
}
```

---

### M4 — Debounce the auto-backup after credential/connection changes
**Currently:** Backup only happens once on first login (agent start).

**Problem:** After the wallet is restored, when the user receives new credentials or makes new connections, the Iagon backup becomes stale. If the user logs in on another device, they get an outdated backup.

**Fix:** Trigger `backupToIagon` after significant events:
- After a credential is received (`Credential.success`)
- After a connection is accepted
- After agent has been running for 30+ seconds (catch-all)

Use debouncing (e.g., 5-second delay) to avoid uploading on every message:
```typescript
// In PageHeader.tsx or a dedicated hook
const debouncedBackup = useRef<ReturnType<typeof setTimeout>>();
useEffect(() => {
    if (!app.agent.hasStarted || !usernameRef.current) return;
    clearTimeout(debouncedBackup.current);
    debouncedBackup.current = setTimeout(() => {
        app.backupToIagon({ username: usernameRef.current, password: passwordRef.current });
    }, 5000);
}, [app.credentials.length, app.connections.length]);
```

---

### M5 — Handle "Iagon not configured" gracefully
**File:** `src/components/PageHeader.tsx`

If `/api/wallet/check` returns `503` (Iagon env vars not set), login should still work — just skip backup/restore and proceed as a local-only wallet.

**Fix:** In `handleLogin()`, treat 503 from check as "no Iagon, continue normally":
```typescript
if (checkRes.status === 503) {
    console.warn('[PageHeader] Iagon not configured — running in local-only mode');
    // skip iagonBackup status changes, proceed directly to connectDatabase
}
```

---

### M6 — Document environment variable setup
**File:** `idl-wallet/.env.local.example` (create this file)

```bash
# Iagon Decentralized Storage (required for username/password login with cloud backup)
IAGON_ACCESS_TOKEN=your_access_token_here
IAGON_NODE_ID=your_node_id_here
IAGON_DOWNLOAD_BASE_URL=https://gw.iagon.com/api/v2   # default, override if needed
```

Without these vars, the wallet falls back to local-only mode (see M5).

---

## Low Priority / Nice to Have

### L1 — Add "Forgot password" / recovery flow documentation
The current design has no account recovery. If a user forgets their password:
- The Iagon backup cannot be decrypted (PBKDF2+AES with wrong password)
- The local IndexedDB is encrypted with a different key
- All credentials are permanently lost

This is intentional (zero-knowledge design) but needs to be documented and communicated in the UI.

**UI addition:** Below the login form, add a small note:
> "Your password encrypts your wallet. There is no recovery if lost."

---

### L2 — Show backup age / last sync time in UI
**After:** `iagonStatus === 'synced'`

Show when the last backup was taken:
```typescript
// From checkData.updatedAt when backup exists
<p className="text-xs text-gray-500">Last backup: {formatRelativeTime(checkData.updatedAt)}</p>
```

---

### L3 — Manual backup/restore trigger in Configuration page
Add a "Backup now" button to `src/pages/configuration.tsx` so power users can trigger backup on demand, rather than only on login.

---

### L4 — Consider moving registry to server-side DB
`data/wallet-registry.json` is simple and works, but is fragile:
- Lost on server replacement
- Doesn't scale past ~1000 users
- No backup

When traffic grows, migrate to SQLite (via `better-sqlite3`) or a simple Postgres table. Schema:
```sql
CREATE TABLE wallet_registry (
  username VARCHAR(64) PRIMARY KEY,
  file_id TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW()
);
```

---

## Testing Checklist

Before shipping to real users, verify:

- [ ] **New user flow:** Username+password → creates DB → agent starts → backup uploads to Iagon → fileId in registry
- [ ] **Returning user flow (same device):** Same username+password → Iagon backup found → seed restored → DB populated → credentials visible
- [ ] **Returning user flow (new device/fresh browser):** Same as above but IndexedDB is empty initially
- [ ] **Wrong password:** Login fails gracefully, no data corrupted
- [ ] **Iagon down / 503:** Login works in local-only mode (M5)
- [ ] **Concurrent logins:** Two users login simultaneously, no registry race condition
- [ ] **Multiple users same browser:** User A and User B have separate data, different DB names, different localStorage prefixes (after C2 fix)
- [ ] **agent.backup.createJWE() output:** Log the JWE and verify it can be passed to `agent.backup.restore()` on a freshly initialized agent with the same seed

---

## Key Files Changed in This Implementation

| File | Change |
|------|--------|
| `idl-wallet/src/components/PageHeader.tsx` | Username+password login UI, Iagon status display, auto-backup/restore effects |
| `idl-wallet/src/actions/index.ts` | `backupToIagon`, `restoreFromIagon` actions; `connectDatabase` now accepts `username` |
| `idl-wallet/src/reducers/app.ts` | Added `username`, `iagonBackup` to state; new reducers `setUsername`, `setDefaultSeed`, `setIagonBackupStatus` |
| `idl-wallet/src/reducers/store.ts` | Added new action types to serializable check ignore list |
| `idl-wallet/src/utils/walletCrypto.ts` | NEW — client-side PBKDF2+AES-256-GCM encryption for backups |
| `idl-wallet/src/pages/api/wallet/check.ts` | NEW — check if Iagon backup exists for username |
| `idl-wallet/src/pages/api/wallet/upload.ts` | NEW — upload encrypted backup to Iagon |
| `idl-wallet/src/pages/api/wallet/download.ts` | NEW — download encrypted backup from Iagon |

**Data:** `idl-wallet/data/wallet-registry.json` — server-side username→fileId map (auto-created on first upload)

---

## Architecture Notes for Future Instances

**Why seed-before-init matters:**
The Identus SDK's `Agent.initialize({ seed })` derives all wallet keys from the seed. Once initialized, the agent is immutable. The JWE from `agent.backup.createJWE()` is encrypted with those derived keys. To decrypt it on restore, the agent must have been initialized with the **same seed** that was used when the backup was created. The fix in C1 ensures this ordering.

**Why PBKDF2 + username salt?**
The Iagon backup is encrypted with `PBKDF2(password, username + ':idl-wallet', ...)`. Including the username in the salt means the same password used for two different usernames produces different encryption keys — preventing key reuse attacks. **Downside:** If a user renames their account, old backups can't be decrypted with the new username. Document this.

**The registry is local-only:**
`data/wallet-registry.json` maps username to Iagon fileId. This file lives on the server running the IDL wallet. If the server is replaced, the mapping is lost. Users can still re-register (creating a new wallet), but cannot recover their old encrypted backup (even though it exists on Iagon) because the fileId is gone. Consider externalizing this as per L4.
