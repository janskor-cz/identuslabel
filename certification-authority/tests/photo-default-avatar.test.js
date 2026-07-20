/**
 * Unit tests for the "always create a photo DID at RealPersonIdentity issuance, falling back to
 * a placeholder image when no photo was uploaded" fix.
 *
 * Follows the same convention as tests/photo-did-create.test.js: inline reimplementations of the
 * server.js logic under test (server.js has no module.exports / require.main guard — it calls
 * app.listen() unconditionally — so importing it directly would start a real server). Network
 * calls (createPhotoDID's Iagon upload / Cloud Agent DID creation) are injected as fakes.
 *
 * Run with: node --test tests/photo-default-avatar.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── Issuance-handler photo-DID logic — inline reimplementation matching the fixed block in
// server.js's POST /api/credentials/issue-realperson handler exactly (the `if (photo) {...}`
// guard removed; `photo || DEFAULT_AVATAR_DATA_URI` picked inside the always-run try block) ────

async function resolvePhotoDIDRef({ uniqueId, photo, defaultAvatarDataUri }, deps) {
  const { photoDIDs, createPhotoDIDFn } = deps;
  let photoDIDRef = null;
  try {
    if (photoDIDs[uniqueId]) {
      photoDIDRef = photoDIDs[uniqueId].photoDID;
    } else {
      const created = await createPhotoDIDFn(uniqueId, photo || defaultAvatarDataUri);
      photoDIDRef = created.photoDID;
    }
  } catch (photoErr) {
    photoDIDRef = null;
  }
  return photoDIDRef;
}

// ── Schema-version selection — inline reimplementation matching the (unchanged) line in
// server.js: `const preferredVersion = photo ? '4.0.0' : '3.0.0';` ──────────────────────────────

function selectPreferredSchemaVersion(photo) {
  return photo ? '4.0.0' : '3.0.0';
}

const REAL_DEFAULT_AVATAR_PATH = path.join(__dirname, '..', 'assets', 'default-avatar.png');

// ── Tests: the real on-disk asset is a byte-correct PNG ─────────────────────────────────────

test('assets/default-avatar.png exists and is a byte-correct, decodable PNG', () => {
  const buf = fs.readFileSync(REAL_DEFAULT_AVATAR_PATH);

  // PNG signature
  const sig = buf.subarray(0, 8);
  assert.deepEqual([...sig], [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  // Walk chunks, confirm well-formed structure ending in IEND with no leftover bytes
  let offset = 8;
  let ihdr = null;
  const idatChunks = [];
  let sawIEND = false;
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === 'IHDR') ihdr = data;
    if (type === 'IDAT') idatChunks.push(data);
    if (type === 'IEND') sawIEND = true;
    offset += 8 + len + 4; // length + type + data + crc
  }
  assert.ok(sawIEND, 'PNG must end with an IEND chunk');
  assert.equal(offset, buf.length, 'chunk structure must consume the entire file with no trailing/corrupt bytes');
  assert.ok(ihdr, 'PNG must have an IHDR chunk');

  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  assert.equal(bitDepth, 8);
  assert.equal(colorType, 2, 'expected truecolor (RGB) PNG');

  // IDAT must inflate cleanly (this is exactly the check that caught the corrupted asset
  // originally supplied for this fix — inflateSync throws Z_DATA_ERROR on bad/truncated data)
  const idat = Buffer.concat(idatChunks);
  const inflated = zlib.inflateSync(idat);
  const expectedLen = height * (1 + width * 3); // filter byte + RGB per row
  assert.equal(inflated.length, expectedLen, 'inflated data must match expected scanline size exactly');

  // Portrait aspect ratio matching the wallet's ID-card layout (200x250 -> 0.8)
  assert.equal(width, 200);
  assert.equal(height, 250);
});

// ── Tests: DEFAULT_AVATAR_DATA_URI construction (mirrors server.js's module-level load) ─────

test('default avatar loads as a data:image/png;base64,... URI matching createPhotoDID\'s strip regex', () => {
  const base64 = fs.readFileSync(REAL_DEFAULT_AVATAR_PATH).toString('base64');
  const dataUri = `data:image/png;base64,${base64}`;

  // createPhotoDID strips with /^data:image\/\w+;base64,/ — confirm image/png matches
  const stripped = dataUri.replace(/^data:image\/\w+;base64,/, '');
  assert.equal(stripped, base64);
  assert.notEqual(stripped, dataUri, 'the prefix must actually be stripped, not a no-op match');

  // And the stripped payload must decode back to a valid PNG (round-trip sanity)
  const decoded = Buffer.from(stripped, 'base64');
  assert.deepEqual([...decoded.subarray(0, 8)], [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
});

// ── Tests: fakes for createPhotoDID (mirrors tests/photo-did-create.test.js's makeFakes) ────

function makeCreatePhotoDIDFake() {
  const calls = [];
  const createPhotoDIDFn = async (uniqueId, photoDataUri) => {
    calls.push({ uniqueId, photoDataUri });
    return {
      photoDID: `did:prism:fake-${calls.length}:longform`,
      iagonFileId: `iagon-file-${calls.length}`,
      proxyUrl: `https://ca.example/photo-proxy/iagon-file-${calls.length}`
    };
  };
  return { calls, createPhotoDIDFn };
}

const REAL_PHOTO_DATA_URI = 'data:image/jpeg;base64,ZmFrZS1yZWFsLXBob3Rv'; // "fake-real-photo"
const DEFAULT_AVATAR_DATA_URI = 'data:image/png;base64,ZmFrZS1wbGFjZWhvbGRlcg=='; // "fake-placeholder"

// ── Tests: issuance with no photo → placeholder used, photoDIDRef still truthy ──────────────

test('issuance with no photo uses the placeholder and still produces a truthy photoDIDRef', async () => {
  const { calls, createPhotoDIDFn } = makeCreatePhotoDIDFake();
  const photoDIDs = {};

  const photoDIDRef = await resolvePhotoDIDRef(
    { uniqueId: 'user-no-photo', photo: undefined, defaultAvatarDataUri: DEFAULT_AVATAR_DATA_URI },
    { photoDIDs, createPhotoDIDFn }
  );

  assert.ok(photoDIDRef, 'photoDIDRef must be truthy even with no photo uploaded');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].photoDataUri, DEFAULT_AVATAR_DATA_URI, 'must fall back to the placeholder data URI');
  assert.equal(calls[0].uniqueId, 'user-no-photo');
});

test('issuance with no photo (empty string / null) also falls back to the placeholder', async () => {
  const { calls, createPhotoDIDFn } = makeCreatePhotoDIDFake();

  for (const emptyPhoto of ['', null, undefined]) {
    calls.length = 0;
    const photoDIDs = {};
    const photoDIDRef = await resolvePhotoDIDRef(
      { uniqueId: 'user-empty', photo: emptyPhoto, defaultAvatarDataUri: DEFAULT_AVATAR_DATA_URI },
      { photoDIDs, createPhotoDIDFn }
    );
    assert.ok(photoDIDRef);
    assert.equal(calls[0].photoDataUri, DEFAULT_AVATAR_DATA_URI, `falsy photo value ${JSON.stringify(emptyPhoto)} must use placeholder`);
  }
});

// ── Tests: issuance with a real photo → real photo used, not the placeholder ─────────────────

test('issuance with a real photo uses the real photo, not the placeholder', async () => {
  const { calls, createPhotoDIDFn } = makeCreatePhotoDIDFake();
  const photoDIDs = {};

  const photoDIDRef = await resolvePhotoDIDRef(
    { uniqueId: 'user-real-photo', photo: REAL_PHOTO_DATA_URI, defaultAvatarDataUri: DEFAULT_AVATAR_DATA_URI },
    { photoDIDs, createPhotoDIDFn }
  );

  assert.ok(photoDIDRef);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].photoDataUri, REAL_PHOTO_DATA_URI, 'must use the real photo, not the placeholder');
  assert.notEqual(calls[0].photoDataUri, DEFAULT_AVATAR_DATA_URI);
});

// ── Tests: photoDIDs[uniqueId] reuse branch is unaffected by the placeholder fallback ────────

test('reuse branch: an existing photoDID mapping is reused as-is, regardless of photo presence', async () => {
  const { calls, createPhotoDIDFn } = makeCreatePhotoDIDFake();
  const photoDIDs = {
    'user-existing': { photoDID: 'did:prism:pre-existing:longform', iagonFileId: 'old-file', proxyUrl: 'https://ca.example/photo-proxy/old-file', createdAt: '2026-01-01T00:00:00.000Z' }
  };

  // No photo provided — reuse path must win over the new placeholder-creation path
  const noPhotoRef = await resolvePhotoDIDRef(
    { uniqueId: 'user-existing', photo: undefined, defaultAvatarDataUri: DEFAULT_AVATAR_DATA_URI },
    { photoDIDs, createPhotoDIDFn }
  );
  assert.equal(noPhotoRef, 'did:prism:pre-existing:longform');
  assert.equal(calls.length, 0, 'createPhotoDID must not be called when a mapping already exists');

  // Real photo provided — reuse path still wins (matches pre-fix behavior: reuse takes priority)
  const withPhotoRef = await resolvePhotoDIDRef(
    { uniqueId: 'user-existing', photo: REAL_PHOTO_DATA_URI, defaultAvatarDataUri: DEFAULT_AVATAR_DATA_URI },
    { photoDIDs, createPhotoDIDFn }
  );
  assert.equal(withPhotoRef, 'did:prism:pre-existing:longform');
  assert.equal(calls.length, 0, 'createPhotoDID must still not be called when a mapping already exists');
});

// ── Tests: createPhotoDID failure still degrades to null (unchanged failure behavior) ───────

test('createPhotoDID failure results in null photoDIDRef (VC issued without photo claim)', async () => {
  const photoDIDs = {};
  const failingCreatePhotoDIDFn = async () => { throw new Error('DID create failed: agent unreachable'); };

  const photoDIDRef = await resolvePhotoDIDRef(
    { uniqueId: 'user-fail', photo: undefined, defaultAvatarDataUri: DEFAULT_AVATAR_DATA_URI },
    { photoDIDs, createPhotoDIDFn: failingCreatePhotoDIDFn }
  );

  assert.equal(photoDIDRef, null);
});

// ── Tests: schema-version selection stays keyed on whether a real photo was given ────────────

test('schema version stays 3.0.0 when no real photo was given, even though a photo DID now always exists', () => {
  assert.equal(selectPreferredSchemaVersion(undefined), '3.0.0');
  assert.equal(selectPreferredSchemaVersion(null), '3.0.0');
  assert.equal(selectPreferredSchemaVersion(''), '3.0.0');
});

test('schema version is 4.0.0 when a real photo was given', () => {
  assert.equal(selectPreferredSchemaVersion(REAL_PHOTO_DATA_URI), '4.0.0');
});

test('schema version selection is independent of the resolved photoDIDRef (placeholder DID does not leak into schema choice)', async () => {
  const { createPhotoDIDFn } = makeCreatePhotoDIDFake();
  const photoDIDs = {};

  // No real photo → placeholder photoDID is created → photoDIDRef is truthy ...
  const photoDIDRef = await resolvePhotoDIDRef(
    { uniqueId: 'user-schema-check', photo: undefined, defaultAvatarDataUri: DEFAULT_AVATAR_DATA_URI },
    { photoDIDs, createPhotoDIDFn }
  );
  assert.ok(photoDIDRef, 'sanity: a placeholder photo DID was in fact created');

  // ... but schema selection must be driven by the original `photo` param, not by photoDIDRef
  const version = selectPreferredSchemaVersion(undefined);
  assert.equal(version, '3.0.0', 'schema version must reflect issuer intent (no real photo given), not DID existence');
});
