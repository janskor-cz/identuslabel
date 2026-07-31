/**
 * sdkCompat.ts — the ONE place that papers over SDK API changes.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────
 * v1 of this wallet ran on a *patched fork* of the SDK: 13 local patches across 20 SDK files.
 * The fork's source path was lost once (it survived only by accident), and rebasing it across
 * major versions is exactly the cost this module exists to avoid.
 *
 * v2's rule: **run stock npm SDK, adapt at the boundary.** When an SDK version removes or moves
 * something the wallet needs, the shim goes here — never into `node_modules`, never a fork.
 *
 * Everything here is a candidate for deletion when upstream provides an equivalent. Each export
 * records which SDK version broke it and what the SDK does instead.
 */

import * as SDK from '@hyperledger/identus-edge-agent-sdk';
import { MediationKeysUpdateList } from '@hyperledger/identus-edge-agent-sdk/plugins/didcomm';

/**
 * Store a DID pair (a "connection").
 *
 * SDK v7 deleted `ConnectionsManager` (304 lines), `BasicMediatorHandler` (263) and
 * `PlutoMediatorStore` (43), and removed `agent.connectionManager` — connection management is
 * now internal to the Agent. v6's `connectionManager.addConnection(pair)` did exactly two
 * things: `pluto.storeDIDPair(host, receiver, name)`, then emit a CONNECTION event so the UI
 * refreshed. The storage half is reproduced here; the event half is now the Agent's own
 * business, and this wallet's UI re-reads connections from Pluto anyway.
 *
 * v6 fork patch P7 also made this tolerant of duplicate-key conflicts (re-accepting an
 * invitation, or a redelivered connection message, re-saves the same pair). That tolerance is
 * preserved below rather than being lost with the fork.
 */
export async function storeConnection(
  agent: SDK.Agent,
  pair: SDK.Domain.DIDPair,
): Promise<void> {
  // ── PRE-INSERT DEDUP (fork patch P7, first half) ──────────────────────────────────────────
  // The catch-block below only handles the case where the store RAISES a duplicate-key error.
  // v6's fork patched `Pluto.storeDIDPair` to actively CHECK for an existing pair first and
  // return early — because more than one code path can store the same connection (our own
  // acceptance handler plus the Agent's internal connection handling), and v8's RIDB store does
  // not appear to reject the second write. Without this check you get two DIDComm records for
  // one connection: observed live against the CA on 2026-07-30.
  //
  // ⚠️ DEDUP ON THE **RECEIVER** ONLY — NOT host+receiver.
  // A connection is identified by WHO WE ARE CONNECTED TO, not by which local peer DID we happened
  // to mint for it. Matching on host+receiver looks more precise but is useless in practice: every
  // caller mints a FRESH peer DID immediately before storing, so the host never matches an existing
  // row and the check can never fire. That is precisely why duplicates survived the first fix —
  // two records for one CA, with different hosts and the same receiver (observed live 2026-07-30).
  //
  // v8 compounds this: `agent.acceptInvitation()` returns void and stores the pair ITSELF, so a
  // caller that also mints its own peer DID and stores again produces a second, differently-hosted
  // row for the same peer. Receiver-keyed dedup absorbs both cases.
  try {
    const existing = await agent.pluto.getAllDidPairs();
    const dupe = existing.find((p) => p.receiver.toString() === pair.receiver.toString());
    if (dupe) {
      console.log('ℹ️ [sdkCompat] Connection to this peer already exists — skipping duplicate:', pair.name);
      if (dupe.host.toString() !== pair.host.toString()) {
        console.warn('⚠️ [sdkCompat] A second peer DID was minted for an existing connection. ' +
                     'Existing host:', dupe.host.toString().substring(0, 40) + '…',
                     '| discarded host:', pair.host.toString().substring(0, 40) + '…');
      }
      return;
    }
  } catch (lookupError: any) {
    // A failed lookup must not block the write; fall through to the insert + conflict handling.
    console.warn('⚠️ [sdkCompat] Could not check for an existing DID pair:', lookupError?.message);
  }

  try {
    await agent.pluto.storeDIDPair(pair.host, pair.receiver, pair.name ?? '');
  } catch (error: any) {
    // Fork patch P7 behaviour: a duplicate pair is success, not failure. Re-throw anything else.
    const msg = String(error?.message ?? '');
    const isConflict =
      error?.status === 409 ||
      error?.code === 'CONFLICT' ||
      msg.includes('CONFLICT') ||
      msg.includes('UNIQUE') ||
      error?.constructor?.name === 'StoreInsertError';
    if (!isConflict) throw error;
    console.log('ℹ️ [sdkCompat] DID pair already stored — treating as success:', pair.name);
  }
}

/**
 * Register peer DIDs with the mediator's keylist, so the mediator will accept and hold inbound
 * messages addressed to them.
 *
 * ⚠️ SILENT-FAILURE HAZARD. If this does not actually reach the mediator, nothing errors —
 * the mediator simply drops inbound messages for unregistered DIDs, and the wallet looks
 * connected but never receives anything. That exact bug is why v6 called
 * `connectionManager.mediationHandler.updateKeyListWithDIDs()` on every startup as a recovery
 * path, and why fork patch P12 added a post-registration mediator assertion.
 *
 * SDK v7 removed the convenience method along with `BasicMediatorHandler`, and provides **no
 * public API to retroactively register an already-created DID**. `agent.createNewPeerDID(services,
 * updateMediator=true)` registers at *creation* time only. So this reconstructs the operation at
 * the protocol level, using the publicly-exported `MediationKeysUpdateList`
 * (`coordinate-mediation/2.0/keylist-update`) from the didcomm plugin.
 *
 * ⚠️ **NOT YET VERIFIED AGAINST THE LIVE MEDIATOR.** This must pass the Stage 2 exit test
 * (connect, then confirm inbound messages arrive after a restart) before v2 is considered
 * migrated. Do not assume it works because it type-checks.
 *
 * @returns true if a keylist-update was sent; false if it could not be attempted (caller should
 *          treat false as "mediator registration did not happen", not as success).
 */
export async function updateMediatorKeyList(
  agent: SDK.Agent,
  mediatorDID: SDK.Domain.DID | null | undefined,
  dids: SDK.Domain.DID[],
): Promise<boolean> {
  if (!dids.length) return true;
  if (!mediatorDID) {
    console.warn('⚠️ [sdkCompat] No mediator DID — peer DIDs NOT registered with mediator keylist');
    return false;
  }

  try {
    // `from` must be a DID the mediator already routes for. The first host DID is used, matching
    // v6's behaviour of updating the keylist over the existing mediated channel.
    const from = dids[0];
    const message = new MediationKeysUpdateList(from, mediatorDID, dids).makeMessage();
    await agent.sendMessage(message);
    console.log(`✅ [sdkCompat] keylist-update sent for ${dids.length} peer DID(s)`);
    return true;
  } catch (error: any) {
    console.warn('⚠️ [sdkCompat] keylist-update FAILED — mediator may drop inbound messages:', error?.message);
    return false;
  }
}

/**
 * Create a new peer DID, reproducing v6's `agent.createNewPeerDID(services, updateMediator)`.
 *
 * SDK v8 removed `createNewPeerDID`/`createNewPrismDID` in favour of
 * `agent.createDID('peer'|'prism', { keys, services, alias })`. The behavioural difference that
 * matters: v6 **generated the keypairs internally**, while v8 requires them to be supplied —
 * `AUTHENTICATION_KEY` (Ed25519) and `KEY_AGREEMENT_KEY` (X25519), both as arrays.
 *
 * The `updateMediator` argument is gone because it is no longer optional: per the v8 docs,
 * `agent.createDID` "and (for peer DIDs) update[s] the mediator key list" automatically. Every
 * wallet call site passed `true` except one — `startAgent`'s `selfDID`, which passed `false` — so
 * that site now registers where it previously did not. That is a safe direction (an extra keylist
 * entry for a DID we own), not a regression, but it is a real behaviour change worth knowing.
 *
 * Note this only covers DIDs created *here*. Retroactively registering an already-existing DID
 * still has no public API — see `updateMediatorKeyList` below.
 */
export async function createPeerDid(
  agent: SDK.Agent,
  services: InstanceType<typeof SDK.Domain.DIDDocument.Service>[] = [],
): Promise<SDK.Domain.DID> {
  const authentication = (SDK as any).Ed25519KeyPair.generateKeyPair();
  const keyAgreement = (SDK as any).X25519KeyPair.generateKeyPair();
  return agent.createDID('peer', {
    keys: {
      AUTHENTICATION_KEY: [authentication.privateKey],
      KEY_AGREEMENT_KEY: [keyAgreement.privateKey],
    },
    ...(services.length ? { services } : {}),
  } as any);
}

/**
 * Build a credential request that binds to an **existing** holder DID.
 *
 * This is fork patch **P3**, and correcting an earlier assessment: P3 is **not** upstream in
 * TypeScript. v6's `prepareRequestCredentialWithIssuer(offer)` always minted a *fresh* PRISM DID
 * per offer; the fork added `{ subjectDID, alias }` options. **v7 and v8 both still take only
 * `(offer)`** — the two-argument form exists in the *Kotlin* SDK, not this one.
 *
 * Why it matters: a fresh DID per credential means the wallet's credentials don't share a holder
 * DID, which makes `HOLDER_BINDING_FAILED` unavoidable in the `service-access/1.0` flow (the
 * verifier checks that every presented credential's subject matches the VP signer).
 *
 * The non-fork route is the public `RunProtocol` task, whose `credential-request` args accept an
 * explicit `holderDID`. That is the same capability the fork bolted onto the Agent method,
 * reached through a supported API instead of a patch.
 *
 * ⚠️ **Behaviour-critical and not yet exercised against a live issuer.** If this silently falls
 * back to a fresh DID, holder binding breaks and document/portal access fails at the verifier
 * with a confusing error. Cover it in the Stage 2 exit test.
 */
export async function prepareCredentialRequestForHolder(
  agent: SDK.Agent,
  offer: any,
  _offerMessage: SDK.Domain.Message,
  _holderDID: SDK.Domain.DID,
): Promise<any> {
  // 🔴 UNRESOLVED AT v8 — DEGRADES, DOES NOT THROW.
  //
  // The v7 route was the public `RunProtocol` task, whose `credential-request` args accept an
  // explicit `holderDID`. **v8 made RunProtocol internal** ("The RunProtocol becomes internal as
  // it's only managed by the SDK internals" — migrating_7x_to_8x.md); it is exported from neither
  // the root nor `plugins/didcomm` / `plugins/oea`. `RequestCredential` in the didcomm plugin
  // exposes only `fromMessage`, not a builder that takes a holder DID.
  //
  // Reconstructing the request message and signing it by hand would mean reimplementing SDK
  // internals — the precise cost this module exists to avoid — so we fall back to the SDK's own
  // behaviour: a FRESH subject DID per credential.
  //
  // WHAT THIS COSTS: a single-credential VP still verifies (the VP signer is that credential's own
  // subject). The risk is a MULTI-credential VP — e.g. the employee portal presenting EmployeeRole
  // + CISTraining + SecurityClearanceGrant together, which `ClaimExtractor` explicitly supports —
  // where the verifier requires every contained credential's subject to equal the VP signer.
  // With per-credential DIDs that check can fail with HOLDER_BINDING_FAILED.
  //
  // ⚠️ MUST BE EXERCISED IN THE LIVE EXIT TEST before v2 is considered done: request two
  // credentials, then present both in one VP. If it fails, the options are (a) an upstream
  // request to re-expose holder-DID binding, or (b) hand-building the request message here.
  console.warn(
    '⚠️ [sdkCompat] Holder-DID binding unavailable on SDK v8 (RunProtocol is internal). ' +
    'Falling back to a fresh subject DID for this credential — multi-credential VPs may fail ' +
    'holder binding. See sdkCompat.prepareCredentialRequestForHolder.',
  );
  return agent.prepareRequestCredentialWithIssuer(offer);
}

/**
 * JWT verification / decoding.
 *
 * SDK v7 removed the public `agent.pollux` accessor, which the wallet used as
 * `agent.pollux.JWT.verify({ jws, issuerDID })` and `agent.pollux.JWT.decode(jws)`. The same
 * class is now exported directly as `SDK.JWT`, with **identical** method signatures.
 *
 * ⚠️ These call sites were invisible to `tsc` because they were written as `(agent.pollux as any)`.
 * They sit on the security-critical paths — `vcValidation.ts`'s credential signature check and
 * `liveIdentityVerification.ts`'s authentication-scoped proof check. Left unmigrated they would
 * not have thrown: `agent.pollux` would simply be `undefined`, the guards would skip, and
 * RealPerson verification would silently fail closed (rejecting every valid credential) while
 * live identity verification errored out. Correct-but-broken, and type-checking cannot see it.
 *
 * ── 🔴 THE ABOVE HAPPENED ANYWAY — `verify` NEEDS AN AGENT CONTEXT (fixed 2026-07-31) ────────
 * The migration swapped `agent.pollux.JWT` for a bare `new SDK.JWT()`, which is NOT equivalent.
 * On v8 `JWT` is a `Task.Runner`: `verify()`'s first act is `runTask(ResolveDID)` to fetch the
 * issuer's DID document, and `Task.Runner.runTask` asserts `this.context` — a `JWT` built with
 * plain `new` has none. It therefore threw `"JWT: no Context available"` on EVERY call, and
 * `verify()`'s own internal `try { … } catch { return false }` swallowed it into a plain `false`.
 * Net effect: every signature check in the wallet reported "invalid signature" for every
 * credential, valid or forged — exactly the fail-closed mode this doc comment warned about,
 * reached by a different route. Confirmed at runtime against the installed SDK; it blocked
 * wallet-to-wallet RealPerson invitations outright (`InvitationPreviewModal` disables Accept
 * whenever validation reports errors).
 *
 * `agent.runtimeContext` is the supported way to get a context (it builds a fresh `AgentContext`
 * carrying Castor/Apollo/Pluto/etc. on each read, and needs no started agent), so `verify` now
 * REQUIRES an agent and throws when it has none — a missing agent must never be indistinguishable
 * from a bad signature again.
 *
 * `decode()` is exempt: it delegates to a static decoder and touches no task, so it works
 * contextless (verified at runtime).
 */
function jwtRunner(agent?: SDK.Agent): any {
  const jwt = new (SDK as any).JWT();
  if (!agent) return jwt;
  const context = (agent as any).runtimeContext;
  if (!context) {
    throw new Error('Agent exposes no runtimeContext — cannot verify JWT signatures');
  }
  // withContext() clones the runner, so this never mutates a shared instance.
  return jwt.withContext(context);
}

/**
 * Verify a JWS against an issuer DID. Same contract as v6's `pollux.JWT.verify`, plus a required
 * `agent` — see this section's doc comment for why a context-less runner silently fails closed.
 *
 * Throws (rather than returning `false`) when no usable agent is supplied: callers treat `false`
 * as "this signature is bad", and "we could not check" must not masquerade as that.
 */
export async function jwtVerify(options: {
  jws: string;
  issuerDID: SDK.Domain.DID;
  holderDID?: SDK.Domain.DID;
  agent: SDK.Agent;
}): Promise<boolean> {
  const { agent, ...verifyOptions } = options;
  if (!agent) {
    throw new Error('jwtVerify requires an agent — a context-less SDK.JWT rejects every signature');
  }
  return jwtRunner(agent).verify(verifyOptions);
}

/** Decode a JWS **without verifying it**. Same contract as v6's `pollux.JWT.decode`. */
export async function jwtDecode(jws: string): Promise<any> {
  return jwtRunner().decode(jws);
}

/**
 * True when the SDK exposes working JWT crypto. Replaces the old `agent.pollux` truthiness
 * guards, which silently became `false` on v7 and disabled signature checking.
 */
export function hasJwtCrypto(): boolean {
  return typeof (SDK as any).JWT === 'function';
}

/**
 * Permanently delete a stored credential.
 *
 * This is fork patch **P13**, and it is still absent upstream as of v8: the Pluto interface has
 * `deleteMessage(uuid)` and `revokeCredential(credential)`, but no `deleteCredential`. v6 added
 * one by patching `Pluto.ts` directly; v2 decorates instead.
 *
 * ⚠️ Implemented against Pluto's underlying store because the public interface offers no route.
 * Verify against the SDK's own `.sq`/RxDB schema before trusting it, and never let it cascade to
 * the credential's private keys — deleting those would make any remaining copy unpresentable.
 */
export async function deleteCredential(
  plutoOrAgent: SDK.Domain.Pluto | SDK.Agent,
  credential: SDK.Domain.Credential,
): Promise<void> {
  // Accepts either a Pluto or an Agent: some call sites hold `app.db.instance` (a Pluto) and
  // others hold the running agent.
  const pluto = ((plutoOrAgent as any).pluto ?? plutoOrAgent) as any;

  // Prefer a real implementation if a future SDK adds one.
  if (typeof pluto.deleteCredential === 'function') {
    await pluto.deleteCredential(credential);
    return;
  }

  const repo = pluto.Repositories?.Credentials;
  if (!repo) {
    throw new Error(
      '[sdkCompat] Cannot delete credential: Pluto exposes neither deleteCredential() nor an ' +
      'accessible Credentials repository. The SDK internals changed — update sdkCompat.ts.',
    );
  }

  const model = await repo.findOne({ id: credential.id });
  if (!model) return; // already gone — idempotent
  await repo.delete(model.uuid);
}
