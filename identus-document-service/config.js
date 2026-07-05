'use strict';

module.exports = {
  PORT: parseInt(process.env.PORT || '3020', 10),

  // Enterprise Cloud Agent — used for DID resolution and revocation checking
  // Multitenancy agent (8200) — hosts all company tenants including ACME and Techcorp
  ENTERPRISE_CLOUD_AGENT_URL:     process.env.ENTERPRISE_CLOUD_AGENT_URL || 'http://91.99.4.54:8200',
  ENTERPRISE_CLOUD_AGENT_API_KEY: process.env.ENTERPRISE_CLOUD_AGENT_API_KEY || '',

  // Iagon decentralized storage
  IAGON_ACCESS_TOKEN:    process.env.IAGON_ACCESS_TOKEN || '',
  IAGON_NODE_ID:         process.env.IAGON_NODE_ID || '',
  IAGON_DOWNLOAD_BASE_URL: process.env.IAGON_DOWNLOAD_BASE_URL || 'https://gw.iagon.com/api/v2',

  // Optional fallback audit webhook when the DID document has no AuditLog endpoint
  AUDIT_FALLBACK_URL: process.env.AUDIT_FALLBACK_URL || '',

  // Request timeout for outbound HTTP calls (ms)
  REQUEST_TIMEOUT_MS: parseInt(process.env.REQUEST_TIMEOUT_MS || '15000', 10),

  // Admin API key for write operations (Create, Update, Delete)
  // Generate: openssl rand -hex 32
  ADMIN_API_KEY: process.env.ADMIN_API_KEY || '',

  // Iagon fileId of the document-index.json blob (for GET /documents)
  // Auto-created on first POST /documents. Update .env after each restart.
  DOCUMENT_INDEX_FILE_ID: process.env.DOCUMENT_INDEX_FILE_ID || '',

  // Public base URL of this service — embedded in DID #access service endpoints
  // Example: https://identuslabel.cz/document-service
  DOCUMENT_SERVICE_URL: process.env.DOCUMENT_SERVICE_URL || '',

  // Company Admin Portal — orchestrates DIDComm two-step credential collection
  COMPANY_ADMIN_URL: process.env.COMPANY_ADMIN_URL || 'http://localhost:3010',
  COMPANY_ADMIN_KEY: process.env.COMPANY_ADMIN_KEY || '',

  // Public-facing URL of company-admin — embedded in DID #document-access-gate service endpoints
  // so the wallet can reach the challenge endpoint from the browser.
  // Falls back to COMPANY_ADMIN_URL if not set (only works when localhost is reachable from browser).
  COMPANY_ADMIN_PUBLIC_URL: process.env.COMPANY_ADMIN_PUBLIC_URL || process.env.COMPANY_ADMIN_URL || 'http://localhost:3010',
};
