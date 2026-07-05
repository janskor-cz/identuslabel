/**
 * Unit tests for usePhotoDID hook logic (non-React, Node-compatible)
 *
 * Tests the pure logic functions extracted from the hook:
 * - Cache read/write with TTL
 * - Photo value type detection
 * - DID service endpoint extraction
 *
 * Run with: node --test src/hooks/__tests__/usePhotoDID.logic.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// ── Cache helpers (extracted from usePhotoDID.ts for pure testing) ───────────

const CACHE_PREFIX = 'photo-did-cache-';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Simple in-memory localStorage shim for testing
function createMemoryStorage() {
  const store = new Map();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear()
  };
}

function readCache(photoDID, storage) {
  try {
    const raw = storage.getItem(CACHE_PREFIX + photoDID);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
      storage.removeItem(CACHE_PREFIX + photoDID);
      return null;
    }
    return entry.dataUrl;
  } catch {
    return null;
  }
}

function writeCache(photoDID, dataUrl, storage) {
  try {
    const entry = { dataUrl, cachedAt: Date.now() };
    storage.setItem(CACHE_PREFIX + photoDID, JSON.stringify(entry));
  } catch {
    // ignore quota errors
  }
}

// ── Photo type detection ─────────────────────────────────────────────────────

function classifyPhotoValue(value) {
  if (!value) return 'none';
  if (typeof value !== 'string') return 'none';
  if (value.startsWith('data:image/')) return 'base64';
  if (value.startsWith('did:')) return 'did';
  return 'unknown';
}

// ── DID service endpoint extraction ─────────────────────────────────────────

function extractPhotoServiceEndpoint(services) {
  const photoService = (services ?? []).find(
    (s) => typeof s.id === 'string' && s.id.endsWith('#photo')
  );
  if (!photoService) return null;
  const endpoint = photoService.serviceEndpoint;
  return Array.isArray(endpoint) ? endpoint[0] : endpoint;
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('classifyPhotoValue — null returns none', () => {
  assert.equal(classifyPhotoValue(null), 'none');
});

test('classifyPhotoValue — undefined returns none', () => {
  assert.equal(classifyPhotoValue(undefined), 'none');
});

test('classifyPhotoValue — base64 data URI returns base64', () => {
  assert.equal(classifyPhotoValue('data:image/jpeg;base64,/9j/4AAQ=='), 'base64');
});

test('classifyPhotoValue — PNG data URI returns base64', () => {
  assert.equal(classifyPhotoValue('data:image/png;base64,iVBORw0='), 'base64');
});

test('classifyPhotoValue — DID string returns did', () => {
  assert.equal(classifyPhotoValue('did:prism:abc123:longform'), 'did');
});

test('classifyPhotoValue — random string returns unknown', () => {
  assert.equal(classifyPhotoValue('just a string'), 'unknown');
});

test('readCache — returns null when key absent', () => {
  const storage = createMemoryStorage();
  assert.equal(readCache('did:prism:abc', storage), null);
});

test('readCache — returns cached dataUrl within TTL', () => {
  const storage = createMemoryStorage();
  const did = 'did:prism:abc123';
  writeCache(did, 'data:image/jpeg;base64,FAKE', storage);
  const result = readCache(did, storage);
  assert.equal(result, 'data:image/jpeg;base64,FAKE');
});

test('readCache — returns null when cache entry is expired', () => {
  const storage = createMemoryStorage();
  const did = 'did:prism:expired';
  // Write with a very old cachedAt
  const entry = { dataUrl: 'data:image/jpeg;base64,OLD', cachedAt: Date.now() - CACHE_TTL_MS - 1000 };
  storage.setItem(CACHE_PREFIX + did, JSON.stringify(entry));
  const result = readCache(did, storage);
  assert.equal(result, null);
  // Should also remove the stale entry
  assert.equal(storage.getItem(CACHE_PREFIX + did), null);
});

test('writeCache — stores entry and can be read back', () => {
  const storage = createMemoryStorage();
  const did = 'did:prism:new123';
  writeCache(did, 'data:image/jpeg;base64,NEW', storage);
  const raw = storage.getItem(CACHE_PREFIX + did);
  assert.ok(raw !== null, 'Entry should be stored');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.dataUrl, 'data:image/jpeg;base64,NEW');
  assert.ok(typeof parsed.cachedAt === 'number');
});

test('extractPhotoServiceEndpoint — finds #photo service by id suffix', () => {
  const services = [
    { id: 'did:prism:abc#key-0', type: 'authentication', serviceEndpoint: 'https://example.com/key' },
    { id: 'did:prism:abc#photo', type: 'LinkedPhoto', serviceEndpoint: 'https://identuslabel.cz/ca/photo-proxy/file-123' }
  ];
  const url = extractPhotoServiceEndpoint(services);
  assert.equal(url, 'https://identuslabel.cz/ca/photo-proxy/file-123');
});

test('extractPhotoServiceEndpoint — returns first item when endpoint is array', () => {
  const services = [
    { id: '#photo', type: 'LinkedPhoto', serviceEndpoint: ['https://primary.example.com', 'https://backup.example.com'] }
  ];
  const url = extractPhotoServiceEndpoint(services);
  assert.equal(url, 'https://primary.example.com');
});

test('extractPhotoServiceEndpoint — returns null when no #photo service', () => {
  const services = [
    { id: '#key-0', type: 'authentication', serviceEndpoint: 'https://example.com/key' }
  ];
  const url = extractPhotoServiceEndpoint(services);
  assert.equal(url, null);
});

test('extractPhotoServiceEndpoint — returns null for empty services array', () => {
  assert.equal(extractPhotoServiceEndpoint([]), null);
});

test('extractPhotoServiceEndpoint — returns null for null/undefined services', () => {
  assert.equal(extractPhotoServiceEndpoint(null), null);
  assert.equal(extractPhotoServiceEndpoint(undefined), null);
});

test('cache — write then overwrite with new value', () => {
  const storage = createMemoryStorage();
  const did = 'did:prism:overwrite';
  writeCache(did, 'data:image/jpeg;base64,OLD', storage);
  writeCache(did, 'data:image/jpeg;base64,NEW', storage);
  assert.equal(readCache(did, storage), 'data:image/jpeg;base64,NEW');
});
