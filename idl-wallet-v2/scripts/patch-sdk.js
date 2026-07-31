#!/usr/bin/env node
/**
 * patch-sdk.js — post-install patches against the upstream npm SDK bundle.
 *
 * v2 deliberately depends on the published `@hyperledger/identus-sdk` rather than v1's local
 * fork (see CLAUDE.md), so patches cannot live in a git tree. They are applied here instead, as
 * targeted, idempotent, self-verifying string replacements over the SHIPPED MINIFIED BUNDLE —
 * not as a unified diff. A diff of a one-line 1 MB minified file would be unreadable and would
 * break on any upstream rebuild; an exact-substring replace either matches or fails loudly.
 *
 * Wired to `postinstall` so `yarn install` / `npm ci` cannot silently drop a patch. Re-running is
 * safe: each patch reports `already applied` when the patched form is already present.
 *
 * ⚠️ On an SDK upgrade this script will FAIL rather than skip. That is deliberate — a silently
 * un-applied security patch is worse than a broken install. Re-derive each patch against the new
 * bundle, or delete it here if upstream fixed the underlying bug.
 */

const fs = require('fs');
const path = require('path');

const SDK_BUILD = path.join(
  __dirname,
  '..',
  'node_modules',
  '@hyperledger',
  'identus-edge-agent-sdk',
  'build',
);

/**
 * P1 — DIF presentation submissions must be signed with the holder DID's AUTHENTICATION key.
 *
 * The submission builder picks its signing key positionally and then passes it to `signWithDID`
 * as an explicit override:
 *
 *   const t = await e.Pluto.getDIDPrivateKeysByDID(r);
 *   const i = t.at(0);                                    // no key-purpose filter
 *   return e.JWT.signWithDID(r, o, void 0, i, "AUTHENTICATION_KEY");
 *
 * The `"AUTHENTICATION_KEY"` argument is inert whenever an explicit key is supplied: the sign
 * task's key lookup returns `[thatKey]` and resolves `C?.privateKey ?? this.args.privateKey`, so
 * a key that matches no `authentication` verification method is used anyway.
 *
 * `.at(0)` is not "the first key stored" either — `getDIDPrivateKeysByDID` re-reads through
 * `Keys.get({ $or: [...] })`, and RxDB applies a default sort on the collection's primary key
 * (`uuid`, a random v4) when a query carries no explicit sort. So the signing key is effectively
 * a coin flip between `master-0` and `authentication-0`, fixed per DID at creation time.
 *
 * When it lands on `master-0` the resulting VP still passes the SDK's own verifier (which loops
 * every entry in `verificationMethod`), but fails any authentication-scoped check — the PRISM
 * resolver deliberately excludes MASTER_KEY from every verification relationship. That is exactly
 * what breaks `src/utils/liveIdentityVerification.ts`'s layer-2 check, and with it the reciprocal
 * identity disclosure in `OOB.tsx` and `ConnectionMetadata.verifiedCredentialSubject`.
 *
 * Dropping the explicit key lets the sign task do its own purpose lookup: it matches the DID
 * document's `authentication` verification methods against the wallet's stored private keys,
 * signs with the one that matches, and sets the correct `kid` header. Fails loudly ("key not
 * found") rather than silently signing with the wrong key. The credential-request proof path
 * (`credential-offer/JWT`) already calls `signWithDID` this exact way and works against the live
 * CA, so the purpose lookup is known-good on these DIDs.
 * ⚠️ The SDK ships the SAME code twice — an ESM build (`.js`) and a CJS build (`.cjs`), with
 * identical minified identifiers. `package.json` sets `main: ./build/index.cjs` and
 * `module: ./build/index.js`, and Next.js resolved the **CJS** copy into the browser bundle. A
 * patch applied to only one of them silently does nothing. Patches therefore target every
 * `.js`/`.cjs` file under `build/` and require a match in at least one, never a specific filename
 * (chunk hashes change on every upstream rebuild anyway).
 */
const PATCHES = [
  {
    id: 'P1',
    summary: 'sign DIF presentation submissions with the AUTHENTICATION key, not a random one',
    find: 'e.JWT.signWithDID(r,o,void 0,i,"AUTHENTICATION_KEY")',
    replace: 'e.JWT.signWithDID(r,o,void 0,void 0,"AUTHENTICATION_KEY")',
  },
];

/** Every `.js`/`.cjs` under `build/`, recursively. Source maps are deliberately not rewritten. */
function bundleFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...bundleFiles(full));
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.cjs')) out.push(full);
  }
  return out;
}

let failed = false;

if (!fs.existsSync(SDK_BUILD)) {
  console.error(`❌ [patch-sdk] SDK build directory not found at ${SDK_BUILD}`);
  process.exit(1);
}

const files = bundleFiles(SDK_BUILD);

for (const patch of PATCHES) {
  const patched = [];
  const alreadyPatched = [];

  for (const target of files) {
    const source = fs.readFileSync(target, 'utf8');

    // Idempotence is checked BEFORE the match so a re-run over an already-patched tree is a no-op
    // rather than a failure. Only meaningful because `replace` never contains `find`.
    if (source.includes(patch.replace)) {
      alreadyPatched.push(path.basename(target));
      continue;
    }
    if (!source.includes(patch.find)) continue;

    const occurrences = source.split(patch.find).length - 1;
    fs.writeFileSync(target, source.split(patch.find).join(patch.replace), 'utf8');
    patched.push(`${path.basename(target)}${occurrences > 1 ? ` x${occurrences}` : ''}`);
  }

  const touched = patched.length + alreadyPatched.length;
  if (touched === 0) {
    console.error(
      `❌ [patch-sdk] ${patch.id}: no file under build/ matches. ` +
        `The SDK bundle has changed — re-derive this patch before shipping.`,
    );
    failed = true;
    continue;
  }

  const applied = patched.length ? `applied to ${patched.join(', ')}` : '';
  const already = alreadyPatched.length ? `already applied in ${alreadyPatched.join(', ')}` : '';
  console.log(
    `✅ [patch-sdk] ${patch.id}: ${[applied, already].filter(Boolean).join('; ')} (${patch.summary})`,
  );
}

if (failed) {
  console.error('❌ [patch-sdk] one or more SDK patches could not be applied — refusing to continue.');
  process.exit(1);
}
