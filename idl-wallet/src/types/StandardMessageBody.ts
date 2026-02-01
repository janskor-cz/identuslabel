/**
 * Standard Message Body Format
 *
 * Unifies encrypted and plaintext messages with consistent structure
 * including timestamp and encryption metadata
 */

export interface StandardMessageBody {
  /** Message content - plaintext for unencrypted, "[ENCRYPTED]" placeholder for encrypted */
  content: string;

  /** Unix timestamp (milliseconds) when message was created */
  timestamp: number;

  /** True if message is encrypted */
  encrypted: boolean;

  /** Security classification level (only for encrypted messages) */
  securityLevel?: "UNCLASSIFIED" | "CONFIDENTIAL" | "SECRET" | "TOP-SECRET";

  /** Numeric security level (only for encrypted messages) */
  classificationNumeric?: number;

  /** Encryption metadata (only if encrypted === true) */
  encryptionMeta?: {
    /** Encryption algorithm used */
    algorithm: string;

    /** Base64url-encoded ciphertext */
    ciphertext: string;

    /** Base64url-encoded 24-byte nonce */
    nonce: string;

    /** Base64url-encoded recipient's X25519 public key */
    recipientPublicKey: string;

    /** Base64url-encoded sender's X25519 public key (used for encryption) */
    senderPublicKey: string;
  };
}

/**
 * Type guard to check if body is StandardMessageBody format
 */
export function isStandardMessageBody(body: any): body is StandardMessageBody {
  return (
    body &&
    typeof body === "object" &&
    "content" in body &&
    "timestamp" in body &&
    "encrypted" in body &&
    typeof body.content === "string" &&
    typeof body.timestamp === "number" &&
    typeof body.encrypted === "boolean"
  );
}

/**
 * Create standard message body for plaintext message
 */
export function createPlaintextMessageBody(content: string): StandardMessageBody {
  return {
    content,
    timestamp: Date.now(),
    encrypted: false,
  };
}

/**
 * Create standard message body for encrypted message
 */
export function createEncryptedMessageBody(
  ciphertext: string,
  nonce: string,
  recipientPublicKey: string,
  senderPublicKey: string,
  algorithm: string,
  securityLevel: string,
  classificationNumeric: number
): StandardMessageBody {
  return {
    content: "[ENCRYPTED]",
    timestamp: Date.now(),
    encrypted: true,
    securityLevel: securityLevel as any,
    classificationNumeric,
    encryptionMeta: {
      algorithm,
      ciphertext,
      nonce,
      recipientPublicKey,
      senderPublicKey,
    },
  };
}
