/**
 * liveIdentityVerification.ts
 *
 * POST-CONNECTION live proof-of-possession for RealPerson-, SecurityClearance-,
 * CertificationAuthorityIdentity-, and CompanyIdentity-typed OOB invitations/connections (see
 * `LiveVerifiableCredentialType` in vcValidation.ts for the full set this file knows how to
 * verify — anything else is rejected fail-closed, see `verifyLiveIdentity` below).
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────
 * An OOB invitation carrying a `vc-proof-0` RealPersonIdentity (or SecurityClearance) VC
 * attachment can only ever be a PREVIEW (see vcValidation.ts's "NOTE ON HOLDER BINDING" doc
 * comment for the full history: a DID-string-equality check was tried and confirmed broken, then
 * a self-signed proof-of-possession JWT was tried and found insufficient — neither can prove
 * *live, current* possession before any connection exists, since OOB invitations are one-shot,
 * pre-connection artifacts with no live verifier-issued challenge available to sign).
 *
 * The agreed design instead lets the connection establish on the unverified preview alone, then
 * — once a live DIDComm connection exists — the accepting wallet sends a FRESH present-proof
 * request of its own back to the inviter, with a nonce/challenge the inviter cannot have
 * pre-computed, and verifies the (live-signed) response before upgrading the connection's trust
 * state from "unverified preview" to "verified".
 *
 * ── HOW THE REQUEST/RESPONSE ROUND TRIP WORKS ───────────────────────────────────────────────
 * `agent.initiatePresentationRequest(type, toDID, claims)` is an existing, public SDK primitive
 * (edge-agent/didcomm/Agent.ts) — it mints a fresh peer DID, builds a
 * `present-proof/3.0/request-presentation` message via the SDK's own `CreatePresentationRequest`
 * task (which generates its own internal nonce/challenge — not caller-supplied, but that's fine:
 * we never need to know the nonce ourselves, only that the SDK's own submission verifier checks
 * it — see below), and sends it over the connection. No hand-rolled DIDComm message JSON is
 * needed for the request side.
 *
 * The response arrives as an ordinary `present-proof/3.0/presentation` message in
 * `agent.pluto.getAllMessages()` — this file polls for it the same way
 * `actions/index.ts`'s `initiateVCHandshake()`/`ensureSenderVC()` already do for the (unrelated)
 * Security Clearance key-exchange handshake; that established, working pattern is mirrored here
 * rather than adding a new message-pickup listener. On the RESPONDING side (the inviter's
 * wallet), nothing new is needed either: an incoming `request-presentation` message is already
 * handled generically by the existing `acceptPresentationRequest` thunk (`actions/index.ts`),
 * which a human there approves from their Message inbox — this file's timeout is therefore
 * generous (minutes, not seconds) to allow for that live human-in-the-loop step.
 *
 * ── WHY agent.handlePresentation() ALONE IS NOT ENOUGH ──────────────────────────────────────
 * `agent.handlePresentation()` (→ Pollux's `verifyPresentationSubmissionJWT`) already verifies:
 * the nonce/challenge matches the exact request we sent (correlated internally by thread id), a
 * valid ES256K signature exists from SOME verification method of the signer DID, the inner VC's
 * signature is valid, and the inner VC's subject equals the outer presentation's signer. That is
 * necessary but not sufficient: `Pollux.JWT.verify()` accepts a signature from ANY entry in the
 * signer DID document's `verificationMethod` array — assertionMethod, keyAgreement, etc. — not
 * scoped to `authentication`. A holder proving LIVE control of their own identity DID must sign
 * with an `authentication` key specifically (DID-Auth convention; the same
 * `keyPurpose='authentication'` distinction already established for VP-JWT holder signatures in
 * `packages/service-access-didcomm/lib/jwtCrypto.js`). This file therefore adds its OWN
 * authentication-scoped signature check on top, reusing the verification loop (try each
 * `authentication` verification method's `publicKeyMultibase`) that used to live in the now-
 * removed `holderProofOfPossession.ts` — that loop was sound even though the self-signed-proof
 * scheme it was part of has been replaced; only the loop's plumbing is reused here, not the
 * removed file's invitation-time binding fields (aud/connectionDid/vcHash) or its TTL.
 *
 * This file additionally checks what neither the SDK helper nor the authentication-scoping check
 * cover on their own: that the live VC's ISSUER is trusted for its own claimed type (issuer
 * pinning — RealPersonIdentity pins a single hardcoded CA DID + schema id, mirroring
 * vcValidation.ts's own check on the preview; SecurityClearance, CertificationAuthorityIdentity, and
 * CompanyIdentity instead check the live credential's issuer against trustRegistry.ts's multi-issuer
 * `isTrustedIssuer(issuer, liveType)`, since those types are already issued from more than one
 * rotated CA DID and have no schema id pinned anywhere in this codebase — see `verifyLiveIdentity`'s
 * per-type branch below for exactly which check runs for which type), and — the actual
 * bait-and-switch defense this whole feature exists for — that the live VC's SUBJECT DID and
 * `uniqueId` match the identity shown in the original `vc-proof-0` preview, AND that the live VC's
 * own claimed type matches what the preview claimed (see the "type confusion" check below) —
 * without that, a malicious inviter could show one (genuine, copied) person's VC as an unverified
 * preview, then live-prove possession of a totally different DID/identity, or a validly-signed VC
 * of a different type than what was previewed, and still get upgraded to "verified".
 *
 * Fails closed throughout: any missing/malformed/mismatched/timed-out piece returns
 * `{ verified: false, error }`; nothing here ever throws past its own boundary (callers can
 * `await` this without a try/catch and safely treat a non-throwing `verified: false` as the only
 * failure signal), and a failure here is a soft "leave as unverified" state, never a reason to
 * tear down the connection that was already established on the preview.
 */

import SDK from '@hyperledger/identus-edge-agent-sdk';
import { base58btc } from 'multiformats/bases/base58';
import { base64url } from 'multiformats/bases/base64';
import { TRUSTED_REALPERSON_ISSUER, TRUSTED_REALPERSON_SCHEMA_ID, LiveVerifiableCredentialType, hasSecurityClearanceFields } from './vcValidation';
import { isTrustedIssuer } from './trustRegistry';
import { recordIdentityVerificationResult, WalletType } from './connectionMetadata';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min — generous; the inviter's side requires a human to approve (see file doc comment)
const POLL_INTERVAL_MS = 500;

const PRESENTATION_PIURI = 'https://didcomm.atalaprism.io/present-proof/3.0/presentation';

export interface LivePreviewIdentity {
  /** Subject DID shown in the pre-connection vc-proof-0 preview (VCValidationResult.subjectDID). */
  subjectDID: string;
  /** uniqueId shown in the preview's revealedData, if present — compared exactly when present. */
  uniqueId?: string;
  /**
   * Which credential type the pre-connection preview claimed to carry (see
   * vcValidation.ts's `detectLiveVerifiableIdentityType`). Drives which trust-anchoring branch
   * (issuer/schema pin vs. trust-registry pin) `verifyLiveIdentity` runs below, and is also
   * checked defense-in-depth against the LIVE credential's own claimed type — see the "type
   * confusion" check in `verifyLiveIdentity` — so a preview that claimed one type can't be
   * satisfied by a validly-signed live credential of a different type.
   */
  expectedType: LiveVerifiableCredentialType;
}

export interface LiveIdentityVerificationResult {
  verified: boolean;
  error?: string;
  // Only ever populated when verified === true, and sourced from the LIVE credential's own
  // credentialSubject — decoded and validated above (subject-DID/uniqueId bait-and-switch
  // anchors, issuer pinning, schema pinning where applicable) — never from the unverified
  // pre-connection vc-proof-0 preview. Carries WHATEVER fields the issuer put on that
  // credentialSubject (full object, not a hand-picked subset — e.g. photo/firstName/lastName/
  // uniqueId for RealPersonIdentity, or clearanceLevel/holderName/holderUniqueId/etc. for
  // SecurityClearance), so callers can render it through the same type-specific layout used for a
  // real held credential (see CredentialCardTypeLayouts.tsx's getCredentialLayout). Display-only
  // claims (no signing material, no reusable presentation); callers persisting these for later UI
  // use should still treat them as a point-in-time snapshot (see identityVerifiedAt) rather than
  // an ongoing revocation-checked guarantee.
  verifiedSubject?: Record<string, any>;
}

function decodeJwtPayload(jws: string): any {
  const parts = jws.split('.');
  if (parts.length !== 3) {
    throw new Error('Not a valid JWT (expected header.payload.signature)');
  }
  const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(b64));
}

// Tolerant of did:prism long-form vs short-form (did:prism:<hash> vs did:prism:<hash>:<key-material>).
// Mirrors company-admin-portal/server.js's prismDidsMatch(). Non-PRISM DIDs fall back to exact
// string equality.
function didsMatchTolerant(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const hashOf = (did: string) => (did.startsWith('did:prism:') ? did.split(':')[2] : null);
  const ha = hashOf(a);
  const hb = hashOf(b);
  return !!(ha && hb && ha === hb);
}

/**
 * Verify that `jws` was signed by `expectedSignerDID` using ONE OF THAT DID's `authentication`
 * verification methods specifically — never `assertionMethod` or any other verification
 * relationship. Reused (not re-derived) from the retired `holderProofOfPossession.ts`'s
 * `verifyHolderProofJWT` — see this file's top doc comment for why this scoping matters and why
 * `agent.handlePresentation()`'s own broader check isn't sufficient on its own.
 */
async function verifyAuthenticationSignature(
  agent: any,
  jws: string,
  expectedSignerDID: string
): Promise<{ ok: boolean; error?: string }> {
  if (!agent?.pollux || !agent?.castor || !agent?.apollo) {
    return { ok: false, error: 'Agent not fully initialized — cannot verify live presentation signature' };
  }

  let decoded: { header: any; payload: any; signature: string; data: string };
  try {
    decoded = await (agent.pollux as any).JWT.decode(jws);
  } catch (e: any) {
    return { ok: false, error: `Could not decode live presentation JWT: ${e?.message || e}` };
  }

  if (decoded.header?.alg !== 'ES256K') {
    return { ok: false, error: `Live presentation uses unsupported algorithm: ${decoded.header?.alg}` };
  }

  let signerDoc: any;
  try {
    signerDoc = await agent.castor.resolveDID(expectedSignerDID);
  } catch (e: any) {
    return { ok: false, error: `Could not resolve live presentation signer DID: ${e?.message || e}` };
  }

  const authVMs: any[] = signerDoc?.authentication || [];
  if (authVMs.length === 0) {
    return { ok: false, error: "Live presentation signer DID has no 'authentication' verification methods" };
  }

  let signatureBytes: Buffer;
  let dataBytes: Buffer;
  try {
    signatureBytes = Buffer.from(base64url.baseDecode(decoded.signature));
    dataBytes = Buffer.from(decoded.data);
  } catch (e: any) {
    return { ok: false, error: `Live presentation signature encoding is invalid: ${e?.message || e}` };
  }

  for (const vm of authVMs) {
    if (!vm.publicKeyMultibase) continue;
    try {
      const rawKey = base58btc.decode(vm.publicKeyMultibase);
      const publicKey = agent.apollo.createPublicKey({
        [SDK.Domain.KeyProperties.curve]: SDK.Domain.Curve.SECP256K1,
        [SDK.Domain.KeyProperties.type]: SDK.Domain.KeyTypes.EC,
        [SDK.Domain.KeyProperties.rawKey]: rawKey,
      });
      if (publicKey?.canVerify?.() && publicKey.verify(dataBytes, signatureBytes)) {
        return { ok: true };
      }
    } catch {
      // Try the next candidate authentication key.
    }
  }

  return { ok: false, error: "Live presentation signature does not verify against the signer's authentication key(s)" };
}

/**
 * Decode a DIDComm attachment's payload to a JS object regardless of whether the SDK encoded it
 * as `{ base64 }` (the case here — see AttachmentDescriptor.build: any string payload, which a
 * JSON.stringify'd presentation submission always is, goes through the base64 branch) or
 * `{ json }` (defensive fallback — not expected for this message type, but cheap to handle).
 */
function decodeAttachmentJson(attachment: any): any {
  const data = attachment?.data;
  if (!data) throw new Error('Attachment has no data');
  if ('base64' in data && typeof data.base64 === 'string') {
    // Buffer.from(str, 'base64') tolerates base64url characters too (Node behavior), matching
    // the existing decode pattern in actions/index.ts's initiateVCHandshake().
    return JSON.parse(Buffer.from(data.base64, 'base64').toString());
  }
  if ('json' in data) {
    return data.json;
  }
  throw new Error('Unrecognized attachment data encoding');
}

/**
 * Send a fresh, nonce-bound present-proof request to `peerDID` (the now-connected inviter) and
 * verify the live response against `expectedPreview` (the identity shown in the original
 * vc-proof-0 preview). See file-level doc comment for the full design and what is/isn't covered
 * by the SDK's own `agent.handlePresentation()`.
 *
 * Only ever succeeds for a credential type this file explicitly knows how to trust-check —
 * `expectedPreview.expectedType` selects the branch (RealPersonIdentity: single hardcoded
 * issuer+schema pin; SecurityClearance: multi-issuer trust-registry pin, no schema pin — see the
 * per-type block below for why). Anything else fails closed.
 *
 * Never throws — always resolves to a result object. Fails closed: `verified` is only ever
 * `true` if every check below passed.
 */
export async function verifyLiveIdentity(
  agent: any,
  peerDID: any, // SDK.Domain.DID — the established connection's remote (inviter) DID
  expectedPreview: LivePreviewIdentity,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<LiveIdentityVerificationResult> {
  try {
    if (!agent?.pollux || !agent?.castor || !agent?.apollo || !agent?.pluto) {
      return { verified: false, error: 'Agent not fully initialized — cannot perform live identity verification' };
    }
    if (!expectedPreview?.subjectDID) {
      return { verified: false, error: 'No previewed subject DID to verify the live presentation against' };
    }
    if (
      expectedPreview.expectedType !== 'RealPersonIdentity' &&
      expectedPreview.expectedType !== 'SecurityClearance' &&
      expectedPreview.expectedType !== 'CertificationAuthorityIdentity' &&
      expectedPreview.expectedType !== 'CompanyIdentity'
    ) {
      // Fail closed for any type this file doesn't explicitly know how to trust-check — see this
      // function's doc comment and vcValidation.ts's LiveVerifiableCredentialType.
      return { verified: false, error: `Live verification not supported for credential type: ${expectedPreview.expectedType}` };
    }

    const startTime = Date.now();
    const peerDIDStr = peerDID.toString();

    // Capture the SENT request's own thid so the response can be correlated to THIS specific
    // request explicitly (not merely "some recent response from this peer DID"). Without this,
    // a peer with more than one outstanding/past request-presentation exchange on this same
    // connection (e.g. a stale-but-genuinely-signed response to an EARLIER request, resent or
    // re-delivered) could be picked up by a from-DID+recency-only match and — since
    // agent.handlePresentation() validates a response's nonce against whichever stored request
    // its OWN thid points to, not specifically the one just sent — pass verification against
    // that earlier request's nonce instead of this one's. Explicit thid filtering closes that
    // gap. (This does not change the class of identity the check protects against — even an
    // accepted stale response is still cryptographically tied to the SAME preview subject DID
    // via the checks below — but it does remove a freshness/replay ambiguity worth closing.)
    let sentRequestThid: string | undefined;
    try {
      const sentRequest = await agent.initiatePresentationRequest(
        SDK.Domain.CredentialType.JWT,
        peerDID,
        { claims: {} } // Empty claims filter — a non-empty but pattern/enum/const-less filter
        // object breaks Pollux's validateInputDescriptor (same rationale documented in
        // actions/index.ts's initiateVCHandshake()); we validate the returned credential
        // ourselves below instead of constraining it up front.
      );
      sentRequestThid = sentRequest?.thid;
      if (!sentRequestThid) {
        return { verified: false, error: 'Live verification request was sent but has no thid to correlate a response against' };
      }
    } catch (e: any) {
      return { verified: false, error: `Failed to send live verification request: ${e?.message || e}` };
    }

    // Poll for the response — mirrors actions/index.ts's initiateVCHandshake()/ensureSenderVC(),
    // with the added thid check described above.
    const presentationResponse: any = await new Promise((resolve) => {
      const interval = setInterval(async () => {
        try {
          if (Date.now() - startTime > timeoutMs) {
            clearInterval(interval);
            resolve(null);
            return;
          }
          const allMessages = await agent.pluto.getAllMessages();
          const found = allMessages.find((msg: any) => {
            if (msg.piuri !== PRESENTATION_PIURI) return false;
            if (msg.direction !== SDK.Domain.MessageDirection.RECEIVED) return false;
            if (msg.from?.toString() !== peerDIDStr) return false;
            if (msg.thid !== sentRequestThid) return false;
            const msgTimeRaw = typeof msg.createdTime === 'number' ? msg.createdTime : 0;
            const msgTime = msgTimeRaw === 0 ? 0 : (msgTimeRaw < 10000000000 ? msgTimeRaw * 1000 : msgTimeRaw);
            // Accept messages with no usable timestamp while actively polling (same tolerance as
            // initiateVCHandshake()); otherwise require it to be from after we started.
            return msgTime === 0 || msgTime >= startTime;
          });
          if (found) {
            clearInterval(interval);
            resolve(found);
          }
        } catch {
          clearInterval(interval);
          resolve(null);
        }
      }, POLL_INTERVAL_MS);
    });

    if (!presentationResponse) {
      return { verified: false, error: 'No live presentation response received before timeout' };
    }

    if (!presentationResponse.attachments || presentationResponse.attachments.length !== 1) {
      return { verified: false, error: 'Live presentation response has an unexpected number of attachments' };
    }

    // Layer 1: the SDK's own generic verifier. Checks nonce/challenge against the exact request
    // we just sent (thread-correlated internally), a broadly-valid ES256K signature, inner VC
    // signature validity, revocation, and input-descriptor constraints.
    try {
      const sdkVerified = await agent.handlePresentation(SDK.Presentation.fromMessage(presentationResponse));
      if (!sdkVerified) {
        return { verified: false, error: 'Live presentation failed SDK verification (nonce, signature, or definition mismatch)' };
      }
    } catch (e: any) {
      return { verified: false, error: `Live presentation SDK verification threw: ${e?.message || e}` };
    }

    // Decode the submission ourselves for the checks the SDK layer above does not perform.
    let submission: any;
    try {
      submission = decodeAttachmentJson(presentationResponse.attachments[0]);
    } catch (e: any) {
      return { verified: false, error: `Could not decode live presentation attachment: ${e?.message || e}` };
    }

    const vpJws: string | undefined = Array.isArray(submission?.verifiablePresentation)
      ? submission.verifiablePresentation[0]
      : undefined;
    if (!vpJws || typeof vpJws !== 'string') {
      return { verified: false, error: 'Live presentation submission has no verifiablePresentation JWT' };
    }

    let vpPayload: any;
    try {
      vpPayload = decodeJwtPayload(vpJws);
    } catch (e: any) {
      return { verified: false, error: `Could not decode outer live presentation JWT: ${e?.message || e}` };
    }

    const signerDID: string | undefined = vpPayload?.iss;
    if (!signerDID) {
      return { verified: false, error: 'Live presentation JWT has no iss claim' };
    }

    // Bait-and-switch anchor #1: the live signer must be the SAME identity shown in the preview.
    if (!didsMatchTolerant(signerDID, expectedPreview.subjectDID)) {
      return {
        verified: false,
        error: `Live presentation signer (${signerDID}) does not match the previewed identity's subject DID (${expectedPreview.subjectDID})`
      };
    }

    // Layer 2: authentication-scoped signature check (see file-level doc comment).
    const authCheck = await verifyAuthenticationSignature(agent, vpJws, signerDID);
    if (!authCheck.ok) {
      return { verified: false, error: `Live presentation is not validly signed by an 'authentication' key: ${authCheck.error}` };
    }

    const nestedVcJws: string | undefined = Array.isArray(vpPayload?.vp?.verifiableCredential)
      ? vpPayload.vp.verifiableCredential[0]
      : undefined;
    if (!nestedVcJws || typeof nestedVcJws !== 'string') {
      return { verified: false, error: 'Live presentation has no nested verifiableCredential' };
    }

    let vcPayload: any;
    try {
      vcPayload = decodeJwtPayload(nestedVcJws);
    } catch (e: any) {
      return { verified: false, error: `Could not decode nested live credential JWT: ${e?.message || e}` };
    }

    const credentialSubject = vcPayload?.vc?.credentialSubject || {};
    const liveSubjectDID: string | undefined = vcPayload?.sub || credentialSubject?.id;

    // Bait-and-switch anchor #2: the live CREDENTIAL's own subject must also match the preview
    // (defense in depth alongside the outer-signer check above — catches a VC whose subject
    // differs from its presentation's iss, which agent.handlePresentation() already treats as
    // invalid, but re-checked here against OUR preview anchor specifically, not just internal
    // self-consistency).
    if (!liveSubjectDID || !didsMatchTolerant(liveSubjectDID, expectedPreview.subjectDID)) {
      return { verified: false, error: "Live credential's subject DID does not match the previewed identity" };
    }

    if (expectedPreview.uniqueId && credentialSubject.uniqueId !== expectedPreview.uniqueId) {
      return { verified: false, error: "Live credential's uniqueId does not match the previewed identity — possible bait-and-switch" };
    }

    // TYPE CONFUSION / SHAPE CHECK: determine what type the LIVE credentialSubject actually is —
    // independent of what the preview claimed. A mismatch against expectedPreview.expectedType is
    // the actual "does the live credential type match what was previewed" defense-in-depth check
    // this task exists for: the preview claimed one type, but the live, validly-signed credential
    // turned out to be a different one (or neither) — even though every other anchor (signer,
    // subject DID, uniqueId) matched.
    //
    // The issuer's own explicit `credentialType` field is treated as AUTHORITATIVE when present —
    // every CA-issued RealPersonIdentity and SecurityClearance VC in this codebase sets it (see
    // certification-authority/server.js's credential-issuance code, confirmed for both types) —
    // rather than OR'd together with the looser field-shape fallback as an alternative signal.
    // This matters because hasSecurityClearanceFields() only requires ANY ONE of four generic
    // field names (clearanceLevel/clearanceId/publicKeyFingerprint/securityLevel): with a plain OR,
    // a hypothetical future credential type reusing one of those names while declaring its OWN,
    // different credentialType could misclassify as SecurityClearance here. Making the declared
    // field authoritative when present closes that gap; the field-shape checks below only run as a
    // fallback for the credentialType-less case (which vcValidation.ts's preview-time
    // detectKnownSchemas() already tolerates, so live verification stays consistent with it).
    const declaredType = credentialSubject.credentialType;
    let liveType: LiveVerifiableCredentialType | null;
    if (
      declaredType === 'RealPersonIdentity' ||
      declaredType === 'SecurityClearance' ||
      declaredType === 'CertificationAuthorityIdentity' ||
      declaredType === 'CompanyIdentity'
    ) {
      liveType = declaredType;
    } else {
      const looksLikeRealPerson =
        !!(credentialSubject.firstName && credentialSubject.lastName && credentialSubject.uniqueId);
      const looksLikeSecurityClearance = hasSecurityClearanceFields(credentialSubject);
      // Field-signature fallbacks for the two new types — deliberately mirror
      // credentialTypeDetector.ts's getCredentialType() fallback checks exactly
      // (website+issuedDate+!employeeId for CertificationAuthorityIdentity;
      // companyName+registrationNumber for CompanyIdentity) so the live-time shape check never
      // drifts from the display-time one, kept hand-rolled (not imported) to match this block's
      // existing style for RealPerson/SecurityClearance above.
      const looksLikeCA =
        !!(credentialSubject.website && credentialSubject.issuedDate && !credentialSubject.employeeId);
      const looksLikeCompany =
        !!(credentialSubject.companyName && credentialSubject.registrationNumber);
      liveType = looksLikeRealPerson
        ? 'RealPersonIdentity'
        : looksLikeSecurityClearance
        ? 'SecurityClearance'
        : looksLikeCA
        ? 'CertificationAuthorityIdentity'
        : looksLikeCompany
        ? 'CompanyIdentity'
        : null;
    }

    if (liveType !== expectedPreview.expectedType) {
      return { verified: false, error: 'Live credential type does not match the previewed type — possible bait-and-switch' };
    }

    // Issuer/schema trust-anchoring — branches per type, since RealPersonIdentity and
    // SecurityClearance use different trust models (see file-level doc comment). By this point
    // `liveType === expectedPreview.expectedType`, so exactly one of these two branches runs.
    const vcIssuer: string | undefined = vcPayload?.iss || vcPayload?.vc?.issuer;
    if (liveType === 'RealPersonIdentity') {
      // Issuer pinning — mirrors vcValidation.ts's preview-time check.
      if (!vcIssuer || vcIssuer !== TRUSTED_REALPERSON_ISSUER) {
        return { verified: false, error: `Live credential issuer not trusted: expected CA DID, got ${vcIssuer}` };
      }

      // Schema pinning — defense in depth alongside issuer pinning: the trusted CA DID above
      // proves WHO signed the credential, not WHICH schema it was issued under. Without this, a
      // credential validly signed by the same CA key but issued under a different (e.g.
      // older/deprecated, non-photo-carrying) RealPerson schema generation would still pass the
      // issuer check. Checked in both JWT-VC (`vc.credentialSchema`) and embedded-VC (top-level
      // `credentialSchema`) shapes, same as credentialSchemaExtractor.ts's extraction fallback.
      const vcCredentialSchema = vcPayload?.vc?.credentialSchema ?? vcPayload?.credentialSchema;
      const vcSchemaEntry = Array.isArray(vcCredentialSchema) ? vcCredentialSchema[0] : vcCredentialSchema;
      const vcSchemaId: string | undefined = vcSchemaEntry?.id;
      if (!vcSchemaId || vcSchemaId !== TRUSTED_REALPERSON_SCHEMA_ID) {
        return { verified: false, error: `Live credential schema not trusted: expected RealPerson schema, got ${vcSchemaId}` };
      }
    } else {
      // liveType is SecurityClearance, CertificationAuthorityIdentity, or CompanyIdentity — the
      // only other branches `liveType` can hold here. All three use issuer pinning via the
      // multi-issuer trust registry — each is already issued from more than one rotated CA DID
      // (see trustRegistry.ts), unlike RealPersonIdentity's single hardcoded issuer above. No
      // schema-id pin exists for any of these three types anywhere in this codebase (the one
      // schema-GUID map entry in credentialSchemaExtractor.ts is a display hint only, not a
      // security control — see CLAUDE.md task notes) — issuer-registry pinning plus the shape
      // check above (looksLikeSecurityClearance/looksLikeCA/looksLikeCompany) are each type's
      // full trust anchor.
      if (!vcIssuer || !isTrustedIssuer(vcIssuer, liveType)) {
        return { verified: false, error: `Live credential issuer not trusted for ${liveType}: ${vcIssuer}` };
      }
    }

    return {
      verified: true,
      // Full decoded credentialSubject — whatever fields the issuer actually put there, not a
      // hand-picked subset (see LiveIdentityVerificationResult.verifiedSubject's doc comment).
      verifiedSubject: credentialSubject,
    };
  } catch (e: any) {
    // Belt-and-braces: this function must never throw past its own boundary (see file doc
    // comment) — any unexpected error anywhere above is treated as a failed (not thrown) result.
    return { verified: false, error: `Unexpected error during live identity verification: ${e?.message || e}` };
  }
}

/**
 * Shared "verify + record" half of the live-identity round trip: marks `hostDID`'s
 * ConnectionMetadata 'pending', runs `verifyLiveIdentity` against `peerDID`, then persists the
 * outcome ('verified'/'failed', error, timestamp, and — only on success — the live
 * credentialSubject) via `recordIdentityVerificationResult`. Never throws (mirrors
 * `verifyLiveIdentity`'s own contract); always resolves to the same result object it just
 * recorded, so a caller can layer follow-up behavior (e.g. OOB.tsx's "send our own identity back
 * once the inviter is verified") on top of it without re-deriving anything.
 *
 * This is the exact "record pending → verify → record result" sequence that used to be
 * hand-duplicated in OOB.tsx's `performLiveIdentityVerificationAndMaybeRespond` and
 * ConnectionRequest.tsx's `performLiveIdentityVerificationOfInvitee` — both now delegate to this
 * function instead. Callers remain responsible for anything specific to their own flow: resolving
 * `subjectDID`/`uniqueId` from whatever preview shape they have on hand (this function takes them
 * as already-resolved, required strings — it performs no preview parsing itself), deciding
 * whether to run this at all, and any follow-up action once the result is known. Like
 * `verifyLiveIdentity`, this is deliberately not awaited by any of its callers — see this file's
 * top doc comment and each call site's own comment for why.
 */
export async function verifyAndRecordLiveIdentity(
  agent: any,
  hostDID: string,
  peerDID: any, // SDK.Domain.DID — passed straight through to verifyLiveIdentity
  walletType: WalletType,
  subjectDID: string,
  uniqueId: string | undefined,
  expectedType: LiveVerifiableCredentialType,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<LiveIdentityVerificationResult> {
  try {
    recordIdentityVerificationResult(hostDID, walletType, { identityVerificationStatus: 'pending' });
  } catch (e) {
    console.warn('⚠️ [LIVE-VERIFY] Failed to record pending status (non-fatal):', e);
  }

  let result: LiveIdentityVerificationResult;
  try {
    result = await verifyLiveIdentity(agent, peerDID, { subjectDID, uniqueId, expectedType }, timeoutMs);
  } catch (e: any) {
    // verifyLiveIdentity is documented to never throw, but this call site treats it as
    // fail-closed regardless, in case that contract is ever violated.
    result = { verified: false, error: e?.message || String(e) };
  }

  try {
    recordIdentityVerificationResult(hostDID, walletType, {
      identityVerificationStatus: result.verified ? 'verified' : 'failed',
      identityVerificationError: result.verified ? undefined : result.error,
      identityVerifiedAt: result.verified ? Date.now() : undefined,
      // Sourced from the LIVE, cryptographically-verified credentialSubject — never from any
      // unverified preview. See ConnectionMetadata.verifiedCredentialSubject's doc comment.
      verifiedCredentialSubject: result.verified ? result.verifiedSubject : undefined,
    });
  } catch (e) {
    console.error('❌ [LIVE-VERIFY] Failed to persist live verification result:', e);
  }

  if (result.verified) {
    console.log(`✅ [LIVE-VERIFY] ${expectedType} live-verified for connection ${hostDID.substring(0, 24)}...`);
  } else {
    console.warn(`⚠️ [LIVE-VERIFY] ${expectedType} live verification FAILED for connection ${hostDID.substring(0, 24)}...:`, result.error);
  }

  return result;
}
