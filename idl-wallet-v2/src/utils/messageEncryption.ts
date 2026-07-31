/**
 * Message Encryption/Decryption using NaCl Box (XSalsa20-Poly1305)
 *
 * Implements authenticated encryption for DIDComm messages using:
 * - Native X25519 keys from Security Clearance VCs (no conversion required)
 * - XSalsa20-Poly1305 authenticated encryption (NaCl box)
 * - Base64url encoding for wire format
 *
 * Version 2.0: Simplified implementation eliminating Ed25519→X25519 runtime conversion
 */

import * as nacl from 'tweetnacl';
import * as sodium from 'libsodium-wrappers';
import { base64url } from 'jose';
import { getItem, setItem, removeItem, getKeysByPattern } from './prefixedStorage';

/**
 * Encrypted message body structure
 * This replaces the plaintext message body in DIDComm messages
 */
export interface EncryptedMessageBody {
  /** Indicates this is an encrypted message */
  encrypted: true;

  /** Encryption algorithm identifier */
  algorithm: 'XSalsa20-Poly1305';

  /** Encryption format version
   * - '1.0': Legacy Ed25519→X25519 conversion (deprecated)
   * - '2.0': Native X25519 keys (current)
   */
  version: '1.0' | '2.0';

  /** Encrypted message content (base64url encoded) */
  ciphertext: string;

  /** 24-byte nonce for XSalsa20-Poly1305 (base64url encoded) */
  nonce: string;

  /** Recipient's X25519 public key (base64url encoded) */
  recipientPublicKey: string;

  /** Sender's X25519 public key used for encryption (base64url encoded) */
  senderPublicKey: string;
}

/**
 * Encrypt a plaintext message using NaCl box authenticated encryption
 *
 * Simplified native X25519 implementation - no Ed25519 conversion required.
 *
 * Process:
 * 1. Validate native X25519 keys (always 32 bytes each)
 * 2. Generate random 24-byte nonce
 * 3. Perform authenticated encryption using ECDH + XSalsa20-Poly1305
 * 4. Return encrypted message structure
 *
 * @param plaintext - Message content to encrypt
 * @param senderX25519PrivateKey - Sender's X25519 private key (32 bytes)
 * @param senderX25519PublicKey - Sender's X25519 public key (32 bytes)
 * @param recipientX25519PublicKey - Recipient's X25519 public key (32 bytes)
 * @returns Encrypted message body structure
 *
 * @throws Error if keys are invalid
 * @throws Error if encryption fails
 *
 * @example
 * const senderPrivateKey = base64url.decode(senderKey.privateKeyBytes);  // 32 bytes X25519
 * const senderPublicKey = base64url.decode(senderKey.publicKeyBytes);    // 32 bytes X25519
 * const recipientPublicKey = base64url.decode(recipientVC.credentialSubject.publicKey);
 *
 * const encrypted = await encryptMessage(
 *   "The package arrives at midnight",
 *   senderPrivateKey,
 *   senderPublicKey,
 *   recipientPublicKey
 * );
 *
 * // encrypted.ciphertext contains encrypted content
 * // encrypted.nonce contains unique nonce
 */
export async function encryptMessage(
  plaintext: string,
  senderX25519PrivateKey: Uint8Array,
  senderX25519PublicKey: Uint8Array,
  recipientX25519PublicKey: Uint8Array
): Promise<EncryptedMessageBody> {
  if (!plaintext) {
    throw new Error('[messageEncryption] Plaintext message cannot be empty');
  }

  // Validate X25519 keys (always 32 bytes)
  if (senderX25519PrivateKey.length !== 32 || senderX25519PublicKey.length !== 32 || recipientX25519PublicKey.length !== 32) {
    throw new Error(`[messageEncryption] Invalid key lengths (expected 32 bytes each)`);
  }

  try {
    console.log('🔐 [messageEncryption] Encrypting with native X25519 keys');

    const nonce = nacl.randomBytes(24);
    const messageBytes = new TextEncoder().encode(plaintext);

    const ciphertext = nacl.box(
      messageBytes,
      nonce,
      recipientX25519PublicKey,
      senderX25519PrivateKey
    );

    if (!ciphertext) {
      throw new Error('[messageEncryption] Encryption failed');
    }

    console.log('✅ [messageEncryption] Message encrypted', {
      plaintextLength: plaintext.length,
      ciphertextLength: ciphertext.length
    });

    return {
      encrypted: true,
      algorithm: 'XSalsa20-Poly1305',
      version: '2.0',
      ciphertext: base64url.encode(ciphertext),
      nonce: base64url.encode(nonce),
      recipientPublicKey: base64url.encode(recipientX25519PublicKey),
      senderPublicKey: base64url.encode(senderX25519PublicKey)
    };
  } catch (error) {
    console.error('❌ [messageEncryption] Encryption error:', error);
    throw error;
  }
}

/**
 * Decrypt an encrypted message using NaCl box authenticated decryption
 *
 * Simplified native X25519 implementation - no Ed25519 conversion required.
 *
 * Process:
 * 1. Extract sender's X25519 public key from message metadata
 * 2. Validate native X25519 keys (always 32 bytes each)
 * 3. Decode ciphertext and nonce from base64url
 * 4. Perform authenticated decryption using ECDH + XSalsa20-Poly1305
 * 5. Return plaintext message
 *
 * @param encryptedBody - Encrypted message body structure (includes senderPublicKey)
 * @param recipientX25519PrivateKey - Recipient's X25519 private key (32 bytes)
 * @param recipientX25519PublicKey - Recipient's X25519 public key (32 bytes)
 * @returns Decrypted plaintext message
 *
 * @throws Error if keys are invalid
 * @throws Error if decryption fails (wrong key or tampered message)
 *
 * @example
 * const recipientPrivateKey = base64url.decode(recipientKey.privateKeyBytes);  // 32 bytes X25519
 * const recipientPublicKey = base64url.decode(recipientKey.publicKeyBytes);    // 32 bytes X25519
 *
 * const plaintext = await decryptMessage(
 *   encryptedMessageBody,
 *   recipientPrivateKey,
 *   recipientPublicKey
 * );
 *
 * console.log('Decrypted:', plaintext);
 * // "The package arrives at midnight"
 */
export async function decryptMessage(
  encryptedBody: EncryptedMessageBody,
  recipientX25519PrivateKey: Uint8Array,
  recipientX25519PublicKey: Uint8Array
): Promise<string> {
  if (!encryptedBody || !encryptedBody.encrypted) {
    throw new Error('[messageEncryption] Invalid encrypted message body');
  }
  if (encryptedBody.algorithm !== 'XSalsa20-Poly1305') {
    throw new Error(`[messageEncryption] Unsupported algorithm: ${encryptedBody.algorithm}`);
  }

  // Validate X25519 keys
  if (recipientX25519PrivateKey.length !== 32 || recipientX25519PublicKey.length !== 32) {
    throw new Error(`[messageEncryption] Invalid key lengths (expected 32 bytes each)`);
  }

  try {
    console.log('🔍 [messageEncryption] Decrypting with native X25519 keys');

    const senderX25519Public = base64url.decode(encryptedBody.senderPublicKey);
    const ciphertext = base64url.decode(encryptedBody.ciphertext);
    const nonce = base64url.decode(encryptedBody.nonce);

    if (nonce.length !== 24) {
      throw new Error(`[messageEncryption] Invalid nonce length: ${nonce.length}`);
    }

    const plaintext = nacl.box.open(
      ciphertext,
      nonce,
      senderX25519Public,
      recipientX25519PrivateKey
    );

    if (!plaintext) {
      throw new Error('[messageEncryption] Decryption failed - invalid key or corrupted message');
    }

    const decryptedText = new TextDecoder().decode(plaintext);
    console.log('✅ [messageEncryption] Message decrypted successfully');
    return decryptedText;

  } catch (error) {
    console.error('❌ [messageEncryption] Decryption error:', error);
    throw error;
  }
}

/**
 * Validate that an encrypted message body has the correct structure
 *
 * @param body - Potential encrypted message body
 * @returns true if valid, false otherwise
 */
export function isValidEncryptedMessageBody(body: any): body is EncryptedMessageBody {
  return (
    body &&
    body.encrypted === true &&
    body.algorithm === 'XSalsa20-Poly1305' &&
    (body.version === '1.0' || body.version === '2.0') &&
    typeof body.ciphertext === 'string' &&
    typeof body.nonce === 'string' &&
    typeof body.recipientPublicKey === 'string'
  );
}

/**
 * Get encryption metadata for logging/debugging
 *
 * @param encryptedBody - Encrypted message body
 * @returns Metadata object (safe to log - no secrets)
 */
export function getEncryptionMetadata(encryptedBody: EncryptedMessageBody) {
  return {
    algorithm: encryptedBody.algorithm,
    version: encryptedBody.version,
    ciphertextLength: encryptedBody.ciphertext.length,
    noncePreview: encryptedBody.nonce.substring(0, 12) + '...',
    recipientKeyPreview: encryptedBody.recipientPublicKey.substring(0, 12) + '...'
  };
}

/**
 * 🧪 TEST: Minimal encryption/decryption roundtrip test
 *
 * Tests if encryption→decryption works locally without DIDComm transmission.
 * This isolates crypto logic from message routing/storage issues.
 *
 * @param alicePrivateKey - Alice's Ed25519 private key (64 bytes)
 * @param alicePublicKey - Alice's Ed25519 public key (32 bytes)
 * @param bobPrivateKey - Bob's Ed25519 private key (64 bytes)
 * @param bobPublicKey - Bob's Ed25519 public key (32 bytes)
 * @returns Test result with detailed diagnostics
 */
export async function testEncryptionRoundtrip(
  alicePrivateKey: Uint8Array,
  alicePublicKey: Uint8Array,
  bobPrivateKey: Uint8Array,
  bobPublicKey: Uint8Array
): Promise<{
  success: boolean;
  encrypted?: EncryptedMessageBody;
  decrypted?: string;
  error?: string;
  diagnostics: {
    alicePublicKeyHex: string;
    bobPublicKeyHex: string;
    encryptionSuccess: boolean;
    decryptionSuccess: boolean;
    keyConversionConsistent: boolean;
  };
}> {
  console.group('🧪 [TEST] Encryption/Decryption Roundtrip Test');

  const testMessage = 'TEST_ROUNDTRIP_MESSAGE';
  const diagnostics = {
    alicePublicKeyHex: Array.from(alicePublicKey).map(b => b.toString(16).padStart(2, '0')).join(''),
    bobPublicKeyHex: Array.from(bobPublicKey).map(b => b.toString(16).padStart(2, '0')).join(''),
    encryptionSuccess: false,
    decryptionSuccess: false,
    keyConversionConsistent: false
  };

  try {
    // Re-derive libsodium public keys from seeds to ensure consistency
    // (SDK-derived public keys differ from libsodium-derived ones)
    console.log('🔄 Re-deriving libsodium public keys from seeds...');

    await sodium.ready;

    const aliceSeed = alicePrivateKey.slice(0, 32);
    const aliceKeypair = sodium.crypto_sign_seed_keypair(aliceSeed);
    alicePublicKey = aliceKeypair.publicKey;

    const bobSeed = bobPrivateKey.slice(0, 32);
    const bobKeypair = sodium.crypto_sign_seed_keypair(bobSeed);
    bobPublicKey = bobKeypair.publicKey;

    console.log('✅ Public keys re-derived using libsodium');

    console.log('📝 Test message:', testMessage);
    console.log('👤 Alice public key (hex):', diagnostics.alicePublicKeyHex);
    console.log('👤 Bob public key (hex):', diagnostics.bobPublicKeyHex);

    // Step 1: Alice encrypts message for Bob
    console.log('\n📤 Step 1: Alice encrypts message for Bob...');
    const encrypted = await encryptMessage(
      testMessage,
      alicePrivateKey,
      alicePublicKey,
      bobPublicKey
    );

    diagnostics.encryptionSuccess = true;
    console.log('✅ Encryption succeeded');
    console.log('   Ciphertext length:', encrypted.ciphertext.length);
    console.log('   Nonce length:', encrypted.nonce.length);

    // Step 2: Test key conversion consistency
    console.log('\n🔍 Step 2: Testing Ed25519→X25519 conversion consistency...');
    await sodium.ready;

    // Convert Bob's key twice and compare
    const bobX25519_1 = sodium.crypto_sign_ed25519_pk_to_curve25519(bobPublicKey);
    const bobX25519_2 = sodium.crypto_sign_ed25519_pk_to_curve25519(bobPublicKey);

    const conversionMatch = Array.from(bobX25519_1).every((byte, idx) => byte === bobX25519_2[idx]);
    diagnostics.keyConversionConsistent = conversionMatch;

    if (conversionMatch) {
      console.log('✅ Ed25519→X25519 conversion is DETERMINISTIC');
      console.log('   Bob X25519 public key:', base64url.encode(bobX25519_1));
    } else {
      console.error('❌ Ed25519→X25519 conversion is NON-DETERMINISTIC!');
      console.error('   First conversion:', base64url.encode(bobX25519_1));
      console.error('   Second conversion:', base64url.encode(bobX25519_2));
    }

    // Step 3: Bob decrypts message from Alice
    console.log('\n📥 Step 3: Bob decrypts message from Alice...');
    const decrypted = await decryptMessage(
      encrypted,
      bobPrivateKey,
      bobPublicKey
    );

    diagnostics.decryptionSuccess = true;
    console.log('✅ Decryption succeeded');
    console.log('   Decrypted text:', decrypted);

    // Step 4: Verify roundtrip
    console.log('\n🔄 Step 4: Verifying roundtrip...');
    if (decrypted === testMessage) {
      console.log('✅✅✅ ROUNDTRIP SUCCESS! Message matches exactly.');
      console.groupEnd();
      return {
        success: true,
        encrypted,
        decrypted,
        diagnostics
      };
    } else {
      console.error('❌ ROUNDTRIP FAILED! Message mismatch:');
      console.error('   Original:', testMessage);
      console.error('   Decrypted:', decrypted);
      console.groupEnd();
      return {
        success: false,
        encrypted,
        decrypted,
        error: `Message mismatch: expected "${testMessage}", got "${decrypted}"`,
        diagnostics
      };
    }

  } catch (error) {
    console.error('❌ TEST FAILED:', error);
    console.groupEnd();
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      diagnostics
    };
  }
}

/**
 * 🧪 TEST HELPER: Simplified encryption/decryption test using localStorage keys
 *
 * Automatically retrieves Alice's security clearance keys from current wallet's localStorage.
 * Prompts user to provide Bob's keys (copy from Bob's console).
 * Tests local encryption→decryption without DIDComm transmission.
 *
 * @returns Test result with success status and diagnostics
 *
 * @example
 * // In Bob's wallet console (http://91.99.4.54:3002):
 * JSON.parse(localStorage.getItem('security-clearance-keys'))
 * // Copy the output
 *
 * // In Alice's wallet console (http://91.99.4.54:3001):
 * await window.testEncryptionWithStoredKeys()
 * // Paste Bob's keys when prompted
 */
export async function testEncryptionWithStoredKeys(): Promise<{
  success: boolean;
  encrypted?: EncryptedMessageBody;
  decrypted?: string;
  error?: string;
  diagnostics?: {
    alicePublicKeyHex: string;
    bobPublicKeyHex: string;
    encryptionSuccess: boolean;
    decryptionSuccess: boolean;
    keyConversionConsistent: boolean;
  };
  hint?: string;
}> {
  try {
    console.log('🧪 [testEncryptionWithStoredKeys] Starting test...');

    // STEP 1: Get Alice's keys from current wallet's localStorage
    console.log('🔍 [testEncryptionWithStoredKeys] Retrieving Alice keys from localStorage...');
    const aliceStorageJson = getItem('security-clearance-keys');

    if (!aliceStorageJson) {
      return {
        success: false,
        error: 'No security-clearance-keys found in Alice wallet localStorage',
        hint: 'Generate a Security Clearance key first: Settings → Security Clearance Key Manager → Generate Key'
      };
    }

    const aliceStorage = JSON.parse(aliceStorageJson);
    const aliceKey = aliceStorage.keys?.[0];

    if (!aliceKey) {
      return {
        success: false,
        error: 'security-clearance-keys exists but no keys found in keys array',
        hint: 'Generate a Security Clearance key first: Settings → Security Clearance Key Manager → Generate Key'
      };
    }

    console.log('✅ [testEncryptionWithStoredKeys] Alice key found:', {
      keyId: aliceKey.keyId,
      fingerprint: aliceKey.fingerprint?.substring(0, 20) + '...'
    });

    // STEP 2: Prompt user for Bob's keys
    console.log('🔍 [testEncryptionWithStoredKeys] Prompting for Bob keys...');
    const bobKeysJson = prompt(
      'Paste Bob\'s keys from Bob wallet console:\n\n' +
      'Run this in Bob\'s wallet (http://91.99.4.54:3002):\n' +
      'window.prefixedStorageDebug.getItem("security-clearance-keys")\n\n' +
      'Then copy the entire output and paste here:'
    );

    if (!bobKeysJson) {
      return {
        success: false,
        error: 'No Bob keys provided - test cancelled'
      };
    }

    let bobStorage;
    try {
      bobStorage = JSON.parse(bobKeysJson);
    } catch (parseError) {
      return {
        success: false,
        error: 'Failed to parse Bob keys JSON: ' + (parseError instanceof Error ? parseError.message : String(parseError)),
        hint: 'Make sure you copied the ENTIRE JSON output from Bob\'s console'
      };
    }

    const bobKey = bobStorage.keys?.[0];

    if (!bobKey) {
      return {
        success: false,
        error: 'Bob keys JSON parsed but no keys found in keys array',
        hint: 'Bob needs to generate a Security Clearance key first'
      };
    }

    console.log('✅ [testEncryptionWithStoredKeys] Bob key found:', {
      keyId: bobKey.keyId,
      fingerprint: bobKey.fingerprint?.substring(0, 20) + '...'
    });

    // STEP 3: Decode base64url keys to Uint8Array
    console.log('🔄 [testEncryptionWithStoredKeys] Decoding base64url keys...');

    // Helper to decode base64url (handles both standard base64 and base64url)
    const decodeBase64url = (str: string): Uint8Array => {
      // Convert base64url to base64
      const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
      // Decode to bytes
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    };

    const alicePriv = decodeBase64url(aliceKey.privateKeyBytes);
    const alicePub = decodeBase64url(aliceKey.publicKeyBytes);
    const bobPriv = decodeBase64url(bobKey.privateKeyBytes);
    const bobPub = decodeBase64url(bobKey.publicKeyBytes);

    console.log('✅ [testEncryptionWithStoredKeys] Keys decoded:', {
      alicePrivLength: alicePriv.length,
      alicePubLength: alicePub.length,
      bobPrivLength: bobPriv.length,
      bobPubLength: bobPub.length
    });

    // STEP 4: Run the encryption roundtrip test
    console.log('🧪 [testEncryptionWithStoredKeys] Running encryption roundtrip test...');
    const result = await testEncryptionRoundtrip(alicePriv, alicePub, bobPriv, bobPub);

    console.log('🧪 [testEncryptionWithStoredKeys] Test completed:', result);
    return result;

  } catch (error) {
    console.error('❌ [testEncryptionWithStoredKeys] Unexpected error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
