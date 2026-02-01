/**
 * QR Message Parser Utility
 *
 * Multipurpose QR code parser that detects different DIDComm message types
 * and routes them to appropriate wallet pages.
 *
 * Supports:
 * - OOB connection invitations
 * - Proof requests (CA verification)
 * - Credential offers (future)
 * - Presentation requests (future)
 * - Deep links (future)
 */

export type MessageType =
  | 'oob-invitation'
  | 'proof-request'
  | 'credential-offer'
  | 'presentation-request'
  | 'ca-identity-verification'
  | 'peer-did'
  | 'unknown';

export interface RouteAction {
  page: '/oob' | '/verify' | '/messages' | '/credentials' | '/';
  queryParams: Record<string, string>;
}

export interface ScanResult {
  rawData: string;
  messageType: MessageType;
  parsedData: any;
  routeAction: RouteAction;
  metadata?: {
    from?: string;
    [key: string]: any;
  };
}

/**
 * Main entry point: Parse QR code data and detect message type
 *
 * @param rawData - Raw QR code content (URL, base64, JSON, etc.)
 * @returns Parsed scan result with routing information
 */
export async function parseQRMessage(rawData: string): Promise<ScanResult> {
  console.log('🔍 [QR Parser] Parsing QR code data...');

  // 1. Try URL parsing first (most common case)
  if (rawData.startsWith('http://') || rawData.startsWith('https://')) {
    return parseURLMessage(rawData);
  }

  // 2. Try deep link protocols (future)
  if (rawData.startsWith('identus://') || rawData.startsWith('didcomm://')) {
    return parseDeepLinkMessage(rawData);
  }

  // 3. Try raw DID
  if (rawData.startsWith('did:')) {
    console.log('✅ [QR Parser] Detected peer DID');
    return {
      rawData,
      messageType: 'peer-did',
      parsedData: { from: rawData },
      routeAction: {
        page: '/oob',
        queryParams: { invitation: rawData }
      }
    };
  }

  // 4. Try direct base64 JSON
  try {
    // Browser-compatible base64 decoding (works on mobile)
    const decoded = atob(rawData);
    const parsed = JSON.parse(decoded);
    return detectMessageTypeFromJSON(parsed, rawData);
  } catch (error) {
    // Not base64 JSON
  }

  // 5. Last resort: try raw JSON
  try {
    const parsed = JSON.parse(rawData);
    return detectMessageTypeFromJSON(parsed, rawData);
  } catch (error) {
    console.error('❌ [QR Parser] Unrecognized QR code format');
    throw new Error('Unrecognized QR code format. Please verify the QR code is from a trusted source.');
  }
}

/**
 * Parse URL-encoded message (invitation or proof request)
 *
 * @param url - Full URL with query parameters
 * @returns Parsed scan result
 */
function parseURLMessage(url: string): ScanResult {
  console.log('🔍 [QR Parser] Parsing URL message');

  try {
    const urlObj = new URL(url);

    // Check for OOB invitation parameter (_oob)
    const oobParam = urlObj.searchParams.get('_oob');
    if (oobParam) {
      return parseOOBInvitation(oobParam, url);
    }

    // Check for proof request parameter (request)
    const requestParam = urlObj.searchParams.get('request');
    if (requestParam) {
      return parseProofRequest(requestParam, url);
    }

    // Check if invitation is direct path parameter
    const invitationParam = urlObj.searchParams.get('invitation');
    if (invitationParam) {
      return {
        rawData: url,
        messageType: 'oob-invitation',
        parsedData: { invitationUrl: url },
        routeAction: {
          page: '/oob',
          queryParams: { invitation: url }
        }
      };
    }

    throw new Error('URL does not contain recognized invitation or request parameter');
  } catch (error) {
    console.error('❌ [QR Parser] URL parsing error:', error);
    throw new Error(`Invalid invitation URL: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

/**
 * Parse OOB invitation from base64 parameter
 *
 * @param oobBase64 - Base64-encoded OOB invitation
 * @param originalUrl - Original URL for reference
 * @returns Parsed scan result
 */
function parseOOBInvitation(oobBase64: string, originalUrl: string): ScanResult {
  console.log('✅ [QR Parser] Detected OOB invitation');

  try {
    // Browser-compatible base64 decoding (works on mobile)
    const invitationJson = atob(oobBase64);
    const invitation = JSON.parse(invitationJson);

    return {
      rawData: originalUrl,
      messageType: 'oob-invitation',
      parsedData: invitation,
      routeAction: {
        page: '/oob',
        queryParams: { invitation: originalUrl }
      },
      metadata: {
        from: invitation.from
      }
    };
  } catch (error) {
    console.error('❌ [QR Parser] OOB invitation parsing error:', error);
    throw new Error('Invalid OOB invitation format');
  }
}

/**
 * Parse proof request from base64 parameter
 *
 * @param requestBase64 - Base64-encoded proof request
 * @param originalUrl - Original URL for reference
 * @returns Parsed scan result
 */
function parseProofRequest(requestBase64: string, originalUrl: string): ScanResult {
  console.log('✅ [QR Parser] Detected proof request');

  try {
    // Browser-compatible base64 decoding (works on mobile)
    const requestJson = atob(requestBase64);
    const request = JSON.parse(requestJson);

    // Validate proof request structure
    if (!request.challengeId || !request.credentialType) {
      throw new Error('Invalid proof request structure');
    }

    return {
      rawData: originalUrl,
      messageType: 'proof-request',
      parsedData: request,
      routeAction: {
        page: '/verify',
        queryParams: { request: requestBase64 }
      },
      metadata: {
        credentialType: request.credentialType,
        challenge: request.challenge
      }
    };
  } catch (error) {
    console.error('❌ [QR Parser] Proof request parsing error:', error);
    throw new Error('Invalid proof request format');
  }
}

/**
 * Detect message type from parsed JSON
 *
 * @param data - Parsed JSON object
 * @param rawData - Original raw data
 * @returns Parsed scan result
 */
function detectMessageTypeFromJSON(data: any, rawData: string): ScanResult {
  console.log('🔍 [QR Parser] Detecting message type from JSON');

  // Check for DIDComm OOB invitation
  if (
    data.type === 'https://didcomm.org/out-of-band/2.0/invitation' ||
    data['@type'] === 'https://didcomm.org/out-of-band/2.0/invitation'
  ) {
    return {
      rawData,
      messageType: 'oob-invitation',
      parsedData: data,
      routeAction: {
        page: '/oob',
        queryParams: { invitation: rawData }
      },
      metadata: {
        from: data.from
      }
    };
  }

  // Check for credential offer
  if (
    data.type === 'https://didcomm.org/issue-credential/3.0/offer-credential' ||
    data['@type']?.includes('offer-credential')
  ) {
    console.log('✅ [QR Parser] Detected credential offer');
    return {
      rawData,
      messageType: 'credential-offer',
      parsedData: data,
      routeAction: {
        page: '/messages',
        queryParams: { offerId: data.id || '' }
      },
      metadata: {
        from: data.from
      }
    };
  }

  // Check for presentation request
  if (
    data.type?.includes('request-presentation') ||
    data['@type']?.includes('request-presentation')
  ) {
    console.log('✅ [QR Parser] Detected presentation request');
    return {
      rawData,
      messageType: 'presentation-request',
      parsedData: data,
      routeAction: {
        page: '/verify',
        queryParams: { requestId: data.id || '' }
      }
    };
  }

  // Check for CA-specific proof request (our custom format)
  if (data.credentialType && data.verifyUrl && data.challengeId) {
    console.log('✅ [QR Parser] Detected CA proof request');
    return {
      rawData,
      messageType: 'proof-request',
      parsedData: data,
      routeAction: {
        page: '/verify',
        queryParams: { request: btoa(rawData) }
      },
      metadata: {
        credentialType: data.credentialType
      }
    };
  }

  // Unknown message type
  console.warn('⚠️ [QR Parser] Unknown message type:', data.type || data['@type']);
  return {
    rawData,
    messageType: 'unknown',
    parsedData: data,
    routeAction: {
      page: '/',
      queryParams: {}
    }
  };
}

/**
 * Parse deep link protocols (future extensibility)
 *
 * @param url - Deep link URL (identus:// or didcomm://)
 * @returns Parsed scan result
 */
function parseDeepLinkMessage(url: string): ScanResult {
  console.log('🔍 [QR Parser] Parsing deep link');

  try {
    const urlObj = new URL(url);

    // identus://connect?invitation=base64...
    if (urlObj.protocol === 'identus:' && urlObj.hostname === 'connect') {
      const invitation = urlObj.searchParams.get('invitation');
      if (invitation) {
        return parseOOBInvitation(invitation, url);
      }
    }

    // identus://verify?request=base64...
    if (urlObj.protocol === 'identus:' && urlObj.hostname === 'verify') {
      const request = urlObj.searchParams.get('request');
      if (request) {
        return parseProofRequest(request, url);
      }
    }

    // didcomm://... (future)
    if (urlObj.protocol === 'didcomm:') {
      // Future implementation for DIDComm protocol URLs
      throw new Error('DIDComm protocol URLs not yet supported');
    }

    throw new Error('Unsupported deep link protocol');
  } catch (error) {
    console.error('❌ [QR Parser] Deep link parsing error:', error);
    throw new Error(`Invalid deep link: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

/**
 * Validate QR message for security
 *
 * @param result - Parsed scan result
 * @returns Promise that resolves if valid, rejects if invalid
 */
export async function validateQRMessage(result: ScanResult): Promise<void> {
  console.log('🔐 [QR Parser] Validating scanned message...');

  // 1. Domain whitelist validation for URLs
  if (result.rawData.startsWith('http://') || result.rawData.startsWith('https://')) {
    const url = new URL(result.rawData);
    const trustedDomains = ['91.99.4.54', 'localhost', '127.0.0.1', 'identuslabel.cz'];

    if (!trustedDomains.includes(url.hostname)) {
      console.warn('⚠️ [QR Parser] Invitation from untrusted domain:', url.hostname);
      // Allow but warn user - don't block (could be legitimate external party)
    }
  }

  // 2. Malicious content detection
  const maliciousPatterns = [
    /javascript:/i,
    /data:/i,
    /<script/i,
    /onclick=/i,
    /onerror=/i,
    /onload=/i
  ];

  for (const pattern of maliciousPatterns) {
    if (pattern.test(result.rawData)) {
      console.error('🚨 [QR Parser] Malicious content detected in QR code!');
      throw new Error('Malicious content detected in QR code. Scan aborted for security.');
    }
  }

  // 3. Rate limiting
  const lastScanTime = localStorage.getItem('last-qr-scan-time');
  const now = Date.now();

  if (lastScanTime) {
    const timeSinceLastScan = now - parseInt(lastScanTime);
    if (timeSinceLastScan < 1000) {
      throw new Error('Please wait before scanning again (rate limit)');
    }
  }

  localStorage.setItem('last-qr-scan-time', now.toString());

  console.log('✅ [QR Parser] Message validation passed');
}

/**
 * Extract OOB parameter from URL
 *
 * @param invitationUrl - Full invitation URL
 * @returns Base64-encoded OOB parameter or null
 */
export function extractOOBFromURL(invitationUrl: string): string | null {
  try {
    const url = new URL(invitationUrl);
    return url.searchParams.get('_oob');
  } catch (error) {
    console.error('❌ [QR Parser] Invalid invitation URL:', error);
    return null;
  }
}
