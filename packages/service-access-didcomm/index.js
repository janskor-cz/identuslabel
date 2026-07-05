'use strict';

const { ServiceAccessService, PROTOCOL_PREFIX, CapabilityError } = require('./lib/ServiceAccessService');
const { createTrustRegistry } = require('./lib/TrustRegistry');
const { createIssuerResolver } = require('./lib/issuerResolver');
const { extractClaims, classifyCredential, DEFAULT_CLAIM_RULES } = require('./lib/ClaimExtractor');
const { verifyPresentationCredentials } = require('./lib/verifyPresentation');
const { decodeJWT, verifyES256KSignature } = require('./lib/jwtCrypto');

module.exports = {
  ServiceAccessService,
  PROTOCOL_PREFIX,
  CapabilityError,
  createTrustRegistry,
  createIssuerResolver,
  extractClaims,
  classifyCredential,
  DEFAULT_CLAIM_RULES,
  verifyPresentationCredentials,
  decodeJWT,
  verifyES256KSignature,
};
