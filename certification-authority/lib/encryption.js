/**
 * Server-Side Encryption Utility for Secure Dashboard
 *
 * Encrypts content using X25519 key agreement (NaCl box) for secure
 * client-side decryption via BroadcastChannel API.
 *
 * Compatible with wallet's decryptMessage() function.
 */

const sodium = require('libsodium-wrappers');

// CA's ephemeral X25519 keypair (generated once per server instance)
let caKeypair = null;

/**
 * Base64URL encoding/decoding utilities
 * Must match wallet's base64url format
 */
const base64url = {
  /**
   * Encode buffer to base64url string
   * @param {Uint8Array|Buffer} buffer - Data to encode
   * @returns {string} Base64URL encoded string
   */
  encode: (buffer) => {
    return Buffer.from(buffer)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  },

  /**
   * Decode base64url string to buffer
   * @param {string} str - Base64URL encoded string
   * @returns {Buffer} Decoded buffer
   */
  decode: (str) => {
    // Restore standard base64 format
    str = str.replace(/-/g, '+').replace(/_/g, '/');

    // Add padding if needed
    while (str.length % 4) {
      str += '=';
    }

    return Buffer.from(str, 'base64');
  }
};

/**
 * Get or create CA's X25519 keypair
 * Generates once per server instance, reused for all encryptions
 *
 * @returns {{publicKey: Uint8Array, privateKey: Uint8Array}} CA keypair
 */
async function getCAKeypair() {
  if (!caKeypair) {
    await sodium.ready;
    caKeypair = sodium.crypto_box_keypair();
    console.log('[CA Encryption] Generated new CA X25519 keypair');
    console.log('[CA Encryption] CA Public Key:', base64url.encode(caKeypair.publicKey));
  }
  return caKeypair;
}

/**
 * Encrypt plaintext for specific user using their X25519 public key
 *
 * Uses NaCl box (XSalsa20-Poly1305) for authenticated encryption.
 * Format matches wallet's EncryptedMessageBody structure.
 *
 * @param {string} plaintext - Content to encrypt
 * @param {string} userX25519PublicKeyBase64 - User's X25519 public key (base64url)
 * @returns {Promise<Object>} Encrypted message object
 *
 * @example
 * const encrypted = await encryptForUser(
 *   "Confidential project details...",
 *   "user_x25519_public_key_base64url"
 * );
 */
async function encryptForUser(plaintext, userX25519PublicKeyBase64) {
  try {
    await sodium.ready;

    // Decode user's public key
    const userPublicKey = base64url.decode(userX25519PublicKeyBase64);

    if (userPublicKey.length !== 32) {
      throw new Error(`Invalid X25519 public key length: ${userPublicKey.length} (expected 32 bytes)`);
    }

    // Get CA's keypair
    const caKeypair = await getCAKeypair();

    // Generate random nonce (24 bytes for XSalsa20)
    const nonce = sodium.randombytes_buf(24);

    // Convert plaintext to bytes
    const messageBytes = new TextEncoder().encode(plaintext);

    // Encrypt using NaCl box
    // crypto_box_easy(message, nonce, recipientPublicKey, senderPrivateKey)
    const ciphertext = sodium.crypto_box_easy(
      messageBytes,
      nonce,
      userPublicKey,
      caKeypair.privateKey
    );

    console.log(`[CA Encryption] Encrypted ${plaintext.length} bytes for user`);
    console.log(`[CA Encryption] Ciphertext length: ${ciphertext.length} bytes`);

    // Return format compatible with wallet's decryptMessage()
    return {
      encrypted: true,
      algorithm: 'XSalsa20-Poly1305',
      version: '2.0',
      ciphertext: base64url.encode(ciphertext),
      nonce: base64url.encode(nonce),
      senderPublicKey: base64url.encode(caKeypair.publicKey),
      recipientPublicKey: userX25519PublicKeyBase64
    };

  } catch (error) {
    console.error('[CA Encryption] Encryption failed:', error.message);
    throw new Error(`Encryption failed: ${error.message}`);
  }
}

/**
 * Verify encryption setup is working
 * Used for testing/debugging
 *
 * @returns {Promise<boolean>} True if encryption is available
 */
async function verifyEncryptionAvailable() {
  try {
    await sodium.ready;
    const testKeypair = await getCAKeypair();
    return testKeypair && testKeypair.publicKey && testKeypair.privateKey;
  } catch (error) {
    console.error('[CA Encryption] Verification failed:', error.message);
    return false;
  }
}

module.exports = {
  encryptForUser,
  base64url,
  getCAKeypair,
  verifyEncryptionAvailable
};
