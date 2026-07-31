import { DisclosureLevel, SelectiveDisclosure, RealPersonVCData, DISCLOSURE_PRESETS } from '../types/invitations';
import { extractCredentialSubject } from './vcValidation';

export function createSelectiveDisclosure(
  credential: any,
  selectedFields: string[],
  proofLevel: DisclosureLevel
): SelectiveDisclosure {
  const credentialSubject = extractCredentialSubject(credential);
  const allFields = Object.keys(credentialSubject);
  const hiddenFields = allFields.filter(field => !selectedFields.includes(field));

  return {
    credential,
    revealedFields: selectedFields,
    proofLevel,
    hiddenFields,
    timestamp: new Date().toISOString()
  };
}

export function applySelectiveDisclosure(
  credential: any,
  revealedFields: string[]
): RealPersonVCData {
  const credentialSubject = extractCredentialSubject(credential);
  const revealedData: RealPersonVCData = {};

  // Only include fields that are in the revealed list
  revealedFields.forEach(field => {
    if (credentialSubject[field] !== undefined) {
      revealedData[field] = credentialSubject[field];
    }
  });

  return revealedData;
}

export function getFieldsForDisclosureLevel(level: DisclosureLevel): string[] {
  return DISCLOSURE_PRESETS[level].fields;
}

export function createVCProofAttachment(
  credential: any,
  selectedFields: string[],
  proofLevel: DisclosureLevel
): string {
  // Prefer embedding the raw JWT string so the receiver can cryptographically
  // verify the ES256K signature. Without the raw JWT, the issuer field is
  // just copied data that anyone could forge.

  // A valid JWS has exactly 3 base64url parts separated by dots and starts with eyJ (JSON header)
  const isRawJws = (s: any): s is string =>
    typeof s === 'string' && s.startsWith('eyJ') && s.split('.').length === 3;

  let rawJwt: string | null = null;

  if (typeof credential.toStorable === 'function') {
    try {
      const storable = credential.toStorable();
      // SDK stores the raw JWS in .id (the jti claim = originalString passed to constructor).
      // .credentialData is JSON.stringify({ id: rawJWS, vc: {...}, iss: "...", ... }) — NOT the JWS.
      if (isRawJws(storable.id)) rawJwt = storable.id;
      else if (isRawJws(storable.credentialData)) rawJwt = storable.credentialData;
    } catch (_) {}
  }
  // Fallback: plain object from Pluto with id = raw JWS
  if (!rawJwt && isRawJws(credential.id)) rawJwt = credential.id;
  if (!rawJwt && isRawJws(credential.credentialData)) rawJwt = credential.credentialData;

  if (rawJwt) {
    // Embed raw JWT — preserves ES256K signature for verification on the receiver side
    const vcProof = {
      jwt: rawJwt,
      disclosedFields: selectedFields,
      proofLevel,
    };
    return btoa(JSON.stringify(vcProof));
  }

  // Fallback for non-JWT credentials: synthetic display-only blob.
  // Marked _unverifiable so the receiver knows no signature check is possible.
  const credentialSubject = extractCredentialSubject(credential);
  const filteredSubject: any = {};
  selectedFields.forEach(field => {
    if (credentialSubject[field] !== undefined) {
      filteredSubject[field] = credentialSubject[field];
    }
  });

  const vcProof = {
    "@context": credential["@context"] || ["https://www.w3.org/2018/credentials/v1"],
    type: credential.type || ["VerifiableCredential", "RealPerson"],
    credentialSubject: filteredSubject,
    issuer: credential.issuer,
    issuanceDate: credential.issuanceDate || new Date().toISOString(),
    expirationDate: credential.expirationDate,
    _unverifiable: true,
  };

  return btoa(JSON.stringify(vcProof));
}

export function parseVCProofAttachment(base64Proof: string): any {
  try {
    const decoded = atob(base64Proof);
    return JSON.parse(decoded);
  } catch (error) {
    console.error('Failed to parse VC proof attachment:', error);
    return null;
  }
}

export function createVCRequestAttachment(
  vcType: 'RealPerson' | 'SecurityClearance',
  requiredFields: string[]
): string {
  // Create a presentation request structure following DIDComm format
  const presentationRequest = {
    "@context": [
      "https://www.w3.org/2018/credentials/v1",
      "https://identity.foundation/presentation-exchange/v2"
    ],
    "type": ["VerifiablePresentationRequest"],
    "presentation_definition": {
      "id": `${vcType.toLowerCase()}-request-${Date.now()}`,
      "name": `${vcType} Credential Request`,
      "purpose": `Please provide your ${vcType} credential for verification`,
      "input_descriptors": [
        {
          "id": `${vcType.toLowerCase()}-descriptor`,
          "name": `${vcType} Credential`,
          "purpose": `${vcType} verification required`,
          "constraints": {
            "fields": requiredFields.map(field => ({
              "path": [`$.credentialSubject.${field}`, `$.vc.credentialSubject.${field}`],
              "purpose": `${field} is required for verification`
            }))
          }
        }
      ]
    },
    "credential_type": vcType,
    "required_fields": requiredFields,
    "created": new Date().toISOString()
  };

  // Return base64 encoded request
  return btoa(JSON.stringify(presentationRequest));
}

export function parseVCRequestAttachment(base64Request: string): any {
  try {
    const decoded = atob(base64Request);
    return JSON.parse(decoded);
  } catch (error) {
    console.error('Failed to parse VC request attachment:', error);
    return null;
  }
}

export function getRequiredFieldsForVCType(vcType: 'RealPerson' | 'SecurityClearance'): string[] {
  if (vcType === 'RealPerson') {
    return ['firstName', 'lastName', 'uniqueId', 'dateOfBirth', 'gender'];
  } else if (vcType === 'SecurityClearance') {
    return ['clearanceLevel', 'clearanceId', 'issuedAt', 'expiresAt', 'publicKeyFingerprint'];
  }
  return [];
}

export function validateSelectiveDisclosure(
  credential: any,
  revealedFields: string[]
): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];
  const credentialSubject = extractCredentialSubject(credential);

  // Check if revealed fields exist in the credential
  revealedFields.forEach(field => {
    if (credentialSubject[field] === undefined) {
      errors.push(`Revealed field '${field}' not found in credential`);
    }
  });

  // Ensure at least one field is revealed
  if (revealedFields.length === 0) {
    errors.push('At least one field must be revealed');
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}