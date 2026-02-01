/**
 * Centralized invitation parsing utilities with comprehensive format support
 * Handles DIDComm v2.0, legacy formats, and SDK compatibility layers
 */

import { safeBase64ParseJSON, safeDecodeURLParameter, robustBase64Decode } from './base64Utils';

/**
 * Supported invitation formats
 */
export type InvitationFormat =
  | 'didcomm-v2.0'      // Standard DIDComm v2.0 invitation
  | 'sdk-compatible'    // SDK v6.6.0 compatible format
  | 'legacy-peer'       // Legacy peer DID format
  | 'legacy-vcproof'    // Legacy with VC proof parameter
  | 'malformed'         // Invalid or corrupted format
  | 'unknown';          // Unrecognized format

/**
 * Parsed invitation result
 */
export interface ParsedInvitation {
  format: InvitationFormat;
  isValid: boolean;
  data?: any;
  error?: string;
  metadata?: {
    hasAttachments?: boolean;
    hasVCProof?: boolean;
    connectionLabel?: string;
    from?: string;
    to?: string;
  };
}

/**
 * VC Proof attachment information
 */
export interface VCProofAttachment {
  isPresent: boolean;
  data?: any;
  validationResult?: any;
  error?: string;
}

/**
 * Comprehensive invitation parsing result
 */
export interface InvitationParseResult {
  invitation: ParsedInvitation;
  vcProof: VCProofAttachment;
  sdkCompatible: boolean;
  recommendedAction: 'sdk_process' | 'manual_process' | 'reject' | 'request_new';
}

/**
 * Detect invitation format from URL or invitation data
 * @param invitationUrl - Invitation URL or raw data
 * @returns Detected format
 */
export function detectInvitationFormat(invitationUrl: string): InvitationFormat {
  try {
    console.log('🔍 Detecting invitation format...');

    // Check if it's a URL
    if (!invitationUrl.startsWith('http://') && !invitationUrl.startsWith('https://')) {
      console.log('📄 Raw invitation data detected');
      return 'legacy-peer';
    }

    const urlObj = new URL(invitationUrl);
    const oobParam = urlObj.searchParams.get('_oob');
    const vcProofParam = urlObj.searchParams.get('vcproof');

    // Check for VC proof parameter (legacy format)
    if (vcProofParam) {
      console.log('📋 Legacy VC proof format detected');
      return 'legacy-vcproof';
    }

    // Check for OOB parameter
    if (!oobParam) {
      console.log('❌ No _oob parameter found');
      return 'malformed';
    }

    // Try to parse the OOB parameter
    const parseResult = safeBase64ParseJSON(oobParam, 'invitation format detection');
    if (!parseResult.isValid) {
      console.log('🔄 Treating as legacy peer DID format');
      return 'legacy-peer';
    }

    const invitation = parseResult.data;

    // Check for DIDComm v2.0 format
    if (invitation.type === "https://didcomm.org/out-of-band/2.0/invitation") {
      console.log('✅ DIDComm v2.0 format detected');
      return 'didcomm-v2.0';
    }

    // Check for SDK compatible format
    if (invitation.from && invitation.body) {
      console.log('🔧 SDK compatible format detected');
      return 'sdk-compatible';
    }

    // Check for old @type format
    if (invitation["@type"]) {
      console.log('⚠️ Legacy @type format detected');
      return 'legacy-peer';
    }

    console.log('❓ Unknown invitation format');
    return 'unknown';

  } catch (error) {
    console.error('🔴 Format detection failed:', error.message);
    return 'malformed';
  }
}

/**
 * Parse DIDComm v2.0 invitation
 * @param invitationUrl - Invitation URL
 * @returns Parsed invitation result
 */
export function parseDIDCommV2Invitation(invitationUrl: string): ParsedInvitation {
  try {
    console.log('📋 Parsing DIDComm v2.0 invitation...');

    const urlObj = new URL(invitationUrl);
    const oobParam = urlObj.searchParams.get('_oob');

    if (!oobParam) {
      return {
        format: 'malformed',
        isValid: false,
        error: 'Missing _oob parameter in DIDComm v2.0 invitation'
      };
    }

    const parseResult = safeBase64ParseJSON(oobParam, 'DIDComm v2.0 invitation');
    if (!parseResult.isValid) {
      return {
        format: 'malformed',
        isValid: false,
        error: parseResult.error
      };
    }

    const invitation = parseResult.data;

    // Validate required fields
    if (!invitation.type || !invitation.from) {
      return {
        format: 'malformed',
        isValid: false,
        error: 'Missing required fields (type, from) in DIDComm v2.0 invitation'
      };
    }

    const metadata = {
      hasAttachments: !!(invitation.attachments && invitation.attachments.length > 0),
      hasVCProof: false, // Will be determined by attachment parsing
      connectionLabel: invitation.label,
      from: invitation.from,
      to: invitation.to
    };

    console.log('✅ Successfully parsed DIDComm v2.0 invitation');
    return {
      format: 'didcomm-v2.0',
      isValid: true,
      data: invitation,
      metadata
    };

  } catch (error) {
    console.error('🔴 DIDComm v2.0 parsing failed:', error.message);
    return {
      format: 'malformed',
      isValid: false,
      error: `DIDComm v2.0 parsing failed: ${error.message}`
    };
  }
}

/**
 * Parse legacy invitation format
 * @param invitationUrl - Invitation URL or raw data
 * @returns Parsed invitation result
 */
export function parseLegacyInvitation(invitationUrl: string): ParsedInvitation {
  try {
    console.log('⚠️ Parsing legacy invitation format...');

    // Handle raw DID string
    if (!invitationUrl.startsWith('http://') && !invitationUrl.startsWith('https://')) {
      console.log('📄 Processing raw DID string');
      return {
        format: 'legacy-peer',
        isValid: true,
        data: { from: invitationUrl, type: 'legacy' },
        metadata: {
          hasAttachments: false,
          hasVCProof: false,
          from: invitationUrl
        }
      };
    }

    const urlObj = new URL(invitationUrl);
    const oobParam = urlObj.searchParams.get('_oob');

    if (oobParam) {
      // Try to parse as base64 encoded data
      try {
        const decoded = robustBase64Decode(oobParam, 'legacy invitation');
        const invitation = JSON.parse(decoded);

        return {
          format: 'legacy-peer',
          isValid: true,
          data: invitation,
          metadata: {
            hasAttachments: false,
            hasVCProof: false,
            connectionLabel: invitation.label,
            from: invitation.from || invitation.did
          }
        };
      } catch (parseError) {
        // Treat as raw DID
        console.log('🔄 Treating OOB parameter as raw DID');
        return {
          format: 'legacy-peer',
          isValid: true,
          data: { from: oobParam, type: 'legacy' },
          metadata: {
            hasAttachments: false,
            hasVCProof: false,
            from: oobParam
          }
        };
      }
    }

    return {
      format: 'malformed',
      isValid: false,
      error: 'No valid invitation data found in legacy format'
    };

  } catch (error) {
    console.error('🔴 Legacy invitation parsing failed:', error.message);
    return {
      format: 'malformed',
      isValid: false,
      error: `Legacy invitation parsing failed: ${error.message}`
    };
  }
}

/**
 * Extract VC proof from invitation attachments or URL parameters
 * @param invitationUrl - Invitation URL
 * @param invitationData - Parsed invitation data
 * @returns VC proof attachment information
 */
export function extractVCProof(invitationUrl: string, invitationData?: any): VCProofAttachment {
  try {
    console.log('🎫 Extracting VC proof from invitation...');

    const urlObj = new URL(invitationUrl);

    // Strategy 1: Check URL parameter (legacy format)
    const vcProofParam = urlObj.searchParams.get('vcproof');
    if (vcProofParam) {
      console.log('📋 Found VC proof in URL parameter');

      try {
        const decoded = robustBase64Decode(decodeURIComponent(vcProofParam), 'VC proof URL parameter');
        const vcProof = JSON.parse(decoded);

        return {
          isPresent: true,
          data: vcProof
        };
      } catch (paramError) {
        return {
          isPresent: false,
          error: `Failed to parse VC proof from URL parameter: ${paramError.message}`
        };
      }
    }

    // Strategy 2: Check invitation attachments (DIDComm v2.0 format)
    if (invitationData && invitationData.attachments) {
      console.log('📎 Checking invitation attachments for VC proof...');

      for (const attachment of invitationData.attachments) {
        // Look for presentation request attachments
        if (attachment.media_type === "application/json" &&
            attachment.data && attachment.data.base64) {

          try {
            const presentationDef = safeBase64ParseJSON(attachment.data.base64, 'presentation definition attachment');

            if (presentationDef.isValid && presentationDef.data.example_credential) {
              console.log('✅ Found VC proof in attachment');
              return {
                isPresent: true,
                data: presentationDef.data.example_credential
              };
            }
          } catch (attachmentError) {
            console.warn('⚠️ Failed to parse attachment:', attachmentError.message);
          }
        }
      }
    }

    console.log('📭 No VC proof found in invitation');
    return {
      isPresent: false
    };

  } catch (error) {
    console.error('🔴 VC proof extraction failed:', error.message);
    return {
      isPresent: false,
      error: `VC proof extraction failed: ${error.message}`
    };
  }
}

/**
 * Convert legacy invitation to SDK-compatible format
 * @param legacyInvitation - Legacy invitation data
 * @returns SDK-compatible invitation or null if conversion not possible
 */
export function convertToSDKFormat(legacyInvitation: any): any | null {
  try {
    console.log('🔄 Converting legacy invitation to SDK format...');

    if (!legacyInvitation.from && !legacyInvitation.did) {
      console.error('❌ No sender DID found in legacy invitation');
      return null;
    }

    const fromDID = legacyInvitation.from || legacyInvitation.did;

    // Create SDK-compatible invitation structure
    const sdkInvitation = {
      type: "https://didcomm.org/out-of-band/2.0/invitation",
      id: `invitation-${Date.now()}`,
      from: fromDID,
      body: {
        accept: ["didcomm/v2"]
      },
      label: legacyInvitation.label || "Connection Request",
      // Legacy format typically doesn't have attachments
      attachments: legacyInvitation.attachments || []
    };

    console.log('✅ Successfully converted to SDK format');
    return sdkInvitation;

  } catch (error) {
    console.error('🔴 SDK format conversion failed:', error.message);
    return null;
  }
}

/**
 * Comprehensive invitation parsing function
 * @param invitationUrl - Invitation URL or raw data
 * @returns Complete parsing result with recommendations
 */
export function parseInvitationComprehensive(invitationUrl: string): InvitationParseResult {
  console.log('🚀 Starting comprehensive invitation parsing...');

  const format = detectInvitationFormat(invitationUrl);
  let invitation: ParsedInvitation;
  let vcProof: VCProofAttachment = { isPresent: false };

  // Parse based on detected format
  switch (format) {
    case 'didcomm-v2.0':
    case 'sdk-compatible':
      invitation = parseDIDCommV2Invitation(invitationUrl);
      if (invitation.isValid) {
        vcProof = extractVCProof(invitationUrl, invitation.data);
      }
      break;

    case 'legacy-peer':
    case 'legacy-vcproof':
      invitation = parseLegacyInvitation(invitationUrl);
      if (invitation.isValid) {
        vcProof = extractVCProof(invitationUrl, invitation.data);
      }
      break;

    default:
      invitation = {
        format,
        isValid: false,
        error: `Unsupported invitation format: ${format}`
      };
  }

  // Determine SDK compatibility
  const sdkCompatible = format === 'didcomm-v2.0' || format === 'sdk-compatible';

  // Recommend action based on parsing results
  let recommendedAction: InvitationParseResult['recommendedAction'];

  if (!invitation.isValid) {
    recommendedAction = 'reject';
  } else if (sdkCompatible) {
    recommendedAction = 'sdk_process';
  } else if (format === 'legacy-peer' || format === 'legacy-vcproof') {
    recommendedAction = 'manual_process';
  } else {
    recommendedAction = 'request_new';
  }

  const result: InvitationParseResult = {
    invitation,
    vcProof,
    sdkCompatible,
    recommendedAction
  };

  console.log('📊 Comprehensive parsing completed:', {
    format: invitation.format,
    isValid: invitation.isValid,
    hasVCProof: vcProof.isPresent,
    sdkCompatible,
    recommendedAction
  });

  return result;
}