/**
 * Connection <-> Credential matching
 *
 * There is no stored field anywhere (SDK/Pluto schema, Redux state) linking a credential to
 * the connection it was issued/received over. An earlier version of this module matched
 * `credential.subject === connection.receiver` — empirically confirmed (via live wallet
 * diagnostics) to NEVER actually match: `credential.subject` is a stable `did:prism:...`
 * identity DID (who the credential is ABOUT), while `connection.receiver` is a per-connection
 * `did:peer:2...` DID. Different DID methods, never equal.
 *
 * The mechanism that actually works, already proven live in this exact codebase
 * (`actions/index.ts` ~line 420-424, used today to persist `isCAConnection` connection
 * metadata): match on the DIDComm `issue-credential` message that delivered the credential —
 * its `from` field is the issuer's DID for THAT connection, which does equal
 * `connection.receiver`. The credential's raw JWT is recoverable from that same message's
 * attachment (`data.base64`, decoded — the exact same extraction already used for presentation
 * attachments in `actions/index.ts` ~line 1099-1101), and `SDK.Domain.Credential.id` is itself
 * the raw JWT string, so the two can be matched by exact string equality.
 *
 * `messages` is optional (defaults to none matching) so existing callers that don't have
 * `app.messages` handy keep their current behavior rather than being forced to thread a new
 * parameter through immediately.
 */

import SDK from "@hyperledger/identus-edge-agent-sdk";
import { getCredentialSubject } from './credentialTypeDetector';

// Mirrors actions/index.ts's own issue-credential piuri check exactly, so this stays in sync
// with whichever protocol variants that ingestion code treats as "a credential was issued."
const ISSUE_CREDENTIAL_PIURIS = new Set([
  'https://didcomm.org/issue-credential/3.0/issue-credential',
  'https://didcomm.atalaprism.io/issue-credential/3.0/issue-credential',
]);

function decodeBase64Attachment(base64: string): string | null {
  try {
    const decoded = atob(base64);
    return decoded.split('.').length === 3 ? decoded : null; // only care about JWT-shaped payloads
  } catch {
    return null;
  }
}

/** Raw JWT strings of every credential issued by `connectionReceiverDID` on this connection. */
function getIssuedJWTsFromConnection(
  connectionReceiverDID: string,
  messages: SDK.Domain.Message[]
): Set<string> {
  const jwts = new Set<string>();

  for (const msg of messages) {
    if (!ISSUE_CREDENTIAL_PIURIS.has(msg.piuri ?? '')) continue;
    if (msg.from?.toString() !== connectionReceiverDID) continue;

    for (const attachment of msg.attachments ?? []) {
      const base64 = (attachment as any)?.data?.base64;
      if (typeof base64 !== 'string') continue;
      const jwt = decodeBase64Attachment(base64);
      if (jwt) jwts.add(jwt);
    }
  }

  return jwts;
}

/**
 * All stored credentials that arrived via the issue-credential exchange on this connection.
 * Order is whatever order `credentials` was given in.
 */
export function getCredentialsForConnection(
  connectionReceiverDID: string | null | undefined,
  credentials: SDK.Domain.Credential[] | null | undefined,
  messages: SDK.Domain.Message[] | null | undefined = []
): SDK.Domain.Credential[] {
  if (!connectionReceiverDID || !credentials || credentials.length === 0 || !messages || messages.length === 0) {
    return [];
  }

  const issuedJWTs = getIssuedJWTsFromConnection(connectionReceiverDID.trim(), messages);
  if (issuedJWTs.size === 0) return [];

  return credentials.filter(cred => {
    try {
      return issuedJWTs.has(cred.id);
    } catch {
      return false;
    }
  });
}

/**
 * Same match, narrowed to credentials that actually carry a `photo` claim — today that's only
 * RealPersonIdentity and EmployeeRole, but this makes no assumption about which types those are;
 * it just checks the field.
 */
export function getPhotoBearingCredentialsForConnection(
  connectionReceiverDID: string | null | undefined,
  credentials: SDK.Domain.Credential[] | null | undefined,
  messages: SDK.Domain.Message[] | null | undefined = []
): SDK.Domain.Credential[] {
  return getCredentialsForConnection(connectionReceiverDID, credentials, messages).filter(cred => {
    try {
      return !!getCredentialSubject(cred)?.photo;
    } catch {
      return false;
    }
  });
}
