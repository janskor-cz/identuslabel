# Credential Schema Registry Documentation

## Overview

This document describes the credential schemas registered in the Hyperledger Identus Cloud Agent Schema Registry for TechCorp's employee credential management system.

## Registered Schemas

### 1. EmployeeRole Schema

**Purpose**: Define employee role and position within the organization

**Schema Details**:
- **Name**: EmployeeRole
- **Version**: 1.0.0
- **GUID**: `1c7eb9ab-a765-3d3a-88b2-c528ea3f6444`
- **Author**: TechCorp (`did:prism:6ee757c2913a76aa4eb2f09e9cd3cc40ead73cfaffc7d712c303ee5bc38f21bf`)

**Schema Fields**:
| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `prismDid` | string | Employee's PRISM DID | `did:prism:abc123...` |
| `employeeId` | string | Internal employee identifier | `alice` |
| `role` | string | Job role/title | `Senior Engineer` |
| `department` | string | Department assignment | `Engineering` |
| `hireDate` | string | Employment start date (ISO 8601) | `2024-06-15` |
| `effectiveDate` | string | Credential effective date-time | `2025-11-20T10:30:28.562Z` |
| `expiryDate` | string | Credential expiry date-time | `2026-11-20T10:30:28.562Z` |

**Use Cases**:
- Employee identification within organization
- Role-based access control
- Department affiliation verification
- Employment verification

### 2. CISTrainingCertificate Schema

**Purpose**: Corporate Information Security (CIS) training completion certificate

**Schema Details**:
- **Name**: CISTrainingCertificate
- **Version**: 1.0.0
- **GUID**: `bc954e49-5cb0-38a8-90a6-4142c0222de3`
- **Author**: TechCorp (`did:prism:6ee757c2913a76aa4eb2f09e9cd3cc40ead73cfaffc7d712c303ee5bc38f21bf`)

**Schema Fields**:
| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `prismDid` | string | Employee's PRISM DID | `did:prism:abc123...` |
| `employeeId` | string | Internal employee identifier | `alice` |
| `trainingYear` | string | Training year | `2025` |
| `completionDate` | string | Training completion date-time | `2025-11-20T10:30:28.791Z` |
| `certificateNumber` | string | Unique certificate identifier | `CIS-1763634628792-alice` |
| `expiryDate` | string | Certificate expiry date-time | `2026-11-20T10:30:28.792Z` |

**Use Cases**:
- Compliance training verification
- Security awareness certification
- Annual training requirements tracking
- Audit trail for security training

### 3. ServiceConfiguration Schema (Existing)

**Purpose**: Configuration for Enterprise Cloud Agent access

**Schema Details**:
- **Name**: ServiceConfiguration
- **Version**: 3.0.0
- **GUID**: `8fb9b1d4-a47a-3f60-8bf1-1145d3eaab72`
- **Author**: TechCorp

**Schema Fields**:
| Field | Type | Description |
|-------|------|-------------|
| `enterpriseAgentUrl` | string | Enterprise Cloud Agent URL |
| `enterpriseAgentName` | string | Display name for the agent |
| `enterpriseAgentApiKey` | string | API key for authentication |
| `enterpriseAgentWalletId` | string | Wallet identifier |

## Schema Management

### Registration Script

Register or update schemas using:
```bash
cd /root/company-admin-portal
node register-schemas.js [options]

Options:
  --use-multitenancy  Use Multitenancy Cloud Agent (port 8200)
  --cloud-agent <url> Use custom Cloud Agent URL
  --clear-cache       Clear cached schema GUIDs
```

### Environment Variables

After registration, add the schema GUIDs to your `.env` file:
```env
EMPLOYEE_ROLE_SCHEMA_GUID=1c7eb9ab-a765-3d3a-88b2-c528ea3f6444
CIS_TRAINING_SCHEMA_GUID=bc954e49-5cb0-38a8-90a6-4142c0222de3
SERVICE_CONFIG_SCHEMA_GUID=8fb9b1d4-a47a-3f60-8bf1-1145d3eaab72
```

### Testing Credential Issuance

Test credential issuance with registered schemas:
```bash
cd /root/company-admin-portal
node test-schema-credentials.js
```

## API Integration

### SchemaManager Class

The `SchemaManager` class provides methods for schema operations:

```javascript
const SchemaManager = require('./lib/SchemaManager');
const schemaManager = new SchemaManager(cloudAgentUrl, apiKey);

// Register schemas
const employeeRoleGuid = await schemaManager.registerEmployeeRoleSchema(authorDID);
const cisTrainingGuid = await schemaManager.registerCISTrainingSchema(authorDID);

// Get schema by GUID
const schema = await schemaManager.getSchema(schemaGuid);

// List all schemas
const schemas = await schemaManager.listSchemas({ author: authorDID });
```

### Issuing Credentials

Example credential offer using registered schema:
```javascript
const credentialOffer = {
    connectionId: connectionId,
    credentialFormat: 'JWT',
    claims: {
        prismDid: employeeDID,
        employeeId: 'alice',
        role: 'Senior Engineer',
        department: 'Engineering',
        hireDate: '2024-06-15',
        effectiveDate: new Date().toISOString(),
        expiryDate: expiryDate.toISOString()
    },
    schemaId: `${CLOUD_AGENT_URL}/schema-registry/schemas/${EMPLOYEE_ROLE_SCHEMA_GUID}`,
    issuingDID: issuerDID,
    automaticIssuance: false
};
```

## W3C Compliance

All schemas are designed to be compliant with:
- W3C Verifiable Credentials Data Model 1.0
- W3C JSON-LD 1.1
- JSON Schema Draft 2020-12

The schemas use minimal field definitions to maintain compatibility with the Hyperledger Identus Cloud Agent's strict validation requirements.

## Schema Cache

Schema GUIDs are cached locally in `.schema-cache.json` to avoid redundant registrations:
```json
{
  "employeeRoleSchemaGuid": "1c7eb9ab-a765-3d3a-88b2-c528ea3f6444",
  "cisTrainingSchemaGuid": "bc954e49-5cb0-38a8-90a6-4142c0222de3"
}
```

## Troubleshooting

### Common Issues

1. **Schema validation errors**: The Cloud Agent has strict validation. Use simple type definitions without additional constraints.

2. **409 Conflict**: Schema with same name/version already exists. The system will attempt to find and use the existing schema.

3. **API key authentication**: Ensure the correct API key is used for the target Cloud Agent.

## Future Enhancements

- [ ] Add more employee credential types (access badges, certifications)
- [ ] Implement schema versioning strategy
- [ ] Add schema migration tools
- [ ] Create UI for schema management in Company Admin Portal
- [ ] Add support for credential revocation lists

## References

- [W3C Verifiable Credentials](https://www.w3.org/TR/vc-data-model/)
- [JSON Schema](https://json-schema.org/)
- [Hyperledger Identus Documentation](https://docs.atalaprism.io/)