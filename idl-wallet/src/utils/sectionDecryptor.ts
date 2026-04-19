/**
 * sectionDecryptor.ts
 *
 * Client-side section decryption using Web Crypto API (AES-256-GCM).
 * Unwraps section keys from NaCl box, then decrypts each accessible section.
 * Inaccessible sections become [REDACTED] placeholders.
 */

import nacl from 'tweetnacl';
import type { EncryptedSection, SectionKeyEntry, WrappedSectionKey } from './KeyAuthorityClient';

export interface DecryptedSection {
  sectionId: string;
  clearance: string;
  clearanceLevel: number;
  accessible: true;
  plaintext: string;
  title?: string;
  tagName?: string;
  isInline?: boolean;
}

export interface RedactedSection {
  sectionId: string;
  clearance: string;
  clearanceLevel: number;
  accessible: false;
  title?: string;
  tagName?: string;
  isInline?: boolean;
}

export type SectionResult = DecryptedSection | RedactedSection;

/**
 * Unwrap a section key from a NaCl box and decrypt the section ciphertext.
 */
async function decryptOneSection(
  section: EncryptedSection,
  keyEntry: WrappedSectionKey,
  ephemeralSecretKey: Uint8Array
): Promise<string> {
  // 1. Unwrap section key: nacl.box.open(wrapped, nonce, serverPubKey, walletSecretKey)
  const wrapped   = new Uint8Array(Buffer.from(keyEntry.wrappedKey, 'base64'));
  const nonce     = new Uint8Array(Buffer.from(keyEntry.nonce, 'base64'));
  const serverPub = new Uint8Array(Buffer.from(keyEntry.serverEphemeralPublicKey, 'base64'));

  const sectionKeyBytes = nacl.box.open(wrapped, nonce, serverPub, ephemeralSecretKey);
  if (!sectionKeyBytes) {
    throw new Error(`Failed to unwrap section key for ${section.sectionId}`);
  }

  // 2. Import raw AES-256-GCM key
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    sectionKeyBytes.buffer as ArrayBuffer,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  // 3. Decrypt: Web Crypto expects ciphertext || authTag concatenated
  const ciphertext = Buffer.from(section.ciphertext, 'base64');
  const authTag    = Buffer.from(section.authTag,    'base64');
  const iv         = Buffer.from(section.iv,         'base64');

  // Concatenate ciphertext + authTag (GCM auth tag appended at end)
  const combined = new Uint8Array(ciphertext.length + authTag.length);
  combined.set(new Uint8Array(ciphertext), 0);
  combined.set(new Uint8Array(authTag), ciphertext.length);

  const plaintextBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(iv), tagLength: 128 },
    cryptoKey,
    combined
  );

  return new TextDecoder().decode(plaintextBuffer);
}

/**
 * Decrypt all accessible sections; mark inaccessible ones as redacted.
 *
 * @param encryptedSections   From KA response
 * @param sectionKeys         From KA response
 * @param ephemeralSecretKey  Wallet's ephemeral X25519 secret key (32 bytes)
 * @returns                   Array of decrypted or redacted sections
 */
export async function decryptSections(
  encryptedSections: EncryptedSection[],
  sectionKeys: SectionKeyEntry[],
  ephemeralSecretKey: Uint8Array
): Promise<SectionResult[]> {
  const keyMap = new Map<string, SectionKeyEntry>();
  for (const k of sectionKeys) keyMap.set(k.sectionId, k);

  const results: SectionResult[] = [];

  for (const section of encryptedSections) {
    const keyEntry = keyMap.get(section.sectionId);

    if (!keyEntry || !keyEntry.accessible) {
      results.push({
        sectionId:     section.sectionId,
        clearance:     section.clearance,
        clearanceLevel: section.clearanceLevel,
        accessible:    false,
        title:         section.title,
        tagName:       section.tagName,
        isInline:      section.isInline
      });
      continue;
    }

    try {
      const plaintext = await decryptOneSection(section, keyEntry as WrappedSectionKey, ephemeralSecretKey);
      results.push({
        sectionId:     section.sectionId,
        clearance:     section.clearance,
        clearanceLevel: section.clearanceLevel,
        accessible:    true,
        plaintext,
        title:         section.title,
        tagName:       section.tagName,
        isInline:      section.isInline
      });
    } catch (err) {
      console.error(`[sectionDecryptor] Failed to decrypt ${section.sectionId}:`, err);
      results.push({
        sectionId:     section.sectionId,
        clearance:     section.clearance,
        clearanceLevel: section.clearanceLevel,
        accessible:    false,
        title:         section.title,
        tagName:       section.tagName,
        isInline:      section.isInline
      });
    }
  }

  return results;
}
