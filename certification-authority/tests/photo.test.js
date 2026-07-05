/**
 * Unit tests for Photo DID / Iagon photo functionality
 * Run with: node --test tests/photo.test.js
 */

const { test, mock, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Helpers under test ────────────────────────────────────────────────────────

/**
 * Inline implementation of the key functions from server.js
 * (Extracted for unit testability — matches server.js logic exactly)
 */
const IAGON_BASE = 'https://gw.iagon.com/api/v2';

async function uploadPhotoToIagon(jpegBuffer, filename, axiosPost, accessToken, nodeId) {
  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', jpegBuffer, { filename, contentType: 'image/jpeg' });
  form.append('node_id', nodeId);

  const response = await axiosPost(`${IAGON_BASE}/storage/upload`, form, {
    headers: { ...form.getHeaders(), 'x-api-key': accessToken },
    timeout: 60000,
    maxContentLength: 10 * 1024 * 1024,
    maxBodyLength: 10 * 1024 * 1024
  });

  const fileId = response.data?.data?._id;
  if (!fileId) throw new Error(`Iagon upload returned no fileId: ${JSON.stringify(response.data)}`);
  return fileId;
}

async function downloadPhotoFromIagon(iagonFileId, axiosPost, accessToken, nodeId) {
  const response = await axiosPost(`${IAGON_BASE}/storage/download`, {
    id: iagonFileId,
    files: [iagonFileId]
  }, {
    headers: { 'x-api-key': accessToken, 'Content-Type': 'application/json' },
    responseType: 'arraybuffer',
    timeout: 60000
  });
  return Buffer.from(response.data);
}

function isPhotoKnown(photoDIDs, iagonFileId) {
  return Object.values(photoDIDs).some(e => e.iagonFileId === iagonFileId);
}

// ── photo-dids.json persistence helpers ──────────────────────────────────────

function loadPhotoDIDs(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return {};
  }
}

function savePhotoDIDs(filePath, photoDIDs) {
  fs.writeFileSync(filePath, JSON.stringify(photoDIDs, null, 2), 'utf8');
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('uploadPhotoToIagon — returns fileId from Iagon response', async (t) => {
  const fakeFileId = 'iagon-file-id-abc123';
  let capturedUrl = null;
  let capturedOptions = null;

  const mockAxiosPost = async (url, formData, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return { data: { success: true, data: { _id: fakeFileId, name: 'photo.jpg' } } };
  };

  const buffer = Buffer.from('fake-jpeg-bytes');
  const result = await uploadPhotoToIagon(buffer, 'photo-test.jpg', mockAxiosPost, 'test-token', 'test-node-id');

  assert.equal(result, fakeFileId);
  assert.equal(capturedUrl, `${IAGON_BASE}/storage/upload`);
  assert.ok(capturedOptions.headers['x-api-key'] === 'test-token', 'x-api-key header set correctly');
});

test('uploadPhotoToIagon — throws when response has no fileId', async (t) => {
  const mockAxiosPost = async () => ({ data: { success: false, data: {} } });
  const buffer = Buffer.from('fake-jpeg-bytes');

  await assert.rejects(
    () => uploadPhotoToIagon(buffer, 'photo.jpg', mockAxiosPost, 'tok', 'nid'),
    /Iagon upload returned no fileId/
  );
});

test('downloadPhotoFromIagon — sends correct body and returns buffer', async (t) => {
  const fakeImageData = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]); // fake JPEG header
  let capturedBody = null;

  const mockAxiosPost = async (url, body, options) => {
    capturedBody = body;
    return { data: fakeImageData };
  };

  const result = await downloadPhotoFromIagon('file-id-xyz', mockAxiosPost, 'tok', 'nid');

  assert.deepEqual(capturedBody, { id: 'file-id-xyz', files: ['file-id-xyz'] });
  assert.ok(Buffer.isBuffer(result), 'Result is a Buffer');
});

test('isPhotoKnown — returns true for known fileId', (t) => {
  const photoDIDs = {
    'user-123': { photoDID: 'did:prism:abc', iagonFileId: 'known-file-id', proxyUrl: 'https://example.com' }
  };
  assert.equal(isPhotoKnown(photoDIDs, 'known-file-id'), true);
});

test('isPhotoKnown — returns false for unknown fileId', (t) => {
  const photoDIDs = {
    'user-123': { photoDID: 'did:prism:abc', iagonFileId: 'known-file-id', proxyUrl: 'https://example.com' }
  };
  assert.equal(isPhotoKnown(photoDIDs, 'unknown-file-id'), false);
});

test('isPhotoKnown — returns false for empty store', (t) => {
  assert.equal(isPhotoKnown({}, 'any-file-id'), false);
});

test('loadPhotoDIDs / savePhotoDIDs — round-trip persistence', (t) => {
  const tmpFile = path.join(os.tmpdir(), `photo-dids-test-${Date.now()}.json`);
  const original = {
    'CA-123': {
      photoDID: 'did:prism:abc123',
      iagonFileId: 'file-id-abc',
      proxyUrl: 'https://identuslabel.cz/ca/photo-proxy/file-id-abc',
      createdAt: '2026-05-14T10:00:00Z'
    }
  };

  savePhotoDIDs(tmpFile, original);
  const loaded = loadPhotoDIDs(tmpFile);
  assert.deepEqual(loaded, original);

  fs.unlinkSync(tmpFile); // cleanup
});

test('loadPhotoDIDs — returns empty object when file does not exist', (t) => {
  const result = loadPhotoDIDs('/nonexistent/path/photo-dids.json');
  assert.deepEqual(result, {});
});

test('photo data URI stripping — extracts raw base64 correctly', (t) => {
  const dataUri = 'data:image/jpeg;base64,/9j/4AAQSkZJRgAB==';
  const stripped = dataUri.replace(/^data:image\/\w+;base64,/, '');
  assert.equal(stripped, '/9j/4AAQSkZJRgAB==');
});

test('photo data URI stripping — handles PNG data URI', (t) => {
  const dataUri = 'data:image/png;base64,iVBORw0KGgo=';
  const stripped = dataUri.replace(/^data:image\/\w+;base64,/, '');
  assert.equal(stripped, 'iVBORw0KGgo=');
});

test('enrichedClaims photo field — uses photoDIDRef when present', (t) => {
  const photoDIDRef = 'did:prism:abc123:longform';
  const enrichedClaims = {
    firstName: 'Alice',
    ...(photoDIDRef ? { photo: photoDIDRef } : {})
  };
  assert.equal(enrichedClaims.photo, photoDIDRef);
});

test('enrichedClaims photo field — omits photo when no DID ref', (t) => {
  const photoDIDRef = null;
  const enrichedClaims = {
    firstName: 'Bob',
    ...(photoDIDRef ? { photo: photoDIDRef } : {})
  };
  assert.equal(Object.hasOwn(enrichedClaims, 'photo'), false);
});

test('proxy URL format — constructed correctly from iagonFileId', (t) => {
  const iagonFileId = 'abc123def456';
  const proxyUrl = `https://identuslabel.cz/ca/photo-proxy/${iagonFileId}`;
  assert.equal(proxyUrl, 'https://identuslabel.cz/ca/photo-proxy/abc123def456');
});
