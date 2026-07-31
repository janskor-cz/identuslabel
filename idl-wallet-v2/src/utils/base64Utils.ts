/**
 * Safe Base64 encoding/decoding utilities with comprehensive error handling
 * Prevents crashes from malformed base64 data and provides detailed error reporting
 * Includes DID string detection for invitation format handling
 */

/**
 * Validation result for base64 operations
 */
export interface Base64ValidationResult {
  isValid: boolean;
  error?: string;
  decoded?: string;
}

/**
 * Invitation format types
 */
export type InvitationFormat = 'base64-json' | 'raw-did' | 'unknown';

/**
 * Detect the format of an invitation parameter
 * @param oobParam - The _oob parameter value from URL
 * @returns Format type of the invitation
 */
export function detectInvitationFormat(oobParam: string): InvitationFormat {
  if (!oobParam || typeof oobParam !== 'string') {
    return 'unknown';
  }

  const trimmed = oobParam.trim();

  // Check if it's a raw DID string
  if (trimmed.startsWith('did:')) {
    console.log('🔍 Detected raw DID format invitation');
    return 'raw-did';
  }

  // Check if it looks like base64
  if (isValidBase64(trimmed)) {
    console.log('🔍 Detected base64-json format invitation');
    return 'base64-json';
  }

  console.warn('⚠️ Unknown invitation format detected');
  return 'unknown';
}

/**
 * Check if a string is valid base64
 * @param str - String to validate
 * @returns boolean indicating if string is valid base64
 */
export function isValidBase64(str: string): boolean {
  if (!str || typeof str !== 'string') {
    return false;
  }

  // Remove whitespace and check length
  const cleaned = str.replace(/\s/g, '');
  if (cleaned.length === 0) {
    return false;
  }

  // RFC 0434 compatible: Allow strings that will be valid after padding
  // Check if length is multiple of 4 OR can be made so with padding
  const remainder = cleaned.length % 4;
  if (remainder !== 0) {
    // If remainder is 1, it's invalid (can't be padded correctly)
    // If remainder is 2 or 3, it can be padded with 2 or 1 '=' characters
    if (remainder === 1) {
      console.log('🔴 [BASE64] Invalid base64: remainder 1 cannot be padded correctly');
      return false;
    }
    console.log(`🔧 [BASE64] Base64 string can be padded (remainder: ${remainder})`);
  }

  // Check for valid base64 characters (excluding padding for now)
  const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
  const isValid = base64Regex.test(cleaned);

  if (!isValid) {
    console.log('🔴 [BASE64] Invalid characters found in base64 string');
  } else {
    console.log('✅ [BASE64] Base64 string has valid characters');
  }

  return isValid;
}

/**
 * Safely decode base64 string with validation and error handling
 * @param base64String - Base64 encoded string to decode
 * @param context - Context for error logging (e.g., "invitation parsing")
 * @returns Validation result with decoded string or error
 */
export function safeBase64Decode(base64String: string, context: string = 'unknown'): Base64ValidationResult {
  try {
    // Input validation
    if (!base64String) {
      return {
        isValid: false,
        error: `Empty base64 string provided for ${context}`
      };
    }

    if (typeof base64String !== 'string') {
      return {
        isValid: false,
        error: `Invalid input type for ${context}: expected string, got ${typeof base64String}`
      };
    }

    // Clean and add proper padding if needed
    let cleaned = base64String.trim();

    // Add padding if necessary (RFC 0434 invitations sometimes have unpadded base64)
    const paddingNeeded = (4 - (cleaned.length % 4)) % 4;
    if (paddingNeeded > 0) {
      cleaned += '='.repeat(paddingNeeded);
      console.log(`🔧 [BASE64] Added ${paddingNeeded} padding chars for ${context}`);
    }

    if (!isValidBase64(cleaned)) {
      return {
        isValid: false,
        error: `Invalid base64 format for ${context}: string contains invalid characters or incorrect padding`
      };
    }

    // Attempt decoding
    const decoded = atob(cleaned);

    console.log(`✅ Successfully decoded base64 for ${context}`);
    return {
      isValid: true,
      decoded
    };

  } catch (error) {
    const errorMessage = `Base64 decoding failed for ${context}: ${error.message}`;
    console.error('🔴', errorMessage);

    return {
      isValid: false,
      error: errorMessage
    };
  }
}

/**
 * Safely parse JSON from base64 string
 * @param base64String - Base64 encoded JSON string
 * @param context - Context for error logging
 * @returns Object with parsed data or error information
 */
export function safeBase64ParseJSON(base64String: string, context: string = 'unknown'): {
  isValid: boolean;
  data?: any;
  error?: string;
} {
  try {
    // First decode the base64
    const decodeResult = safeBase64Decode(base64String, context);
    if (!decodeResult.isValid || !decodeResult.decoded) {
      return {
        isValid: false,
        error: decodeResult.error
      };
    }

    // Then parse as JSON
    const parsed = JSON.parse(decodeResult.decoded);

    console.log(`✅ Successfully parsed JSON from base64 for ${context}`);
    return {
      isValid: true,
      data: parsed
    };

  } catch (jsonError) {
    const errorMessage = `JSON parsing failed for ${context}: ${jsonError.message}`;
    console.error('🔴', errorMessage);

    return {
      isValid: false,
      error: errorMessage
    };
  }
}

/**
 * Safely encode string to base64
 * @param str - String to encode
 * @param context - Context for error logging
 * @returns Base64 encoded string or null on error
 */
export function safeBase64Encode(str: string, context: string = 'unknown'): string | null {
  try {
    if (!str || typeof str !== 'string') {
      console.error(`🔴 Invalid input for base64 encoding in ${context}: expected non-empty string`);
      return null;
    }

    const encoded = btoa(str);
    console.log(`✅ Successfully encoded string to base64 for ${context}`);
    return encoded;

  } catch (error) {
    console.error(`🔴 Base64 encoding failed for ${context}:`, error.message);
    return null;
  }
}

/**
 * Extract and safely decode base64 from URL parameter
 * @param url - URL string or URL object
 * @param paramName - Parameter name to extract
 * @param context - Context for error logging
 * @returns Validation result with decoded parameter
 */
export function safeDecodeURLParameter(url: string | URL, paramName: string, context: string = 'URL parameter'): Base64ValidationResult {
  try {
    const urlObj = typeof url === 'string' ? new URL(url) : url;
    const paramValue = urlObj.searchParams.get(paramName);

    if (!paramValue) {
      return {
        isValid: false,
        error: `Parameter '${paramName}' not found in URL for ${context}`
      };
    }

    // Handle URL encoding if present
    const decodedParam = decodeURIComponent(paramValue);

    return safeBase64Decode(decodedParam, `${context} (${paramName})`);

  } catch (urlError) {
    return {
      isValid: false,
      error: `URL parsing failed for ${context}: ${urlError.message}`
    };
  }
}

/**
 * Enhanced base64 decoding with multiple fallback strategies
 * @param base64String - Base64 string to decode
 * @param context - Context for logging
 * @returns Decoded string or throws descriptive error
 */
export function robustBase64Decode(base64String: string, context: string = 'unknown'): string {
  // Strategy 1: Direct safe decoding
  const directResult = safeBase64Decode(base64String, context);
  if (directResult.isValid && directResult.decoded) {
    return directResult.decoded;
  }

  // Strategy 2: Try with URL decoding first
  try {
    const urlDecoded = decodeURIComponent(base64String);
    const urlResult = safeBase64Decode(urlDecoded, `${context} (URL decoded)`);
    if (urlResult.isValid && urlResult.decoded) {
      console.log(`✅ Successfully decoded after URL decoding for ${context}`);
      return urlResult.decoded;
    }
  } catch (urlError) {
    console.warn(`⚠️ URL decoding strategy failed for ${context}:`, urlError.message);
  }

  // Strategy 3: Try fixing common padding issues
  try {
    let fixed = base64String.trim();

    // Add missing padding
    while (fixed.length % 4 !== 0) {
      fixed += '=';
    }

    // Remove any non-base64 characters
    fixed = fixed.replace(/[^A-Za-z0-9+/=]/g, '');

    const fixedResult = safeBase64Decode(fixed, `${context} (padding fixed)`);
    if (fixedResult.isValid && fixedResult.decoded) {
      console.log(`✅ Successfully decoded after fixing padding for ${context}`);
      return fixedResult.decoded;
    }
  } catch (fixError) {
    console.warn(`⚠️ Padding fix strategy failed for ${context}:`, fixError.message);
  }

  // All strategies failed
  const errorMsg = `All base64 decoding strategies failed for ${context}: ${directResult.error}`;
  console.error('🔴', errorMsg);
  throw new Error(errorMsg);
}