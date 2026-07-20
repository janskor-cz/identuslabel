// Security Key TypeScript Interfaces for Ed25519-based Security Clearance VCs

// Individual key component for dual-key structure
export interface KeyComponent {
  // Optional: keys created after the seed-derivation fix are never persisted with
  // private key bytes (see keyIndex on SecurityKeyDual) - they're re-derived on demand
  // via getSecurityKeyPrivateMaterial(). Only present on legacy entries predating that
  // fix, or on transient Pluto-fallback entries assembled at read time.
  privateKeyBytes?: string;  // base64url encoded
  publicKeyBytes: string;   // base64url encoded
  fingerprint: string;      // SHA256 hash formatted as XX:XX:XX...
  curve: 'Ed25519' | 'X25519';
  purpose: 'signing' | 'encryption';
}

// Dual-key structure (new - supports both Ed25519 signing and X25519 encryption)
export interface SecurityKeyDual {
  keyId: string;
  ed25519: KeyComponent;
  x25519: KeyComponent;
  // HD derivation index used to create this key from the wallet seed (see keyDerivation.ts).
  // Each "Generate New Key" click uses the next unused index so distinct clicks yield
  // genuinely distinct key material, while every key stays re-derivable from the seed alone.
  // Optional: entries created before this field existed (legacy localStorage data) or
  // assembled transiently from a Pluto DID lookup genuinely lack it at runtime - the type
  // must reflect that rather than claiming a guarantee older/foreign data doesn't meet.
  keyIndex?: number;
  label?: string;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  usageCount: number;
}

// Legacy single-key structure (maintain backward compatibility)
export interface SecurityKeyLegacy {
  keyId: string;
  privateKeyBytes: string;
  publicKeyBytes: string;
  fingerprint: string;
  curve: 'Ed25519';
  purpose: 'security-clearance';
  label?: string;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  usageCount: number;
}

// Union type for storage compatibility
export type SecurityKey = SecurityKeyDual | SecurityKeyLegacy;

// Type guard to check if a key is dual-key or legacy
export function isDualKey(key: SecurityKey): key is SecurityKeyDual {
  return 'ed25519' in key && 'x25519' in key;
}

export interface SecurityKeyPair {
  privateKey: any;  // SDK.Domain.PrivateKey instance
  publicKey: any;   // SDK.Domain.PublicKey instance
  curve: string;    // SDK.Domain.Curve value
}

// CA submission payload for dual-key credentials
export interface SecurityKeyExportDual {
  ed25519PublicKey: string;
  ed25519Fingerprint: string;
  x25519PublicKey: string;
  x25519Fingerprint: string;
  createdAt: string;
  keyId: string;
}

// Legacy export format (backward compatibility)
export interface SecurityKeyExportLegacy {
  publicKeyBytes: string;             // Public key for CA submission
  fingerprint: string;                // Key fingerprint for identification
  algorithm: 'Ed25519';               // Algorithm identifier
  createdAt: string;                  // Creation timestamp
  keyId: string;                      // Key identifier
}

// Union type for export compatibility
export type SecurityKeyExport = SecurityKeyExportDual | SecurityKeyExportLegacy;

// Storage structure with version tracking
export interface SecurityKeyStorage {
  keys: SecurityKey[];                // Array of all stored keys
  activeKeyId?: string;               // Currently active key for operations
  version: '1.0' | '2.0';            // Version 1.0: legacy single-key, Version 2.0: dual-key support
}