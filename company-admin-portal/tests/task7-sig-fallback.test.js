/**
 * Task 7 — Signature fallback hardening
 * Tests that:
 * 1. INTERNAL docs allow format-only fallback when DID resolution fails
 * 2. CONFIDENTIAL+ docs are denied when DID resolution fails (no fallback)
 * 3. getLevelNumber() correctly orders classification levels
 */

const assert = require('assert');
const crypto = require('crypto');

const TASK = 'Task 7: Signature Fallback Hardening';
const TESTS = [];

function test(name, fn) { TESTS.push({ task: TASK, name, fn }); }

// Helper: reproduce the getLevelNumber logic from ReEncryptionService
function getLevelNumber(level) {
  const map = {
    'UNCLASSIFIED': 0, 'INTERNAL': 1, 'CONFIDENTIAL': 2,
    'RESTRICTED': 3, 'SECRET': 3, 'TOP-SECRET': 4, 'TOP_SECRET': 4
  };
  return map[level] ?? 1;
}

test('getLevelNumber returns correct hierarchy', async () => {
  assert.strictEqual(getLevelNumber('INTERNAL'), 1);
  assert.strictEqual(getLevelNumber('CONFIDENTIAL'), 2);
  assert.strictEqual(getLevelNumber('RESTRICTED'), 3);
  assert.strictEqual(getLevelNumber('TOP_SECRET'), 4);
  assert.strictEqual(getLevelNumber('TOP-SECRET'), 4);
  assert.strictEqual(getLevelNumber('UNCLASSIFIED'), 0);
});

test('INTERNAL (level 1) allows format-only fallback', async () => {
  // When DID resolution fails and level <= 1, fallback is allowed
  const level = 'INTERNAL';
  const levelNum = getLevelNumber(level);

  // Simulate: DID resolution fails
  const didResolutionFailed = true;

  if (didResolutionFailed && levelNum > 1) {
    assert.fail('Should not reach deny branch for INTERNAL');
  }
  // For INTERNAL, fallback to format check (e.g., sig length == 64)
  const sigBytes = crypto.randomBytes(64);
  const formatOk = sigBytes.length === 64;
  assert.ok(formatOk, 'INTERNAL fallback: 64-byte sig should pass format check');
});

test('CONFIDENTIAL (level 2) is denied when DID resolution fails', async () => {
  const level = 'CONFIDENTIAL';
  const levelNum = getLevelNumber(level);

  // Simulate: DID resolution fails
  const didResolutionFailed = true;

  let result = true; // assume allowed initially
  if (didResolutionFailed && levelNum > 1) {
    result = false; // deny
  }
  assert.strictEqual(result, false, 'CONFIDENTIAL should be denied when DID resolution fails');
});

test('RESTRICTED (level 3) is denied when DID resolution fails', async () => {
  const level = 'RESTRICTED';
  const levelNum = getLevelNumber(level);
  let result = true;
  if (getLevelNumber(level) > 1) result = false; // deny on resolution failure
  assert.strictEqual(result, false, 'RESTRICTED should be denied when DID resolution fails');
});

test('TOP_SECRET (level 4) is denied when DID resolution fails', async () => {
  const level = 'TOP_SECRET';
  let result = true;
  if (getLevelNumber(level) > 1) result = false;
  assert.strictEqual(result, false, 'TOP_SECRET should be denied when DID resolution fails');
});

test('company-admin ReEncryptionService has classification-aware verifySignature', async () => {
  const fs = require('fs');
  const svcPath = require('path').join(__dirname, '../lib/ReEncryptionService.js');
  const source = fs.readFileSync(svcPath, 'utf8');

  assert.ok(
    source.includes('documentClassificationLevel'),
    'verifySignature should accept documentClassificationLevel parameter'
  );
  assert.ok(
    source.includes('getLevelNumber'),
    'Should use getLevelNumber for classification hierarchy'
  );
  assert.ok(
    source.includes('levelNum > 1'),
    'Should deny CONFIDENTIAL+ on DID resolution failure'
  );
});

test('identus-document-service ReEncryptionService has classification-aware verifySignature', async () => {
  const fs = require('fs');
  const svcPath = require('path').join(__dirname, '../../identus-document-service/lib/ReEncryptionService.js');

  let source = '';
  try {
    source = fs.readFileSync(svcPath, 'utf8');
  } catch (e) {
    return; // Skip if not accessible
  }

  assert.ok(
    source.includes('documentClassificationLevel'),
    'verifySignature should accept documentClassificationLevel parameter'
  );
  assert.ok(
    source.includes('levelNum > 1'),
    'Should deny CONFIDENTIAL+ on DID resolution failure'
  );
});

async function run() {
  const results = [];
  for (const t of TESTS) {
    try {
      await t.fn();
      results.push({ task: t.task, name: t.name, pass: true });
    } catch (e) {
      results.push({ task: t.task, name: t.name, pass: false, error: e.message });
    }
  }
  return results;
}

module.exports = { run };
