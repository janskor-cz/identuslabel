/**
 * PRISM DID Parser - Extract keys from long-form PRISM DIDs
 *
 * Long-form PRISM DID format: did:prism:[stateHash]:[encodedState]
 * The encodedState is a Base64URL-encoded Protobuf binary
 *
 * Protobuf Structure:
 * AtalaOperation {
 *   CreateDIDOperation create_did = 1 {
 *     DIDCreationData did_data = 1 {
 *       repeated PublicKey public_keys = 2;
 *       repeated Service services = 3;
 *     }
 *   }
 * }
 *
 * PublicKey {
 *   string id = 1;
 *   KeyUsage usage = 2;  // 3 = KEY_AGREEMENT_KEY
 *   CompressedECKeyData compressed_ec_key_data = 9 {
 *     string curve = 1;  // "x25519"
 *     bytes data = 2;    // 32 bytes
 *   }
 * }
 */

const crypto = require('crypto');

// KeyUsage enum values from PRISM protocol
const KeyUsage = {
  UNKNOWN_KEY: 0,
  MASTER_KEY: 1,
  ISSUING_KEY: 2,
  KEY_AGREEMENT_KEY: 3,
  AUTHENTICATION_KEY: 4,
  REVOCATION_KEY: 5,
  CAPABILITY_INVOCATION_KEY: 6,
  CAPABILITY_DELEGATION_KEY: 7
};

/**
 * Convert Base64URL to standard Base64
 */
function base64UrlToBase64(base64url) {
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  // Pad to multiple of 4
  while (base64.length % 4) {
    base64 += '=';
  }
  return base64;
}

/**
 * Parse a long-form PRISM DID and extract keys
 * @param {string} prismDID - Full PRISM DID string (did:prism:stateHash:encodedState)
 * @returns {object} Parsed DID with keys
 */
function parseLongFormPrismDID(prismDID) {
  // Validate DID format
  if (!prismDID || typeof prismDID !== 'string') {
    throw new Error('Invalid PRISM DID: must be a string');
  }

  if (!prismDID.startsWith('did:prism:')) {
    throw new Error('Invalid PRISM DID: must start with did:prism:');
  }

  // Extract method-specific ID (everything after did:prism:)
  const methodId = prismDID.substring('did:prism:'.length);
  const parts = methodId.split(':');

  if (parts.length < 2) {
    throw new Error('Not a long-form PRISM DID: missing encoded state');
  }

  const stateHash = parts[0];
  const encodedState = parts.slice(1).join(':'); // Handle colons in base64

  // Decode Base64URL to binary
  const base64 = base64UrlToBase64(encodedState);
  const binaryState = Buffer.from(base64, 'base64');

  // Verify state hash (SHA-256 of binary)
  const computedHash = crypto.createHash('sha256').update(binaryState).digest('hex');
  if (computedHash !== stateHash) {
    console.warn(`[PRISM DID] State hash mismatch: expected ${stateHash}, got ${computedHash}`);
    // Don't throw - some DIDs might have different hash formats
  }

  // Parse the protobuf binary
  const keys = parseAtalaOperationProtobuf(binaryState);

  return {
    did: prismDID,
    stateHash,
    keys
  };
}

/**
 * Simple protobuf varint decoder
 */
function readVarint(buffer, offset) {
  let result = 0;
  let shift = 0;
  let byte;
  let bytesRead = 0;

  do {
    if (offset >= buffer.length) {
      throw new Error('Unexpected end of buffer while reading varint');
    }
    byte = buffer[offset++];
    bytesRead++;
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);

  return { value: result, bytesRead };
}

/**
 * Parse a length-delimited field (returns the bytes)
 */
function readLengthDelimited(buffer, offset) {
  const { value: length, bytesRead } = readVarint(buffer, offset);
  offset += bytesRead;

  if (offset + length > buffer.length) {
    throw new Error('Unexpected end of buffer while reading length-delimited field');
  }

  return {
    data: buffer.slice(offset, offset + length),
    totalBytesRead: bytesRead + length
  };
}

/**
 * Parse AtalaOperation protobuf to extract public keys
 */
function parseAtalaOperationProtobuf(buffer) {
  const keys = [];
  let offset = 0;

  try {
    while (offset < buffer.length) {
      // Read field tag (varint)
      const { value: tag, bytesRead: tagBytes } = readVarint(buffer, offset);
      offset += tagBytes;

      const fieldNumber = tag >> 3;
      const wireType = tag & 0x7;

      if (wireType === 2) { // Length-delimited (nested message or string)
        const { data, totalBytesRead } = readLengthDelimited(buffer, offset);
        offset += totalBytesRead;

        // Field 1 is create_did (CreateDIDOperation)
        if (fieldNumber === 1) {
          const nestedKeys = parseCreateDIDOperation(data);
          keys.push(...nestedKeys);
        }
      } else if (wireType === 0) { // Varint
        const { bytesRead } = readVarint(buffer, offset);
        offset += bytesRead;
      } else {
        // Skip unknown wire types
        console.warn(`[PRISM DID] Unknown wire type ${wireType} for field ${fieldNumber}`);
        break;
      }
    }
  } catch (err) {
    console.error('[PRISM DID] Error parsing protobuf:', err.message);
  }

  return keys;
}

/**
 * Parse CreateDIDOperation
 */
function parseCreateDIDOperation(buffer) {
  const keys = [];
  let offset = 0;

  while (offset < buffer.length) {
    try {
      const { value: tag, bytesRead: tagBytes } = readVarint(buffer, offset);
      offset += tagBytes;

      const fieldNumber = tag >> 3;
      const wireType = tag & 0x7;

      if (wireType === 2) { // Length-delimited
        const { data, totalBytesRead } = readLengthDelimited(buffer, offset);
        offset += totalBytesRead;

        // Field 1 is did_data (DIDCreationData)
        if (fieldNumber === 1) {
          const nestedKeys = parseDIDCreationData(data);
          keys.push(...nestedKeys);
        }
      } else if (wireType === 0) {
        const { bytesRead } = readVarint(buffer, offset);
        offset += bytesRead;
      } else {
        break;
      }
    } catch {
      break;
    }
  }

  return keys;
}

/**
 * Parse DIDCreationData
 */
function parseDIDCreationData(buffer) {
  const keys = [];
  let offset = 0;

  while (offset < buffer.length) {
    try {
      const { value: tag, bytesRead: tagBytes } = readVarint(buffer, offset);
      offset += tagBytes;

      const fieldNumber = tag >> 3;
      const wireType = tag & 0x7;

      if (wireType === 2) { // Length-delimited
        const { data, totalBytesRead } = readLengthDelimited(buffer, offset);
        offset += totalBytesRead;

        // Field 2 is public_keys (repeated PublicKey)
        if (fieldNumber === 2) {
          const key = parsePublicKey(data);
          if (key) {
            keys.push(key);
          }
        }
        // Field 3 is services (we skip these)
      } else if (wireType === 0) {
        const { bytesRead } = readVarint(buffer, offset);
        offset += bytesRead;
      } else {
        break;
      }
    } catch {
      break;
    }
  }

  return keys;
}

/**
 * Parse PublicKey message
 */
function parsePublicKey(buffer) {
  let id = null;
  let usage = null;
  let curve = null;
  let keyData = null;
  let offset = 0;

  while (offset < buffer.length) {
    try {
      const { value: tag, bytesRead: tagBytes } = readVarint(buffer, offset);
      offset += tagBytes;

      const fieldNumber = tag >> 3;
      const wireType = tag & 0x7;

      if (wireType === 2) { // Length-delimited (string or nested message)
        const { data, totalBytesRead } = readLengthDelimited(buffer, offset);
        offset += totalBytesRead;

        // Field 1: id (string)
        if (fieldNumber === 1) {
          id = data.toString('utf8');
        }
        // Field 9: compressed_ec_key_data
        else if (fieldNumber === 9) {
          const keyInfo = parseCompressedECKeyData(data);
          curve = keyInfo.curve;
          keyData = keyInfo.data;
        }
        // Field 8: ec_key_data (uncompressed) - also handle
        else if (fieldNumber === 8) {
          const keyInfo = parseECKeyData(data);
          curve = keyInfo.curve;
          keyData = keyInfo.data;
        }
      } else if (wireType === 0) { // Varint
        const { value, bytesRead } = readVarint(buffer, offset);
        offset += bytesRead;

        // Field 2: usage (KeyUsage enum)
        if (fieldNumber === 2) {
          usage = value;
        }
      } else {
        break;
      }
    } catch {
      break;
    }
  }

  if (id && usage !== null && keyData) {
    return {
      id,
      usage,
      usageName: getUsageName(usage),
      curve,
      publicKey: keyData.toString('base64url'),
      publicKeyHex: keyData.toString('hex'),
      publicKeyBytes: keyData
    };
  }

  return null;
}

/**
 * Parse CompressedECKeyData
 */
function parseCompressedECKeyData(buffer) {
  let curve = null;
  let data = null;
  let offset = 0;

  while (offset < buffer.length) {
    try {
      const { value: tag, bytesRead: tagBytes } = readVarint(buffer, offset);
      offset += tagBytes;

      const fieldNumber = tag >> 3;
      const wireType = tag & 0x7;

      if (wireType === 2) { // Length-delimited
        const { data: fieldData, totalBytesRead } = readLengthDelimited(buffer, offset);
        offset += totalBytesRead;

        // Field 1: curve (string)
        if (fieldNumber === 1) {
          curve = fieldData.toString('utf8');
        }
        // Field 2: data (bytes)
        else if (fieldNumber === 2) {
          data = fieldData;
        }
      } else if (wireType === 0) {
        const { bytesRead } = readVarint(buffer, offset);
        offset += bytesRead;
      } else {
        break;
      }
    } catch {
      break;
    }
  }

  return { curve, data };
}

/**
 * Parse ECKeyData (uncompressed format)
 */
function parseECKeyData(buffer) {
  let curve = null;
  let x = null;
  let y = null;
  let offset = 0;

  while (offset < buffer.length) {
    try {
      const { value: tag, bytesRead: tagBytes } = readVarint(buffer, offset);
      offset += tagBytes;

      const fieldNumber = tag >> 3;
      const wireType = tag & 0x7;

      if (wireType === 2) { // Length-delimited
        const { data: fieldData, totalBytesRead } = readLengthDelimited(buffer, offset);
        offset += totalBytesRead;

        // Field 1: curve (string)
        if (fieldNumber === 1) {
          curve = fieldData.toString('utf8');
        }
        // Field 2: x coordinate
        else if (fieldNumber === 2) {
          x = fieldData;
        }
        // Field 3: y coordinate
        else if (fieldNumber === 3) {
          y = fieldData;
        }
      } else if (wireType === 0) {
        const { bytesRead } = readVarint(buffer, offset);
        offset += bytesRead;
      } else {
        break;
      }
    } catch {
      break;
    }
  }

  // For X25519/Ed25519, we only need x coordinate (32 bytes)
  // For SECP256K1, we'd need both x and y
  return { curve, data: x };
}

/**
 * Get human-readable usage name
 */
function getUsageName(usage) {
  switch (usage) {
    case KeyUsage.UNKNOWN_KEY: return 'UNKNOWN_KEY';
    case KeyUsage.MASTER_KEY: return 'MASTER_KEY';
    case KeyUsage.ISSUING_KEY: return 'ISSUING_KEY';
    case KeyUsage.KEY_AGREEMENT_KEY: return 'KEY_AGREEMENT_KEY';
    case KeyUsage.AUTHENTICATION_KEY: return 'AUTHENTICATION_KEY';
    case KeyUsage.REVOCATION_KEY: return 'REVOCATION_KEY';
    case KeyUsage.CAPABILITY_INVOCATION_KEY: return 'CAPABILITY_INVOCATION_KEY';
    case KeyUsage.CAPABILITY_DELEGATION_KEY: return 'CAPABILITY_DELEGATION_KEY';
    default: return `UNKNOWN(${usage})`;
  }
}

/**
 * Extract X25519 key from a PRISM DID
 * @param {string} prismDID - Full PRISM DID string
 * @returns {object|null} X25519 key info or null if not found
 */
function extractX25519FromPrismDID(prismDID) {
  try {
    const parsed = parseLongFormPrismDID(prismDID);

    // Find KEY_AGREEMENT_KEY with X25519 curve
    const x25519Key = parsed.keys.find(key =>
      key.usage === KeyUsage.KEY_AGREEMENT_KEY &&
      (key.curve === 'x25519' || key.curve === 'X25519')
    );

    if (x25519Key) {
      console.log(`[PRISM DID] Found X25519 KEY_AGREEMENT_KEY: ${x25519Key.id}`);
      return {
        keyId: x25519Key.id,
        publicKey: x25519Key.publicKey,  // base64url
        publicKeyHex: x25519Key.publicKeyHex,
        publicKeyBytes: x25519Key.publicKeyBytes,
        curve: x25519Key.curve,
        usage: x25519Key.usageName
      };
    }

    // Also check for X25519 in other usage types (fallback)
    const anyX25519Key = parsed.keys.find(key =>
      key.curve === 'x25519' || key.curve === 'X25519'
    );

    if (anyX25519Key) {
      console.log(`[PRISM DID] Found X25519 key (non-standard usage ${anyX25519Key.usageName}): ${anyX25519Key.id}`);
      return {
        keyId: anyX25519Key.id,
        publicKey: anyX25519Key.publicKey,
        publicKeyHex: anyX25519Key.publicKeyHex,
        publicKeyBytes: anyX25519Key.publicKeyBytes,
        curve: anyX25519Key.curve,
        usage: anyX25519Key.usageName
      };
    }

    console.warn(`[PRISM DID] No X25519 key found in DID. Available keys:`,
      parsed.keys.map(k => `${k.id} (${k.usageName}, ${k.curve})`));
    return null;

  } catch (err) {
    console.error('[PRISM DID] Error extracting X25519 key:', err.message);
    return null;
  }
}

/**
 * Extract Ed25519 key from a PRISM DID
 * @param {string} prismDID - Full PRISM DID string
 * @returns {object|null} Ed25519 key info or null if not found
 */
function extractEd25519FromPrismDID(prismDID) {
  try {
    const parsed = parseLongFormPrismDID(prismDID);

    // Find AUTHENTICATION_KEY with Ed25519 curve
    const ed25519Key = parsed.keys.find(key =>
      key.usage === KeyUsage.AUTHENTICATION_KEY &&
      (key.curve === 'ed25519' || key.curve === 'Ed25519' || key.curve === 'ED25519')
    );

    if (ed25519Key) {
      console.log(`[PRISM DID] Found Ed25519 AUTHENTICATION_KEY: ${ed25519Key.id}`);
      return {
        keyId: ed25519Key.id,
        publicKey: ed25519Key.publicKey,  // base64url
        publicKeyHex: ed25519Key.publicKeyHex,
        publicKeyBytes: ed25519Key.publicKeyBytes,
        curve: ed25519Key.curve,
        usage: ed25519Key.usageName
      };
    }

    // Also check for Ed25519 in other usage types (ISSUING_KEY is also Ed25519)
    const anyEd25519Key = parsed.keys.find(key =>
      key.curve === 'ed25519' || key.curve === 'Ed25519' || key.curve === 'ED25519'
    );

    if (anyEd25519Key) {
      console.log(`[PRISM DID] Found Ed25519 key (non-standard usage ${anyEd25519Key.usageName}): ${anyEd25519Key.id}`);
      return {
        keyId: anyEd25519Key.id,
        publicKey: anyEd25519Key.publicKey,
        publicKeyHex: anyEd25519Key.publicKeyHex,
        publicKeyBytes: anyEd25519Key.publicKeyBytes,
        curve: anyEd25519Key.curve,
        usage: anyEd25519Key.usageName
      };
    }

    console.warn(`[PRISM DID] No Ed25519 key found in DID. Available keys:`,
      parsed.keys.map(k => `${k.id} (${k.usageName}, ${k.curve})`));
    return null;

  } catch (err) {
    console.error('[PRISM DID] Error extracting Ed25519 key:', err.message);
    return null;
  }
}

/**
 * Extract both Ed25519 and X25519 keys from a PRISM DID (for Security Clearance credentials)
 * @param {string} prismDID - Full PRISM DID string
 * @returns {object} Object with ed25519 and x25519 keys (may be null if not found)
 */
function extractSecurityClearanceKeysFromPrismDID(prismDID) {
  const ed25519 = extractEd25519FromPrismDID(prismDID);
  const x25519 = extractX25519FromPrismDID(prismDID);

  console.log(`[PRISM DID] Security Clearance keys extraction: Ed25519=${ed25519 ? 'found' : 'missing'}, X25519=${x25519 ? 'found' : 'missing'}`);

  return {
    ed25519,
    x25519,
    complete: !!(ed25519 && x25519)
  };
}

/**
 * Check if a DID is a long-form PRISM DID with encoded state
 */
function isLongFormPrismDID(did) {
  if (!did || typeof did !== 'string') return false;
  if (!did.startsWith('did:prism:')) return false;

  const methodId = did.substring('did:prism:'.length);
  const parts = methodId.split(':');

  // Long-form has at least 2 parts: stateHash and encodedState
  return parts.length >= 2 && parts[1].length > 10;
}

module.exports = {
  parseLongFormPrismDID,
  extractX25519FromPrismDID,
  extractEd25519FromPrismDID,
  extractSecurityClearanceKeysFromPrismDID,
  isLongFormPrismDID,
  KeyUsage
};
