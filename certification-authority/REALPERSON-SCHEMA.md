# RealPerson Identity Credential Schema

## Overview

The RealPerson credential system provides simplified digital identity verification and issuance capabilities through the Certification Authority. This system issues official identity credentials to real persons connected to holder wallets.

## Schema Definition

### RealPerson Schema v1.0.0
**Purpose**: Simplified identity credential for real persons

**Schema Structure**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://certification-authority.org/schemas/RealPerson/1.0.0",
  "type": "object",
  "properties": {
    "firstName": {
      "type": "string",
      "description": "Legal first name of the person"
    },
    "lastName": {
      "type": "string", 
      "description": "Legal last name of the person"
    },
    "gender": {
      "type": "string",
      "description": "Gender of the person"
    },
    "dateOfBirth": {
      "type": "string",
      "description": "Date of birth in YYYY-MM-DD format"
    },
    "uniqueId": {
      "type": "string",
      "description": "Unique identifier for the person (e.g., national ID, SSN)"
    }
  },
  "required": ["firstName", "lastName", "gender", "dateOfBirth", "uniqueId"]
}
```

**All fields are required** - This ensures complete identity verification.

## Metadata

- **Name**: RealPerson
- **Version**: 1.0.0
- **Description**: Simplified identity credential for real persons
- **Type**: https://w3c-ccg.github.io/vc-json-schemas/schema/2.0/schema.json
- **Tags**: ["identity", "official"]
- **Author**: Certification Authority DID

## API Endpoints

### Schema Management
- `POST /api/schemas/create-realperson` - Initialize RealPerson schema in cloud agent
- `GET /api/schemas` - List all available schemas including RealPerson

### Credential Operations  
- `POST /api/credentials/issue-realperson` - Issue RealPerson credential to a connection
- `GET /api/credentials/issued` - View all issued credentials including RealPerson

### Credential Definition
- `POST /api/credential-definitions/create` - Create credential definition from RealPerson schema

## User Interface

### Access Points
- **Main Portal**: http://91.99.4.54:3005
- **RealPerson Interface**: http://91.99.4.54:3005/realperson.html

### Portal Features
- Create and manage RealPerson schema
- Issue credentials to connected wallets
- View issued credentials
- Manage credential definitions

## Issuance Workflow

1. **Schema Creation**: CA creates RealPerson schema in cloud agent
2. **Credential Definition**: Create credential definition from schema
3. **Connection**: Establish DIDComm connection with holder wallet
4. **Data Collection**: Collect required identity information
5. **Credential Issuance**: Issue RealPerson credential to holder
6. **Verification**: Holder can present credential for verification

## Implementation Notes

- Schema is created dynamically using the CA's published DID
- The CA DID must have an assertion method key for signing credentials
- Credentials are issued through the cloud agent's credential issuance API
- All fields are validated before issuance

## Current CA DID
`did:prism:28010ce1448e4b0043a3e2766bb0fdec9b05fb5cb7ba3d6cc13197289f5e7e79` (Published) ✅

### Published Schema Details
- **Schema GUID**: `de45078e-2d5f-30e6-bb5e-296bab76fe52`
- **Schema Author DID**: `did:prism:3b3b7e39bade2ed377ccce90a32f3f88614616b4d80e9c35b70ae76ba2b437ed` (CREATED)
- **Published**: 2025-09-28T09:50:27.877974Z
- **Cloud Agent URL**: `http://91.99.4.54:8000/schema-registry/schemas/de45078e-2d5f-30e6-bb5e-296bab76fe52`

### Assertion Key Verification
The CA DID includes proper assertion keys for credential signing:
- **Assertion Key**: `#assertion-key` (secp256k1)
- **Authentication Key**: `#auth-key` (secp256k1)

## DID Creation Procedure Documentation

### ✅ Current Implementation (Verified 2025-09-28)
The `/api/create-did` endpoint in `server.js` (lines 245-246) properly includes assertion keys:

```javascript
publicKeys: [{
  id: 'auth-key',
  purpose: 'authentication'
}, {
  id: 'assertion-key',
  purpose: 'assertionMethod'
}]
```

### Future DID Requirements
**CRITICAL**: All future CA DIDs MUST include:
1. **Authentication Key** - For connection establishment and general authentication
2. **Assertion Key** - Required for credential signing and schema authoring
3. **No Services Required** - Keep DID document minimal for security

### Troubleshooting
If credential issuance fails with "assertion key not found":
1. Verify DID has `assertionMethod` in its DID document
2. Check DID status is `PUBLISHED` (not just `CREATED`)
3. Ensure latest DID is being used for schema authoring