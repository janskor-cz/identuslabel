# W3C-Compliant Credential Schemas Reference

**Quick Reference Guide for Registered Schemas**

---

## Registered Schemas

### RealPerson v3.0.0

**Schema GUID**: `e3ed8a7b-5866-3032-a06c-4c3ce7b7c73f`

**Schema ID**: `did:prism:7fb0da715eed1451ac442cb3f8fbf73a084f8f73af16521812edd22d27d8f91c/20a78dc2-2d6c-450f-a8a6-65ff4218e08f?version=3.0.0`

**Cloud Agent URL**: `http://91.99.4.54:8000/cloud-agent/schema-registry/schemas/e3ed8a7b-5866-3032-a06c-4c3ce7b7c73f`

**File**: `/root/certification-authority/realperson-schema-v3-simplified.json`

**Fields**:
- `credentialType` (auto): `"RealPersonIdentity"`
- `firstName` (user): Person's first name
- `lastName` (user): Person's last name
- `uniqueId` (user): Unique identifier (e.g., SSN)
- `dateOfBirth` (user): ISO 8601 date
- `gender` (user): Gender identity
- `issuedDate` (auto): Issuance date
- `expiryDate` (auto): Expiration date (2 years)
- `credentialId` (auto): Unique ID (pattern: `REALPERSON-{timestamp}-{random}`)

**Validity**: 2 years (63,072,000 seconds)

---

### SecurityClearanceLevel v4.0.0

**Schema GUID**: `ba309a53-9661-33df-92a3-2023b4a56fd5`

**Schema ID**: `did:prism:7fb0da715eed1451ac442cb3f8fbf73a084f8f73af16521812edd22d27d8f91c/365b8597-d6c8-4782-af4e-1bed81485a81?version=4.0.0`

**Cloud Agent URL**: `http://91.99.4.54:8000/cloud-agent/schema-registry/schemas/ba309a53-9661-33df-92a3-2023b4a56fd5`

**File**: `/root/certification-authority/security-clearance-schema-v4-simplified.json`

**Fields**:
- `credentialType` (auto): `"SecurityClearance"`
- `clearanceLevel` (user): INTERNAL | CONFIDENTIAL | RESTRICTED | TOP-SECRET
- `holderName` (user): Full name
- `holderUniqueId` (user): Unique identifier
- `ed25519PublicKey` (user): Ed25519 signing public key
- `ed25519Fingerprint` (user): Ed25519 key fingerprint
- `x25519PublicKey` (user): X25519 encryption public key
- `x25519Fingerprint` (user): X25519 key fingerprint
- `issuedDate` (auto): Issuance date
- `expiryDate` (auto): Expiration date (varies by level)
- `clearanceId` (auto): Unique ID (pattern: `CLEARANCE-{level}-{timestamp}-{random}`)

**Validity Periods**:
- CONFIDENTIAL: 2 years (63,072,000 sec)
- TOP-SECRET: 1 year (31,536,000 sec)
- RESTRICTED: 6 months (15,768,000 sec)
- INTERNAL: 1 year (31,536,000 sec)

---

## Key Features

**Auto-Population**: Server automatically adds metadata fields
- `credentialType`: Identifies credential category in wallet
- `issuedDate`: Current date (ISO 8601)
- `expiryDate`: Calculated based on validity period
- `credentialId` / `clearanceId`: Unique timestamp-based identifiers

**Wallet Display**:
- RealPerson: `"John Doe (ID) [Exp: 2yr]"`
- SecurityClearance: `"John Doe (Clearance) [Exp: 1yr]"`

**Security**:
- Private keys generated client-side only (never transmitted)
- Dual-key support (Ed25519 + X25519) for clearance credentials
- StatusList2021 revocation support (Cloud Agent native)

---

## CA Server Endpoints

**Issue RealPerson**: `POST /api/credentials/issue-realperson`
- Implementation: `/root/certification-authority/server.js` lines 1802-1836

**Issue SecurityClearance**: `POST /api/credentials/issue-security-clearance`
- Implementation: `/root/certification-authority/server.js` lines 3618-3655

---

## Wallet Integration

**Credential Naming Utility**:
- `/root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/{alice,bob}-wallet/src/utils/credentialNaming.ts`
- Extracts user-friendly names with expiration tracking

**Display Features**:
- Smart expiration display (days < 30, months < 365, years >= 365)
- Credential type badges: `(ID)` or `(Clearance)`
- EXPIRED indicator for past expiration dates
- Auto-refresh status badges every 30 seconds

---

## Schema History

**RealPerson**:
- v2.0.0: Basic identity fields only
- v3.0.0 (current): Added auto-populated metadata fields

**SecurityClearanceLevel**:
- v1.0.0: Single clearance level (CONFIDENTIAL), no keys
- v2.0.0: Ed25519 only
- v3.0.0: Dual-key nested structure
- v4.0.0 (current): Flattened dual-key structure with metadata

---

## Quick Commands

**List All Schemas**:
```bash
curl -s http://91.99.4.54:8000/schema-registry/schemas | jq '.contents[]'
```

**Get RealPerson v3.0.0**:
```bash
curl -s http://91.99.4.54:8000/schema-registry/schemas/e3ed8a7b-5866-3032-a06c-4c3ce7b7c73f | jq '.'
```

**Get SecurityClearanceLevel v4.0.0**:
```bash
curl -s http://91.99.4.54:8000/schema-registry/schemas/ba309a53-9661-33df-92a3-2023b4a56fd5 | jq '.'
```

---

**Document Version**: 1.0
**Last Updated**: 2025-10-28
**Status**: Production-Ready
**See Also**: `/root/clean-identus-wallet/CLAUDE.md` for comprehensive documentation
