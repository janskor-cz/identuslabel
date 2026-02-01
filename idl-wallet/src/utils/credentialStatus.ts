/**
 * W3C Bitstring Status List v1.0 Credential Revocation Checking
 *
 * Implements the W3C recommendation for privacy-preserving credential status checking.
 * Spec: https://www.w3.org/TR/vc-bitstring-status-list/
 */

import pako from 'pako';

/**
 * Rewrites HTTP credential-status URLs to use HTTPS proxy
 * Fixes mixed-content blocking when page is loaded over HTTPS
 */
function rewriteStatusUrl(url: string): string {
  // Rewrite http://91.99.4.54:8100/credential-status/xxx to https://identuslabel.cz/issuer/credential-status/xxx
  const httpPattern = /^http:\/\/91\.99\.4\.54:8100\/credential-status\/(.+)$/;
  const match = url.match(httpPattern);
  if (match) {
    return `https://identuslabel.cz/issuer/credential-status/${match[1]}`;
  }
  return url;
}

export interface CredentialStatus {
  revoked: boolean;
  suspended: boolean;
  statusPurpose: string;
  checkedAt: string;
  error?: string;
}

/**
 * Fetches a status list credential from the issuer
 */
export async function fetchStatusList(url: string): Promise<any> {
  const rewrittenUrl = rewriteStatusUrl(url);
  const response = await fetch(rewrittenUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch status list: ${response.status}`);
  }
  return await response.json();
}

/**
 * Decompresses a Base64URL GZIP-compressed bitstring
 * Cloud Agent StatusList2021: Uses Base64URL encoding WITHOUT multibase prefix
 */
export function decompressBitstring(encodedList: string): Uint8Array {
  // Convert Base64URL to standard Base64
  // Base64URL uses - and _ instead of + and /
  const base64 = encodedList.replace(/-/g, '+').replace(/_/g, '/');

  // Add padding if needed (Base64 requires length to be multiple of 4)
  const padding = 4 - (base64.length % 4);
  const paddedBase64 = padding !== 4 ? base64 + '='.repeat(padding) : base64;

  // Decode base64 to get compressed data (browser-compatible)
  // atob() returns a binary string, convert to Uint8Array for pako
  const binaryString = atob(paddedBase64);
  const compressed = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    compressed[i] = binaryString.charCodeAt(i);
  }

  // Decompress with GZIP
  return pako.inflate(compressed);
}

/**
 * Checks the bit value at a specific index in the bitstring
 * W3C spec: Index 0 is left-most bit, bits are ordered left-to-right
 */
export function checkBitAtIndex(
  bitstring: Uint8Array,
  index: number,
  statusSize: number = 1
): number {
  const bitPosition = index * statusSize;
  const byteIndex = Math.floor(bitPosition / 8);
  const bitOffset = 7 - (bitPosition % 8); // Left-to-right bit ordering

  if (byteIndex >= bitstring.length) {
    throw new Error(`Bit index ${index} out of bounds`);
  }

  const byte = bitstring[byteIndex];
  const bit = (byte >> bitOffset) & 1;

  return bit;
}

/**
 * Verifies the revocation/suspension status of a credential
 *
 * @param credential - The credential to check (must have credentialStatus property)
 * @returns CredentialStatus object with revoked/suspended flags
 */
export async function verifyCredentialStatus(credential: any): Promise<CredentialStatus> {
  const credentialStatus = credential.credentialStatus;

  // If no status list, credential cannot be revoked via this mechanism
  // Accept both 'BitstringStatusListEntry' (W3C v1.0) and 'StatusList2021Entry' (W3C v1.1)
  const validTypes = ['BitstringStatusListEntry', 'StatusList2021Entry'];
  if (!credentialStatus || !validTypes.includes(credentialStatus.type)) {
    return {
      revoked: false,
      suspended: false,
      statusPurpose: 'none',
      checkedAt: new Date().toISOString()
    };
  }

  try {
    // Step 1: Fetch status list credential
    const statusListCred = await fetchStatusList(credentialStatus.statusListCredential);

    // Step 2: Extract and decompress bitstring
    const bitstring = decompressBitstring(statusListCred.credentialSubject.encodedList);

    // Step 3: Check bit at statusListIndex
    const index = parseInt(credentialStatus.statusListIndex);
    const statusSize = credentialStatus.statusSize || 1;
    const statusValue = checkBitAtIndex(bitstring, index, statusSize);

    const statusPurpose = credentialStatus.statusPurpose;

    // Step 4: Interpret status value
    // statusValue === 1 means revoked/suspended (depending on statusPurpose)
    // statusValue === 0 means valid
    return {
      revoked: statusPurpose.toLowerCase() === 'revocation' && statusValue === 1,
      suspended: statusPurpose.toLowerCase() === 'suspension' && statusValue === 1,
      statusPurpose,
      checkedAt: new Date().toISOString()
    };
  } catch (error) {
    // Graceful degradation: Return error but don't crash
    console.error('[credentialStatus] Status check failed:', error);
    return {
      revoked: false,
      suspended: false,
      statusPurpose: 'error',
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Batch verification of multiple credentials
 * Optimizes by grouping credentials that share the same status list
 */
export async function verifyCredentialsBatch(credentials: any[]): Promise<Map<string, CredentialStatus>> {
  const results = new Map<string, CredentialStatus>();

  // Group credentials by status list URL to minimize network requests
  const groupedByStatusList = new Map<string, any[]>();

  for (const cred of credentials) {
    if (cred.credentialStatus?.statusListCredential) {
      const url = cred.credentialStatus.statusListCredential;
      if (!groupedByStatusList.has(url)) {
        groupedByStatusList.set(url, []);
      }
      groupedByStatusList.get(url)!.push(cred);
    } else {
      // No status list - mark as valid
      results.set(cred.id, {
        revoked: false,
        suspended: false,
        statusPurpose: 'none',
        checkedAt: new Date().toISOString()
      });
    }
  }

  // Fetch each status list once and check all credentials against it
  for (const [url, creds] of groupedByStatusList.entries()) {
    try {
      const statusListCred = await fetchStatusList(url);
      const bitstring = decompressBitstring(statusListCred.credentialSubject.encodedList);

      for (const cred of creds) {
        try {
          const index = parseInt(cred.credentialStatus.statusListIndex);
          const statusSize = cred.credentialStatus.statusSize || 1;
          const statusValue = checkBitAtIndex(bitstring, index, statusSize);
          const statusPurpose = cred.credentialStatus.statusPurpose;

          results.set(cred.id, {
            revoked: statusPurpose === 'revocation' && statusValue === 1,
            suspended: statusPurpose === 'suspension' && statusValue === 1,
            statusPurpose,
            checkedAt: new Date().toISOString()
          });
        } catch (error) {
          results.set(cred.id, {
            revoked: false,
            suspended: false,
            statusPurpose: 'error',
            checkedAt: new Date().toISOString(),
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    } catch (error) {
      // If status list fetch fails, mark all credentials with error
      for (const cred of creds) {
        results.set(cred.id, {
          revoked: false,
          suspended: false,
          statusPurpose: 'error',
          checkedAt: new Date().toISOString(),
          error: `Failed to fetch status list: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    }
  }

  return results;
}
