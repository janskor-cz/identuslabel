# PRISM DID Key Fallback for Security Clearance VCs

**Status**: PRODUCTION READY
**Date**: December 5, 2025
**Version**: 1.0

---

## Overview

Added fallback mechanism to find encryption keys in Pluto (IndexedDB) when not found in localStorage. This enables Security Clearance VCs that use keys from the user's PRISM DID (created during CA connection).

---

## Key Features

- **Two-pass key lookup**: Fast localStorage check -> Pluto fallback
- **PRISM DID integration**: Keys created during CA connection work automatically
- **Fingerprint matching**: SHA-256 hash ensures correct key identification across ALL PRISM DIDs
- **Deferred WALLET_READY signal**: SecureDashboardBridge waits for agent before signaling readiness
- Both Ed25519 (signing) and X25519 (encryption) keys supported

---

## Technical Implementation

### New Utility: plutoKeyExtractor.ts

Extracts keys from PRISM DIDs stored in Pluto:

```typescript
// Extract keys from specific PRISM DID
export async function extractKeysFromPrismDID(
  agent: SDK.Agent,
  prismDID: string
): Promise<PlutoExtractedKeys | null>

// Search all PRISM DIDs for a fingerprint match
export async function findKeyByFingerprintInPluto(
  agent: SDK.Agent,
  targetFingerprint: string
): Promise<{ key: KeyComponent; prismDID: string } | null>

// Convert Pluto keys to SecurityKeyDual format
export function plutoKeysToSecurityKeyDual(
  plutoKeys: PlutoExtractedKeys
): SecurityKeyDual | null
```

### Async Key Lookup Function

`getSecurityKeyByFingerprintAsync()` provides async lookup with Pluto fallback:

```typescript
export async function getSecurityKeyByFingerprintAsync(
  fingerprint: string,
  agent?: SDK.Agent
): Promise<SecurityKeyDual | null>
```

### Two-Pass Lookup Strategy

1. **Pass 1 (sync)**: Check localStorage for manually generated security keys
2. **Pass 2 (async)**: If agent available, search Pluto for PRISM DID keys

---

## Deferred WALLET_READY Fix

### Problem
Dashboard popup received `WALLET_READY` before agent was started, causing "Security clearance keys not found" errors.

### Root Cause
`initSecureDashboardBridge()` sent signal immediately at app startup, before agent initialization.

### Solution
Moved `WALLET_READY` to `setSecureDashboardAgent()` - sent only when agent is available.

### Flow
1. Dashboard opens popup
2. Bridge initializes (stores walletId, sets up listener)
3. User clicks "Start" in wallet popup
4. Agent starts -> `setSecureDashboardAgent(agent)` called
5. `WALLET_READY` sent to dashboard
6. Dashboard sends `DECRYPT_REQUEST`
7. Wallet decrypts (Pluto fallback now available)

---

## Files Modified

| File | Changes |
|------|---------|
| `src/utils/plutoKeyExtractor.ts` | **NEW**: Pluto key extraction utility |
| `src/utils/keyVCBinding.ts` | Added `getSecurityKeyByFingerprintAsync()` with fallback |
| `src/utils/SecureDashboardBridge.ts` | Deferred `WALLET_READY` signal after agent set |
| `src/components/Chat.tsx` | Two-pass decryption with Pluto fallback |
| `src/actions/index.ts` | Async key lookup + `setSecureDashboardAgent()` in error recovery |

---

## Key Storage Architecture

| Path | Key Generation | Storage | Lookup |
|------|----------------|---------|--------|
| Manual | SecurityClearanceKeyManager | localStorage | Sync (fast) |
| PRISM DID | createLongFormPrismDID | Pluto/IndexedDB | Async (fallback) |

---

## Fingerprint Format

SHA-256 hash of public key bytes, formatted as uppercase hex with colon separators:
```
AB:CD:EF:12:34:56:78:90:AB:CD:...
```

---

## Troubleshooting

### "Security clearance keys not found"

1. **Hard refresh** browser (Ctrl+Shift+R) to load updated code
2. Verify agent is started (click "Start" button)
3. Check if Security Clearance VC exists in wallet
4. Verify PRISM DID keys are stored in Pluto

### Decryption Fails Even With Keys

1. Check fingerprint in VC matches key fingerprint
2. Verify both Ed25519 and X25519 keys present
3. Check browser console for Pluto lookup logs

---

**Related Documentation**:
- [Wallet CLAUDE.md](../../clean-identus-wallet/CLAUDE.md) - Wallet implementation details
- [CHANGELOG.md](../../CHANGELOG.md) - Update history
