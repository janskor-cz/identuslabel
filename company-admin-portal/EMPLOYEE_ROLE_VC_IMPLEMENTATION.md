# EmployeeRole VC Implementation - Complete

## Overview

Successfully extended the Employee Wallet Manager to automatically issue an EmployeeRole Verifiable Credential (VC) during employee onboarding. The workflow now consists of 12 steps instead of 11, with the final step issuing a credential containing the employee's role, department, and employment details.

## Implementation Summary

### Files Modified

1. **`/root/company-admin-portal/lib/EmployeeWalletManager.js`**
   - Added Step 12: Issue EmployeeRole VC
   - Updated all step counters from `/11` to `/12`
   - Added `issueEmployeeRoleVC()` helper function (160+ lines)
   - Enhanced to handle credential offer acceptance flow
   - Returns credential recordId in employee data

### Key Features

- **Automatic Issuance**: Uses `automaticIssuance: true` for streamlined flow
- **Bidirectional Flow**:
  1. TechCorp creates credential offer
  2. Employee wallet receives and accepts offer
  3. TechCorp automatically approves and issues credential
- **Error Handling**: Comprehensive error handling with rollback on failure
- **Performance**: Completes in ~26-30 seconds total (including DID publication)

## 12-Step Workflow

1. **Create Wallet** - Employee wallet in Enterprise Cloud Agent
2. **Create Entity** - Authentication entity linked to wallet
3. **Register API Key** - 64-char hex authentication token
4. **Create PRISM DID** - Blockchain-anchored DID with dual keys
5. **Publish DID** - Submit to Cardano blockchain
6. **Wait for Publication** - Poll until confirmed (~28 seconds)
7. **Create TechCorp Invitation** - DIDComm invitation from company
8. **Accept Invitation** - Employee accepts connection
9. **Wait Employee Connection** - Poll until established
10. **Wait TechCorp Connection** - Poll until established
11. **Connection Established** - Bidirectional DIDComm ready
12. **Issue EmployeeRole VC** - Credential with role/department ← **NEW**

## EmployeeRole VC Structure

### Schema
- **GUID**: `1c7eb9ab-a765-3d3a-88b2-c528ea3f6444`
- **Name**: EmployeeRole
- **Format**: JWT

### Credential Subject
```json
{
  "prismDid": "did:prism:...",           // Employee's PRISM DID
  "employeeId": "alice",                 // From email prefix
  "role": "Senior Engineer",             // Job role
  "department": "Engineering",           // Department
  "hireDate": "2025-11-20T10:44:59Z",    // Current timestamp
  "effectiveDate": "2025-11-20T10:44:59Z", // Current timestamp
  "expiryDate": "2026-11-20T10:44:59Z"   // +1 year
}
```

## Technical Details

### Credential Issuance Flow

1. **TechCorp Creates Offer** (Port 8200)
   - Uses TechCorp's published DID as issuer
   - Sets `automaticIssuance: true`
   - Creates offer with EmployeeRole schema

2. **Employee Receives Offer** (Port 8300)
   - Polls for offers matching thid
   - Waits for `OfferReceived` state
   - Accepts offer with employee's DID as subject

3. **TechCorp Issues Credential**
   - Automatically approves due to `automaticIssuance`
   - Transitions through states:
     - `OfferSent` → `RequestReceived` → `CredentialSent`
   - Returns when `CredentialSent` reached

### API Endpoints Used

- `POST /issue-credentials/credential-offers` - Create offer
- `GET /issue-credentials/records` - List credential records
- `POST /issue-credentials/records/{id}/accept-offer` - Accept offer
- `GET /issue-credentials/records/{id}` - Check status

## Test Results

### Successful Test Run
```
✅ All 12 steps completed successfully!

Employee wallet created successfully!
   Wallet ID: f5500b80-1d99-4c85-8694-4e7088f40ba4
   PRISM DID: did:prism:34691f21774f73ae8fc2d6edc1a645fb72c193f7d9c407082f06556110a040de
   TechCorp Connection: 483d92b5-63c6-455e-a343-fc00a7d9051c
   Employee Connection: 7ba2e239-4c58-49a0-bb4f-3477c48a6f3a
   EmployeeRole VC: b26f26dc-1236-44ee-883f-38df774ac8ae

Total time: 26.4 seconds
```

### Performance Metrics

| Step | Duration |
|------|----------|
| Steps 1-4 (Wallet/DID Creation) | ~2 seconds |
| Steps 5-6 (DID Publication) | ~15-28 seconds |
| Steps 7-11 (Connection) | ~2 seconds |
| Step 12 (VC Issuance) | ~3-5 seconds |
| **Total** | **~26-35 seconds** |

## Usage

### Create Employee with Role VC
```javascript
const { createEmployeeWallet } = require('./lib/EmployeeWalletManager');

const employeeData = {
  email: 'alice@techcorp.com',
  name: 'Alice Cooper',
  department: 'Engineering',
  role: 'Senior Engineer'  // Used in EmployeeRole VC
};

const result = await createEmployeeWallet(employeeData);
console.log('Employee onboarded with VC:', result.employeeRoleCredentialId);
```

### Test Script
```bash
# Run complete test
node /root/company-admin-portal/test-employee-with-role-vc.js
```

## Return Object

The `createEmployeeWallet()` function now returns:
```javascript
{
  email: 'alice@techcorp.com',
  name: 'Alice Cooper',
  department: 'Engineering',
  walletId: 'uuid',
  entityId: 'uuid',
  apiKey: '64-char-hex',
  prismDid: 'did:prism:longform...',
  canonicalDid: 'did:prism:shortform...',
  techCorpConnectionId: 'uuid',
  employeeConnectionId: 'uuid',
  employeeRoleCredentialId: 'uuid',  // NEW: VC record ID
  created: '2025-11-20T10:44:59Z'
}
```

## Future Enhancements

1. **Database Integration**
   - Store credential recordId in employee database
   - Track credential status and expiry
   - Enable credential revocation

2. **Additional VCs**
   - Department access credentials
   - Training certificates
   - Security clearances

3. **Credential Management**
   - Renewal before expiry
   - Role change updates
   - Revocation on termination

4. **UI Integration**
   - Display VC in Company Admin Portal
   - Show credential details
   - Enable manual re-issuance

## Backward Compatibility

- All existing functionality preserved
- Steps 1-11 unchanged (only step counts updated)
- Return object extended with new field
- No breaking changes to API

## Success Criteria Met ✅

- [x] Employee onboarding creates wallet
- [x] Publishes PRISM DID to blockchain
- [x] Establishes DIDComm connection
- [x] Issues EmployeeRole VC automatically
- [x] VC contains employee's PRISM DID
- [x] VC automatically accepted by employee
- [x] Function returns credential recordId
- [x] All 12 steps complete successfully

## Conclusion

The EmployeeRole VC implementation is fully operational and production-ready. Employees now automatically receive a verifiable credential containing their role and department information as part of the onboarding process, enabling them to prove their employment status and access role-based resources within the enterprise SSI ecosystem.