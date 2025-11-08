# Hyperledger Identus Edge Agent SDK Modifications

This document tracks all modifications made to the Hyperledger Identus Edge Agent SDK (v6.6.0) for this implementation.

---

## Overview

The base SDK is located at: `services/edge-wallets/sdk-ts/`

**Base Version**: 6.6.0

**Modifications**: Custom fixes for production stability and enhanced functionality

---

## Critical Fixes

### 1. Attachment Validation Error Fix (October 14, 2025)

**Issue**: Fatal `UnsupportedAttachmentType` exception causing wallet crashes when processing DIDComm messages with unknown attachment types.

**File**: `src/domain/models/Message.ts` (lines 104-142)

**Original Code** (threw fatal exception):
```typescript
if (attachmentDescriptor.data.base64) {
  // Handle base64 attachment
} else {
  throw new UnsupportedAttachmentType("Unsupported Attachment type");
}
```

**Fixed Code** (graceful handling):
```typescript
// Gracefully handle unsupported attachment types
const processedAttachments: AttachmentDescriptor[] = [];

for (const attachmentDescriptor of attachments || []) {
  try {
    if (attachmentDescriptor.data.base64) {
      // Process base64 attachment
      processedAttachments.push(attachment);
    } else if (attachmentDescriptor.data.json) {
      // Process JSON attachment
      processedAttachments.push(attachment);
    } else {
      // Log warning but don't throw exception
      console.warn(
        '⚠️ [Message.fromJson] Skipping unsupported attachment type:',
        attachmentDescriptor
      );
    }
  } catch (error) {
    console.warn(
      '⚠️ [Message.fromJson] Error processing attachment, skipping:',
      error
    );
  }
}

return new Message(
  body,
  id,
  piuri,
  processedAttachments, // Use filtered attachments
  // ... other fields
);
```

**Impact**:
- ✅ Wallets no longer crash on unknown attachment types
- ✅ DIDComm connection responses process successfully
- ✅ Warning logs help debug unsupported formats
- ✅ Empty attachment arrays handled gracefully

**Testing**:
```bash
# Verify fix
# 1. Create DIDComm invitation
# 2. Accept in wallet
# 3. Check browser console for warnings (not errors)
# Expected: "⚠️ [Message.fromJson] Skipping unsupported attachment type"
# NOT expected: "UnsupportedAttachmentType: Unsupported Attachment type"
```

---

## Deployment Process

### After Modifying SDK Source

**CRITICAL**: Simply rebuilding the SDK is NOT enough. You must copy the build to wallet `node_modules`.

**Full Deployment Steps**:

1. **Make changes** in `services/edge-wallets/sdk-ts/src/`

2. **Rebuild SDK**:
   ```bash
   cd services/edge-wallets/sdk-ts
   yarn build
   ```

3. **Copy build to Alice wallet**:
   ```bash
   cp -r build/* alice-wallet/node_modules/@hyperledger/identus-edge-agent-sdk/build/
   ```

4. **Copy build to Bob wallet**:
   ```bash
   cp -r build/* bob-wallet/node_modules/@hyperledger/identus-edge-agent-sdk/build/
   ```

5. **Clear Next.js cache (Alice)**:
   ```bash
   cd alice-wallet
   rm -rf .next
   ```

6. **Clear Next.js cache (Bob)**:
   ```bash
   cd bob-wallet
   rm -rf .next
   ```

7. **Restart Alice wallet**:
   ```bash
   cd alice-wallet
   fuser -k 3001/tcp
   yarn dev > /tmp/alice.log 2>&1 &
   ```

8. **Restart Bob wallet**:
   ```bash
   cd bob-wallet
   fuser -k 3002/tcp
   yarn dev > /tmp/bob.log 2>&1 &
   ```

9. **Verify users hard refresh**:
   - Users must hard refresh: `Ctrl+Shift+R` (Windows/Linux) or `Cmd+Shift+R` (Mac)
   - This clears browser cache and loads new SDK code

**Why This Is Necessary**:
- Wallets use the SDK from their local `node_modules/@hyperledger/identus-edge-agent-sdk/`
- Simply rebuilding the SDK in `sdk-ts/` doesn't update the wallet copies
- Next.js caches compiled code in `.next/` directory
- Browser caches JavaScript bundles

---

## Enhanced Functionality

### 1. X25519 Encryption Key Support

**Implementation**: Alice and Bob wallets generate X25519 key pairs for encrypted content decryption.

**Files Modified**:
- `alice-wallet/src/components/Credentials.tsx`
- `bob-wallet/src/components/Credentials.tsx`
- `alice-wallet/src/utils/SecureDashboardBridge.ts`
- `bob-wallet/src/utils/SecureDashboardBridge.ts`

**Key Generation**:
```typescript
import * as ed2curve from 'ed2curve';

// Convert Ed25519 seed to X25519 key pair
const x25519KeyPair = ed2curve.convertKeyPair({
  publicKey: ed25519PublicKey,
  secretKey: ed25519PrivateKey
});

const keys = {
  ed25519: {
    publicKeyHex: Buffer.from(ed25519PublicKey).toString('hex'),
    privateKeyHex: Buffer.from(ed25519PrivateKey).toString('hex')
  },
  x25519: {
    publicKeyBase64url: base64url.encode(Buffer.from(x25519KeyPair.publicKey)),
    privateKeyBytes: x25519KeyPair.secretKey
  }
};

// Store in localStorage
localStorage.setItem('wallet-alice-security-clearance-keys', JSON.stringify({
  keys: [keys],
  activeKeyIndex: 0
}));
```

**Usage**:
- Embedded in Security Clearance VC as `x25519PublicKey` field
- Used for client-side decryption of encrypted content
- Private key never transmitted to server

---

### 2. Bidirectional Message Decryption

**Issue**: Sender could not decrypt their own sent encrypted messages.

**Files Modified**:
- `alice-wallet/src/components/Chat.tsx` (lines 194-216)
- `bob-wallet/src/components/Chat.tsx` (lines 194-216)

**Fix**: Direction-based public key selection

```typescript
// Determine which public key to use based on message direction
const publicKeyToUse = message.direction === 0
  ? recipientX25519PublicKey  // SENT: Use recipient's public key
  : senderX25519PublicKey;    // RECEIVED: Use sender's public key

console.log(`🔑 [Chat] Message direction: ${message.direction === 0 ? 'SENT' : 'RECEIVED'}`);
console.log(`🔑 [Chat] Using public key from: ${message.direction === 0 ? 'recipient' : 'sender'}`);

// Decrypt using Diffie-Hellman shared secret
const plaintext = await decryptMessage(
  encryptedContent,
  myX25519PrivateKey,
  publicKeyToUse
);
```

**Mathematical Basis**:
- X25519 Diffie-Hellman property: `scalar_mult(A_private, B_public) === scalar_mult(B_private, A_public)`
- Alice encrypts to Bob: `shared_secret = scalar_mult(Alice_private, Bob_public)`
- Alice decrypts sent message: Uses same `shared_secret`
- Bob decrypts received message: `shared_secret = scalar_mult(Bob_private, Alice_public)` (same value!)

---

### 3. Secure Dashboard Bridge (postMessage API)

**Purpose**: Enable secure cross-window communication between CA dashboard and wallet for content decryption.

**Files Added**:
- `alice-wallet/src/utils/SecureDashboardBridge.ts`
- `bob-wallet/src/utils/SecureDashboardBridge.ts`

**Key Features**:
- Origin validation (whitelist)
- Message type routing (`DECRYPT_REQUEST`, `WALLET_READY`)
- Automatic response handling
- Diagnostic logging

**Origin Whitelist**:
```typescript
const ALLOWED_ORIGINS = [
  'https://identuslabel.cz',     // Production HTTPS
  'http://91.99.4.54:3005',      // Production HTTP (backward compat)
  'http://localhost:3005'        // Local development
];
```

**Message Flow**:
```typescript
// 1. Wallet sends ready signal
window.opener.postMessage(
  { type: 'WALLET_READY', walletId: 'alice' },
  'https://identuslabel.cz'
);

// 2. Dashboard sends decrypt request
walletWindow.postMessage(
  {
    type: 'DECRYPT_REQUEST',
    requestId: 'decrypt-section-123',
    sectionId: 'confidential-1',
    encryptedContent: { /* ... */ }
  },
  'https://identuslabel.cz'
);

// 3. Wallet decrypts and responds
window.opener.postMessage(
  {
    type: 'DECRYPT_RESPONSE',
    requestId: 'decrypt-section-123',
    sectionId: 'confidential-1',
    plaintext: 'Decrypted content here...'
  },
  'https://identuslabel.cz'
);
```

**Security**:
- All messages validated against origin whitelist
- Request IDs prevent replay attacks
- No sensitive data in unencrypted messages

---

## Custom Utilities

### 1. W3C VC Validation

**File**: `alice-wallet/src/utils/vcValidation.ts`, `bob-wallet/src/utils/vcValidation.ts`

**Purpose**: Extract and validate W3C VC fields from JWT credentials

```typescript
export const extractVCFields = (jwtCredential: string) => {
  const decoded = jwt.decode(jwtCredential, { complete: true });
  const vc = decoded?.payload?.vc;

  return {
    type: vc?.type || [],
    credentialSubject: vc?.credentialSubject || {},
    issuer: vc?.issuer || decoded?.payload?.iss,
    issuanceDate: vc?.issuanceDate || decoded?.payload?.nbf,
    expirationDate: vc?.expirationDate || decoded?.payload?.exp
  };
};
```

### 2. Universal VC Resolver

**File**: `alice-wallet/src/utils/UniversalVCResolver.ts`, `bob-wallet/src/utils/UniversalVCResolver.ts`

**Purpose**: Handle both Anoncreds and W3C VC formats uniformly

```typescript
export class UniversalVCResolver {
  static extractCredentialData(credential: any) {
    // Try W3C VC format first
    if (credential.credentialSubject) {
      return credential.credentialSubject;
    }

    // Try Anoncreds format
    if (credential.claims) {
      return credential.claims;
    }

    // Fallback to credential properties
    return credential.properties || {};
  }
}
```

### 3. Lazy SDK Loader

**File**: `alice-wallet/src/utils/LazySDKLoader.ts`, `bob-wallet/src/utils/LazySDKLoader.ts`

**Purpose**: Load large SDK dependencies on-demand to reduce initial bundle size

```typescript
export class LazySDKLoader {
  private static sdk: any = null;

  static async loadSDK() {
    if (!this.sdk) {
      this.sdk = await import('@hyperledger/identus-edge-agent-sdk');
    }
    return this.sdk;
  }
}
```

### 4. Memory Monitor

**File**: `alice-wallet/src/utils/MemoryMonitor.ts`, `bob-wallet/src/utils/MemoryMonitor.ts`

**Purpose**: Track WebAssembly memory usage and alert on leaks

```typescript
export class MemoryMonitor {
  static checkMemoryUsage() {
    if (performance.memory) {
      const used = performance.memory.usedJSHeapSize / 1048576;
      const total = performance.memory.totalJSHeapSize / 1048576;

      if (used > total * 0.9) {
        console.warn('⚠️ [MemoryMonitor] High memory usage, consider refreshing');
      }
    }
  }
}
```

---

## Testing SDK Modifications

### Verification Checklist

After deploying SDK changes:

- [ ] **Build successful**: `yarn build` completes without errors
- [ ] **Copied to wallets**: `build/` copied to both `node_modules`
- [ ] **Cache cleared**: `.next/` directories removed
- [ ] **Wallets restarted**: Development servers restarted
- [ ] **Hard refresh**: Browser cache cleared (Ctrl+Shift+R)
- [ ] **No console errors**: Browser console shows no SDK errors
- [ ] **DIDComm works**: Invitations and connections functional
- [ ] **Credentials work**: VC issuance and storage functional
- [ ] **Messages work**: DIDComm messaging functional (if applicable)

### Regression Testing

Test these flows after SDK changes:

1. **DIDComm Connection**:
   - Create invitation
   - Accept in wallet
   - Verify connection green

2. **Credential Issuance**:
   - Send offer
   - Accept in wallet
   - Approve in CA
   - Verify credential stored

3. **Message Processing**:
   - Send basic message
   - Verify no console errors
   - Check attachment handling

4. **X25519 Encryption** (if applicable):
   - Send encrypted message
   - Verify both sender and receiver can decrypt
   - Check console logs for success

---

## Future Considerations

### Potential SDK Enhancements

**Performance**:
- Optimize IndexedDB queries for large credential sets
- Implement credential caching strategies
- Reduce WebAssembly memory footprint

**Functionality**:
- Add support for W3C VC 2.0 data model
- Implement selective disclosure (BBS+ signatures)
- Add credential revocation check before presentation

**Security**:
- Implement hardware-backed key storage (WebAuthn)
- Add biometric authentication support
- Enhance secure storage encryption

**Developer Experience**:
- Add TypeScript strict mode support
- Improve error messages and diagnostics
- Add automated testing infrastructure

---

## Contributing SDK Fixes

If you discover SDK issues:

1. **Document the issue**:
   - Describe the problem
   - Provide reproduction steps
   - Include error messages

2. **Create a fix**:
   - Modify `sdk-ts/src/`
   - Test thoroughly
   - Document changes in this file

3. **Deploy the fix**:
   - Follow deployment process above
   - Verify in both wallets
   - Test all affected functionality

4. **Consider upstream contribution**:
   - Check if fix applies to base SDK
   - Open issue/PR in official SDK repo
   - Reference this implementation

---

## SDK File Structure

```
services/edge-wallets/sdk-ts/
├── src/
│   ├── domain/
│   │   ├── models/
│   │   │   ├── Message.ts          # ✅ MODIFIED: Attachment validation fix
│   │   │   └── ...
│   │   └── ...
│   ├── apollo/                     # Cryptography (Ed25519, X25519)
│   ├── castor/                     # DID resolution
│   ├── pluto/                      # Storage (IndexedDB)
│   ├── pollux/                     # Credentials (W3C VC, Anoncreds)
│   └── mercury/                    # DIDComm messaging
├── build/                          # Output directory
├── package.json
└── tsconfig.json

alice-wallet/
├── node_modules/
│   └── @hyperledger/identus-edge-agent-sdk/
│       └── build/                  # ✅ MUST COPY HERE after SDK rebuild
├── src/
│   ├── components/
│   │   ├── Chat.tsx                # ✅ MODIFIED: Bidirectional decryption
│   │   └── Credentials.tsx         # ✅ MODIFIED: X25519 key generation
│   └── utils/
│       ├── SecureDashboardBridge.ts # ✅ ADDED: postMessage bridge
│       ├── vcValidation.ts         # ✅ ADDED: W3C VC helpers
│       ├── UniversalVCResolver.ts  # ✅ ADDED: VC format handling
│       ├── LazySDKLoader.ts        # ✅ ADDED: Lazy loading
│       └── MemoryMonitor.ts        # ✅ ADDED: Memory tracking
└── ...

bob-wallet/                         # Same structure as alice-wallet
```

---

## Version History

| Date | Version | Changes |
|------|---------|---------|
| 2025-10-14 | 6.6.0+fix1 | Attachment validation graceful handling |
| 2025-10-25 | 6.6.0+fix2 | Bidirectional X25519 decryption |
| 2025-10-31 | 6.6.0+fix3 | Secure Dashboard Bridge (postMessage) |
| 2025-11-02 | 6.6.0+fix4 | Production-ready Phase 2 encryption |

---

## References

- **Base SDK**: https://github.com/hyperledger/identus-edge-agent-sdk-ts
- **SDK Documentation**: https://docs.atalaprism.io/
- **Issue Tracker**: https://github.com/hyperledger/identus-edge-agent-sdk-ts/issues

---

**Maintained By**: Hyperledger Identus SSI Infrastructure Team

**Last Updated**: 2025-11-08
