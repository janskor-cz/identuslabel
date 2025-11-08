/**
 * Company Configuration Module
 *
 * Stores company credentials and configuration for multitenancy Cloud Agent access.
 * Each company has its own wallet, entity, API key, and PRISM DID on the multitenancy
 * Cloud Agent (port 8200).
 */

// Company database with multitenancy credentials
const COMPANIES = {
  techcorp: {
    id: 'techcorp',
    name: 'TechCorp',
    displayName: 'TechCorp Corporation',
    tagline: 'Technology & Innovation',
    walletId: '40e3db59-afcb-46f7-ae39-47417ad894d9',
    entityId: 'e69b1c94-727f-43e9-af8e-ad931e714f68',
    apiKey: 'b45cde041306c6bceafee5b1da755e49635ad1cd132b26964136a81dda3e0aa2',
    did: 'did:prism:6ee757c2913a76aa4eb2f09e9cd3cc40ead73cfaffc7d712c303ee5bc38f21bf',
    didLongForm: 'did:prism:6ee757c2913a76aa4eb2f09e9cd3cc40ead73cfaffc7d712c303ee5bc38f21bf:Co4CCosCEj4KCmF1dGgta2V5LTEQBEouCglzZWNwMjU2azESIQOtdk47gktIBvwPkAYQuTdyUHYIA0NWs9mYkoglI5yHwRJDCg9hc3NlcnRpb24ta2V5LTEQAkouCglzZWNwMjU2azESIQLpkOdvBBdHkKH0URJD0lafXWUtMgVofrMxyI1jrRrIihI7CgdtYXN0ZXIwEAFKLgoJc2VjcDI1NmsxEiECAUDMz9RRpA5ym9lPWG49OtEPuypROGaStfRhHOh8SZcaRwoPY29tcGFueS13ZWJzaXRlEhFbIkxpbmtlZERvbWFpbnMiXRohWyJodHRwczovL3RlY2hjb3JwLmV4YW1wbGUuY29tLyJd',
    website: 'https://techcorp.example.com',
    publicKeys: [
      { id: 'auth-key-1', purpose: 'authentication' },
      { id: 'assertion-key-1', purpose: 'assertionMethod' }
    ],
    services: [
      { id: 'company-website', type: 'LinkedDomains', endpoint: 'https://techcorp.example.com' }
    ],
    color: '#2563eb', // Blue
    logo: '🏢'
  },

  acme: {
    id: 'acme',
    name: 'ACME',
    displayName: 'ACME Corporation',
    tagline: 'Quality Products & Services',
    walletId: '5d177000-bb54-43c2-965c-76e58864975a',
    entityId: 'e7537e1d-47c2-4a83-a48d-b063e9126858',
    apiKey: 'a5b2c19cd9cfe9ff0b9f7bacfdc9d097ae02074b3ef7b03981a8d837c0d0a784',
    did: 'did:prism:474c91516a875ba9af9f39a3b9747cb70ad7684f0b3fb8ee2b7b145efac286b9',
    didLongForm: 'did:prism:474c91516a875ba9af9f39a3b9747cb70ad7684f0b3fb8ee2b7b145efac286b9:CooCCocCEj4KCmF1dGgta2V5LTEQBEouCglzZWNwMjU2azESIQLYJ05jN3hyjwC2iJwie3Ee7yYKCgaPaaSc330emAr0ExJDCg9hc3NlcnRpb24ta2V5LTEQAkouCglzZWNwMjU2azESIQJ9M-31iCzlwZ2xhjTGE0ciVRBIl18ydyjoMXmF0WNsChI7CgdtYXN0ZXIwEAFKLgoJc2VjcDI1NmsxEiEDwP4ceur18yS8V3UaDC5KA7EKaUIC56M_mpQxh1bcnXEaQwoPY29tcGFueS13ZWJzaXRlEhFbIkxpbmtlZERvbWFpbnMiXRodWyJodHRwczovL2FjbWUuZXhhbXBsZS5jb20vIl0',
    website: 'https://acme.example.com',
    publicKeys: [
      { id: 'auth-key-1', purpose: 'authentication' },
      { id: 'assertion-key-1', purpose: 'assertionMethod' }
    ],
    services: [
      { id: 'company-website', type: 'LinkedDomains', endpoint: 'https://acme.example.com' }
    ],
    color: '#059669', // Green
    logo: '🔨'
  },

  evilcorp: {
    id: 'evilcorp',
    name: 'EvilCorp',
    displayName: 'EvilCorp Industries',
    tagline: 'Strategic Operations',
    walletId: '3d06f2e3-0c04-4442-8a3d-628f66bf5c72',
    entityId: '2f0aa374-8876-47b0-9935-7978f3135ec1',
    apiKey: '83732572365e98bc866e2247a268366b55c44a66348854e98866c4d44e0480a7',
    did: 'did:prism:1706a8c2adaace6cb5e6b90c94f20991fa7bf4257a9183d69da5c45153f9ca73',
    didLongForm: 'did:prism:1706a8c2adaace6cb5e6b90c94f20991fa7bf4257a9183d69da5c45153f9ca73:Co4CCosCEj4KCmF1dGgta2V5LTEQBEouCglzZWNwMjU2azESIQObWTBIOLetESbatQfaTR1VeSp8v6lNube8aeVFNq9lExJDCg9hc3NlcnRpb24ta2V5LTEQAkouCglzZWNwMjU2azESIQOYAEm_2FzoQYIjfI_1Kj0V5fiyT__OKX9UhC6VCt5E-BI7CgdtYXN0ZXIwEAFKLgoJc2VjcDI1NmsxEiEDjUBJu9j-_4rkAdoCkl7HdRqlT-F0WgLQVn8UropoSwQaRwoPY29tcGFueS13ZWJzaXRlEhFbIkxpbmtlZERvbWFpbnMiXRohWyJodHRwczovL2V2aWxjb3JwLmV4YW1wbGUuY29tLyJd',
    website: 'https://evilcorp.example.com',
    publicKeys: [
      { id: 'auth-key-1', purpose: 'authentication' },
      { id: 'assertion-key-1', purpose: 'assertionMethod' }
    ],
    services: [
      { id: 'company-website', type: 'LinkedDomains', endpoint: 'https://evilcorp.example.com' }
    ],
    color: '#dc2626', // Red
    logo: '🏴'
  }
};

// Multitenancy Cloud Agent configuration
const MULTITENANCY_CLOUD_AGENT_URL = 'http://91.99.4.54:8200';

/**
 * Get company by ID
 * @param {string} companyId - Company identifier
 * @returns {Object|null} Company object or null if not found
 */
function getCompany(companyId) {
  return COMPANIES[companyId] || null;
}

/**
 * Get all companies as array
 * @returns {Array} Array of company objects
 */
function getAllCompanies() {
  return Object.values(COMPANIES);
}

/**
 * Validate company ID
 * @param {string} companyId - Company identifier to validate
 * @returns {boolean} True if company exists
 */
function isValidCompany(companyId) {
  return companyId in COMPANIES;
}

module.exports = {
  COMPANIES,
  MULTITENANCY_CLOUD_AGENT_URL,
  getCompany,
  getAllCompanies,
  isValidCompany
};
