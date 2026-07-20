/**
 * Unit tests for message encryption/decryption (messageEncryption.ts logic)
 *
 * Tests the NaCl XSalsa20-Poly1305 encrypt→decrypt roundtrip using the same
 * algorithm as the wallet, without needing a browser or TypeScript compiler.
 *
 * Requires: tweetnacl, jose (already in node_modules)
 */

'use strict';

const nacl  = require('../node_modules/tweetnacl/nacl-fast.js');

// Minimal base64url encode/decode that works in Node without the 'jose' ESM package
function b64uEncode(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function b64uDecode(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

// ── mirror of encryptMessage / decryptMessage from messageEncryption.ts ──────

function encryptMessage(plaintext, senderPriv, senderPub, recipientPub) {
  if (!plaintext) throw new Error('Plaintext cannot be empty');
  if (senderPriv.length !== 32 || senderPub.length !== 32 || recipientPub.length !== 32) {
    throw new Error('Invalid key lengths (expected 32 bytes each)');
  }
  const nonce      = nacl.randomBytes(24);
  const msgBytes   = Buffer.from(plaintext, 'utf8');
  const ciphertext = nacl.box(msgBytes, nonce, recipientPub, senderPriv);
  if (!ciphertext) throw new Error('nacl.box returned null — encryption failed');
  return {
    encrypted: true,
    algorithm: 'XSalsa20-Poly1305',
    version:   '2.0',
    ciphertext:       b64uEncode(ciphertext),
    nonce:            b64uEncode(nonce),
    recipientPublicKey: b64uEncode(recipientPub),
    senderPublicKey:    b64uEncode(senderPub),
  };
}

function decryptMessage(encryptedBody, recipientPriv, recipientPub) {
  if (!encryptedBody?.encrypted) throw new Error('Invalid encrypted message body');
  if (encryptedBody.algorithm !== 'XSalsa20-Poly1305') throw new Error('Unsupported algorithm');
  if (recipientPriv.length !== 32 || recipientPub.length !== 32) {
    throw new Error('Invalid key lengths (expected 32 bytes each)');
  }
  const senderPub  = b64uDecode(encryptedBody.senderPublicKey);
  const ciphertext = b64uDecode(encryptedBody.ciphertext);
  const nonce      = b64uDecode(encryptedBody.nonce);
  if (nonce.length !== 24) throw new Error(`Invalid nonce length: ${nonce.length}`);
  const plaintext = nacl.box.open(ciphertext, nonce, senderPub, recipientPriv);
  if (!plaintext) throw new Error('nacl.box.open returned null — wrong key or corrupted message');
  return Buffer.from(plaintext).toString('utf8');
}

// ── test runner ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
    failed++;
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(a)} === ${JSON.stringify(b)}`);
}

// ── fixtures ──────────────────────────────────────────────────────────────────

// Generate fresh X25519 keypairs for Alice and Bob
const aliceKP = nacl.box.keyPair();
const bobKP   = nacl.box.keyPair();

// ── tests ─────────────────────────────────────────────────────────────────────

console.log('\n🔐 messageEncryption — unit tests\n');

test('encryptMessage: produces valid encrypted body structure', () => {
  const body = encryptMessage('Hello Bob', aliceKP.secretKey, aliceKP.publicKey, bobKP.publicKey);
  assert(body.encrypted === true,              'encrypted flag');
  assertEqual(body.algorithm, 'XSalsa20-Poly1305', 'algorithm');
  assertEqual(body.version,   '2.0',               'version');
  assert(body.ciphertext.length > 0,           'ciphertext present');
  assert(body.nonce.length > 0,                'nonce present');
  assert(body.senderPublicKey.length > 0,      'senderPublicKey present');
  assert(body.recipientPublicKey.length > 0,   'recipientPublicKey present');
});

test('encryptMessage → decryptMessage: plaintext roundtrip', () => {
  const original = 'The package arrives at midnight.';
  const enc = encryptMessage(original, aliceKP.secretKey, aliceKP.publicKey, bobKP.publicKey);
  const dec = decryptMessage(enc, bobKP.secretKey, bobKP.publicKey);
  assertEqual(dec, original, 'Decrypted text must match original');
});

test('roundtrip: works with unicode / emoji content', () => {
  const original = '🔒 Secret: ěščřžýáíé — classified TOP';
  const enc = encryptMessage(original, aliceKP.secretKey, aliceKP.publicKey, bobKP.publicKey);
  const dec = decryptMessage(enc, bobKP.secretKey, bobKP.publicKey);
  assertEqual(dec, original, 'Unicode roundtrip must be lossless');
});

test('roundtrip: works with long messages (> 1 KB)', () => {
  const original = 'A'.repeat(2000);
  const enc = encryptMessage(original, aliceKP.secretKey, aliceKP.publicKey, bobKP.publicKey);
  const dec = decryptMessage(enc, bobKP.secretKey, bobKP.publicKey);
  assertEqual(dec, original);
});

test('each encryption produces a different ciphertext (fresh nonce)', () => {
  const msg  = 'Same plaintext';
  const enc1 = encryptMessage(msg, aliceKP.secretKey, aliceKP.publicKey, bobKP.publicKey);
  const enc2 = encryptMessage(msg, aliceKP.secretKey, aliceKP.publicKey, bobKP.publicKey);
  assert(enc1.nonce      !== enc2.nonce,      'Nonces should differ');
  assert(enc1.ciphertext !== enc2.ciphertext, 'Ciphertexts should differ (nonce is random)');
});

test('decryptMessage: fails with wrong recipient private key', () => {
  const enc  = encryptMessage('Secret', aliceKP.secretKey, aliceKP.publicKey, bobKP.publicKey);
  const eveKP = nacl.box.keyPair();
  let threw = false;
  try {
    decryptMessage(enc, eveKP.secretKey, eveKP.publicKey);
  } catch (_) {
    threw = true;
  }
  assert(threw, 'Should throw when decrypting with wrong key');
});

test('decryptMessage: fails on tampered ciphertext', () => {
  const enc = encryptMessage('Secret', aliceKP.secretKey, aliceKP.publicKey, bobKP.publicKey);
  const tampered = { ...enc, ciphertext: enc.ciphertext.slice(0, -4) + 'XXXX' };
  let threw = false;
  try {
    decryptMessage(tampered, bobKP.secretKey, bobKP.publicKey);
  } catch (_) {
    threw = true;
  }
  assert(threw, 'Should throw on tampered ciphertext');
});

test('encryptMessage: throws on empty plaintext', () => {
  let threw = false;
  try { encryptMessage('', aliceKP.secretKey, aliceKP.publicKey, bobKP.publicKey); }
  catch (_) { threw = true; }
  assert(threw, 'Empty plaintext should throw');
});

test('encryptMessage: throws on wrong-length key', () => {
  const short = new Uint8Array(16);
  let threw = false;
  try { encryptMessage('Hi', short, aliceKP.publicKey, bobKP.publicKey); }
  catch (_) { threw = true; }
  assert(threw, '16-byte key should throw');
});

test('decryptMessage: throws on invalid body (missing encrypted flag)', () => {
  let threw = false;
  try { decryptMessage({ algorithm: 'XSalsa20-Poly1305' }, bobKP.secretKey, bobKP.publicKey); }
  catch (_) { threw = true; }
  assert(threw);
});

test('decryptMessage: throws on unsupported algorithm', () => {
  const enc = encryptMessage('Hi', aliceKP.secretKey, aliceKP.publicKey, bobKP.publicKey);
  let threw = false;
  try { decryptMessage({ ...enc, algorithm: 'AES-GCM' }, bobKP.secretKey, bobKP.publicKey); }
  catch (_) { threw = true; }
  assert(threw);
});

test('b64uEncode/b64uDecode roundtrip is lossless', () => {
  const original = nacl.randomBytes(64);
  const decoded  = b64uDecode(b64uEncode(original));
  assert(original.every((b, i) => b === decoded[i]), 'base64url roundtrip must be lossless');
});

// ── summary ───────────────────────────────────────────────────────────────────

console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
