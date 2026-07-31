/**
 * walletNamespace.ts — THE single source of truth for every storage namespace this wallet uses.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────────────────────
 * v1 (`/wallet`, port 3002) and v2 (`/wallet-v2`, port 3003) are served from the SAME browser
 * origin (`identuslabel.cz`). Browser storage — IndexedDB and localStorage — is scoped to the
 * ORIGIN, not the path. So both wallets see one shared storage area, and the ONLY thing keeping
 * v2 out of v1's database is the namespace strings below.
 *
 * In v1 those strings were hardcoded in six separate places. Missing any one of them while
 * standing up v2 would have had v2 writing into v1's live user data — credentials, connections,
 * DIDs, security-clearance keys. That is why this module exists: one constant, six consumers,
 * no literals anywhere else.
 *
 * ── INVARIANT ────────────────────────────────────────────────────────────────────────────────
 * The string `identus-wallet-idl` / `wallet-idl-` (v1's namespace) MUST NOT appear anywhere in
 * this codebase outside this file's WALLET_ID history note. Enforce with:
 *
 *     grep -rn "identus-wallet-idl\b\|wallet-idl-" src/    # expect: only this file
 *
 * ── CONSUMERS (all six; keep this list current) ───────────────────────────────────────────────
 *   1. reducers/app.ts            — getWalletConfig(): dbName + storagePrefix
 *   2. utils/prefixedStorage.ts   — getStoragePrefix(): every localStorage key
 *   3. utils/connectionDeletion.ts— direct IndexedDB open for connection cleanup
 *   4. actions/index.ts           — connectDatabase(): per-user Pluto dbName
 *   5. actions/index.ts           — restoreFromIagon(): rxdb-dexie IDB database prefix
 *   6. utils/documentStorage.ts   — classified-documents-store-<walletId> default
 *
 * Adding a v3 is a one-line change here.
 */

/**
 * Short wallet identifier. Appears in the classified-documents database name and as the default
 * per-user scope before login sets a username.
 *
 * History: v1 used `'idl'`. v2 uses `'idl2'` so the two never collide on a shared origin.
 */
export const WALLET_ID = 'idl2';

/** Human-readable name, shown in the UI. */
export const WALLET_NAME = 'IDL Wallet v2';

/**
 * Base name for the SDK's Pluto (RxDB/IndexedDB) database. The per-user database is
 * `${PLUTO_DB_BASE}-<username>` — see plutoDbName() below; never build it by hand.
 */
export const PLUTO_DB_BASE = `identus-wallet-${WALLET_ID}`;

/**
 * Prefix for every localStorage key routed through utils/prefixedStorage.ts.
 * Note the trailing hyphen — callers concatenate directly.
 */
export const STORAGE_PREFIX = `wallet-${WALLET_ID}-`;

/** Per-user Pluto database name. Username is lowercased so casing can't fork a user's storage. */
export function plutoDbName(username: string): string {
  return `${PLUTO_DB_BASE}-${username.toLowerCase()}`;
}

// REMOVED at the SDK v8 migration: `rxdbDexiePrefix(username)`.
//
// v6's storage (pluto-encrypted → RxDB + Dexie) created one IndexedDB database per collection,
// named `rxdb-dexie-${dbName}--${schemaVersion}--${collectionName}`, and restoreFromIagon cleared
// the wallet by enumerating indexedDB.databases() and deleting every name with that prefix.
//
// v8's default store is RIDB and creates no such databases, so that prefix would now match
// nothing — a silent no-op that left restore failing against a non-empty store. The clear step
// now goes through the SDK's own store API instead (see actions/index.ts's restoreFromIagon).
// Deliberately not replaced with an RIDB-specific equivalent: nothing outside the SDK should
// depend on how the store names its databases.

/** Classified-documents IndexedDB database name (see utils/documentStorage.ts). */
export function classifiedDocumentsDbName(walletId: string): string {
  return `classified-documents-store-${walletId}`;
}

/**
 * ── ROUTING BASE PATH ────────────────────────────────────────────────────────────────────────
 * The URL prefix this deployment is served under (`/wallet-v2`; v1 used `/wallet`).
 *
 * Next.js's own `basePath` in next.config.js already prefixes PAGE routes and static assets
 * automatically — but NOT hand-written `fetch()` calls to this app's own API routes, nor
 * hand-built page URLs. Those must use the helpers below.
 *
 * Sourced from NEXT_PUBLIC_BASE_PATH (set in .env.local, inlined at build time by Next.js) so it
 * cannot drift from next.config.js. The fallback matches next.config.js's literal.
 */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || '/wallet-v2';

/**
 * Build a URL to one of THIS app's own API routes.
 * @example apiUrl('/api/logs') -> '/wallet-v2/api/logs'
 */
export function apiUrl(path: string): string {
  return `${BASE_PATH}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Build a URL to one of THIS app's own pages (for window.open / postMessage payloads, where
 * Next.js's automatic basePath handling does not apply).
 * @example pageUrl('/documents') -> '/wallet-v2/documents'
 */
export function pageUrl(path: string): string {
  return apiUrl(path);
}


/**
 * ── SDK VERSION (display only) ───────────────────────────────────────────────────────────────
 * Read from the installed package at BUILD time by next.config.js, which injects it as
 * NEXT_PUBLIC_SDK_VERSION. Previously this was the literal string "v6.6.0" hardcoded in two
 * places in MainLayout.tsx — it stayed stale through the entire v6→v8 migration and told users
 * the wrong version. Never hardcode it again.
 *
 * Note the package is installed under its OLD name via a yarn alias
 * (`@hyperledger/identus-edge-agent-sdk: npm:@hyperledger/identus-sdk@8.1.0`), so the version
 * here is the real resolved one regardless of the import name.
 */
export const SDK_VERSION = process.env.NEXT_PUBLIC_SDK_VERSION || 'unknown';

/** Human-readable SDK label for the UI, e.g. "Hyperledger Identus SDK v8.1.0". */
export const SDK_LABEL = `Hyperledger Identus SDK v${SDK_VERSION}`;

/**
 * ── BUILD STAMP (diagnostics only) ───────────────────────────────────────────────────────────
 * ISO timestamp of the `yarn build` that produced the JS currently executing, injected by
 * next.config.js. Logged once at startup by pages/_app.tsx.
 *
 * Why it exists: this wallet is a long-running SPA served by `next start`. Rebuilding and
 * restarting the server does NOT reach a tab that is already open — it keeps running the bundle it
 * downloaded. When a newly added code path produces no log output, that is indistinguishable from
 * the tab never having loaded the code, and both times this happened the debugging cost was a
 * whole extra test round trip. Compare this stamp against the build you expect before concluding
 * anything about a silent code path.
 */
export const BUILD_STAMP = process.env.NEXT_PUBLIC_BUILD_STAMP || 'unknown';
