/**
 * walletCrypto.ts
 *
 * Client-side encryption/decryption for Iagon wallet backups.
 * Uses WebCrypto API: PBKDF2 for key derivation, AES-256-GCM for encryption.
 *
 * The plaintext wallet backup is NEVER sent to the server unencrypted.
 * The server only stores the opaque encrypted blob in Iagon.
 */

export interface WalletBackupPayload {
    /** Identus SDK seed bytes serialized as a number array */
    seedValue: number[];
    /** JWE string from agent.backup.createJWE() */
    jwe: string;
    /** Wallet username for verification on restore */
    username: string;
    createdAt: string;
    version: 2;
}

interface EncryptedEnvelope {
    /** Base64-encoded 12-byte GCM IV */
    iv: string;
    /** Base64-encoded AES-256-GCM ciphertext + authTag (16 bytes appended by SubtleCrypto) */
    ciphertext: string;
    /** PBKDF2 salt (base64-encoded 16 bytes) */
    salt: string;
}

function bufToB64(buf: ArrayBuffer | Uint8Array): string {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

function b64ToBuf(b64: string): Uint8Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

/** SHA-256 of "username_lowercase:password" → 64-char hex. Server-side registry key (username never sent). */
export async function generateCredentialHash(username: string, password: string): Promise<string> {
    const enc = new TextEncoder();
    const hashBuf = await crypto.subtle.digest('SHA-256', enc.encode(`${username.toLowerCase()}:${password}`));
    return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 of the raw JWE string → 64-char hex. Stored in registry to detect wallet changes. */
export async function generateContentHash(jwe: string): Promise<string> {
    const enc = new TextEncoder();
    const hashBuf = await crypto.subtle.digest('SHA-256', enc.encode(jwe));
    return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function deriveKey(password: string, username: string, salt: Uint8Array): Promise<CryptoKey> {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
        'raw',
        enc.encode(password),
        'PBKDF2',
        false,
        ['deriveKey']
    );
    return crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: salt,
            iterations: 100_000,
            hash: 'SHA-256',
        },
        baseKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

/**
 * Encrypt wallet backup payload with the user's password.
 * Returns a base64-encoded JSON envelope safe for Iagon storage.
 */
export async function encryptBackup(
    payload: WalletBackupPayload,
    password: string,
    username: string
): Promise<string> {
    const enc = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, username, salt);

    const plaintext = enc.encode(JSON.stringify(payload));
    const ciphertextBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);

    const envelope: EncryptedEnvelope = {
        iv: bufToB64(iv),
        ciphertext: bufToB64(ciphertextBuf),
        salt: bufToB64(salt),
    };

    return btoa(JSON.stringify(envelope));
}

/**
 * Decrypt wallet backup envelope with the user's password.
 * Returns the parsed WalletBackupPayload.
 * Throws if password is wrong or data is corrupt.
 */
export async function decryptBackup(
    encryptedBase64: string,
    password: string,
    username: string
): Promise<WalletBackupPayload> {
    const envelope: EncryptedEnvelope = JSON.parse(atob(encryptedBase64));

    const salt = b64ToBuf(envelope.salt);
    const iv = b64ToBuf(envelope.iv);
    const ciphertext = b64ToBuf(envelope.ciphertext);

    const key = await deriveKey(password, username, salt);

    let plaintext: ArrayBuffer;
    try {
        plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    } catch {
        throw new Error('Incorrect password or corrupted backup');
    }

    const dec = new TextDecoder();
    return JSON.parse(dec.decode(plaintext)) as WalletBackupPayload;
}
