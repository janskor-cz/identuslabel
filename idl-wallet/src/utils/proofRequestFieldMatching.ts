import SDK from "@hyperledger/identus-edge-agent-sdk";
import { extractCredentialSubject } from "./vcValidation";

type PresentationDefinition = SDK.Domain.PresentationExchangeDefinitionRequest["presentation_definition"];

/**
 * Flattens every input_descriptor's fields into one list. Some issuers emit one
 * input_descriptor per requested claim rather than one descriptor with many fields —
 * reading only input_descriptors[0] silently drops the rest in that shape.
 *
 * Note: this does not evaluate DIF PE `submission_requirements` (rules that group
 * descriptors and require e.g. "1 of 2") — the SDK's PresentationExchangeDefinitionRequest
 * type doesn't model that field, and none of this project's own proof-request construction
 * sites emit it (each schema request is always exactly one flat input_descriptor).
 */
export function aggregateRequestedFields(presentationDefinition?: PresentationDefinition): SDK.Domain.InputField[] {
  const descriptors = presentationDefinition?.input_descriptors ?? [];
  const fields = descriptors.flatMap((d) => d?.constraints?.fields ?? []);
  console.log('[ProofFieldMatching] input_descriptors count:', descriptors.length, 'aggregated fields:', JSON.stringify(fields));
  return fields;
}

/**
 * Pulls the DIF Presentation Exchange required field list straight out of a
 * RequestPresentation message, bypassing the fragile goalCode/goal/comment
 * string-guessing that's used elsewhere to infer "which schema was requested" —
 * this is the actual, SDK-parsed constraint data the issuer sent.
 */
export function extractRequestedFields(requestMessage: SDK.Domain.Message): SDK.Domain.InputField[] {
  try {
    const requestPresentationMessage = SDK.RequestPresentation.fromMessage(requestMessage);
    const requestPresentation = requestPresentationMessage.decodedAttachments.at(0);
    console.log('[ProofFieldMatching] presentation_definition:', JSON.stringify(requestPresentation?.presentation_definition));
    return aggregateRequestedFields(requestPresentation?.presentation_definition);
  } catch (e) {
    console.log('[ProofFieldMatching] extraction failed:', e instanceof Error ? e.message : String(e));
    return [];
  }
}

/**
 * Resolves a DIF PE JSONPath (e.g. "$.credentialSubject.clearanceLevel",
 * "$.vc.credentialSubject.type[0]") against `subject` — the object already returned by
 * extractCredentialSubject, i.e. the credentialSubject content itself. Strips the leading
 * "$", any "vc"/"credentialSubject" wrapper segments (since `subject` already starts one
 * level in), and converts bracket array indices to plain segments before walking the path.
 * Taking only the final dot-segment (the previous approach) breaks on any path deeper than
 * one level and can't address array elements at all.
 */
function resolveJsonPath(subject: unknown, path: string): unknown {
  const normalized = path.replace(/^\$\.?/, '').replace(/\[(\d+)\]/g, '.$1');
  const segments = normalized.split('.').filter(Boolean);
  while (segments.length > 1 && (segments[0] === 'vc' || segments[0] === 'credentialSubject')) {
    segments.shift();
  }

  let current: unknown = subject;
  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Narrows a credential picker down to credentials that actually satisfy the proof
 * request's required fields, instead of listing every held credential and making
 * the user guess which one matches (e.g. RealPerson vs SecurityClearance — two VC
 * types that can share overlapping field names like firstName/lastName).
 */
export function filterCredentialsByRequestedFields<T>(
  credentials: T[],
  fields: SDK.Domain.InputField[]
): T[] {
  if (!fields || fields.length === 0) return credentials;

  const requiredFields = fields.filter((field) => !field.optional);
  if (requiredFields.length === 0) return credentials;

  const matching = credentials.filter((credential) => {
    try {
      const subject = extractCredentialSubject(credential);
      return requiredFields.every((field) => {
        const paths = field.path ?? [];
        return paths.some((p) => {
          const value = resolveJsonPath(subject, p);
          return value !== undefined && value !== null;
        });
      });
    } catch (e) {
      console.warn('[ProofFieldMatching] credential subject extraction failed, excluding from matches:', e instanceof Error ? e.message : String(e));
      return false;
    }
  });

  console.log('[ProofFieldMatching] matched', matching.length, 'of', credentials.length, 'credentials against', requiredFields.length, 'required fields');

  // Deliberately no fallback to the unfiltered list: the proof request named specific
  // required fields, so a credential that doesn't satisfy them must not be offered as if
  // it did — falling back to "show everything" here is what let mismatched credentials
  // (e.g. RealPerson offered for a SecurityClearance request) reach the accept dropdown.
  return matching;
}
