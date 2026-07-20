/**
 * Unit tests for the createPhotoDID() extraction and the "no existing photo DID → create one"
 * fix in POST /api/credentials/update-realperson and POST /api/photos/update/:uniqueId.
 *
 * Follows the same convention as tests/photo.test.js: inline reimplementations of the
 * server.js logic under test (server.js has no module.exports / require.main guard — it
 * calls app.listen() unconditionally — so importing it directly would start a real server).
 * Network calls (Iagon upload, Cloud Agent DID creation/publish) are injected as fakes.
 *
 * Run with: node --test tests/photo-did-create.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// ── createPhotoDID — inline reimplementation matching server.js exactly ──────────────────
// (deps injected instead of closing over module-level globals, for testability)

async function createPhotoDID(uniqueId, photoDataUri, deps) {
  const { uploadPhotoToIagon, fetchImpl, apiKey, cloudAgentUrl, publicBaseUrl, photoDIDs, savePhotoDIDs } = deps;

  // 1. Upload photo to Iagon
  const base64 = photoDataUri.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(base64, 'base64');
  const iagonFileId = await uploadPhotoToIagon(buffer, `photo-${uniqueId}-${Date.now()}.jpg`);
  const proxyUrl = `${publicBaseUrl}/photo-proxy/${iagonFileId}`;

  // 2. Create PRISM DID with #photo service endpoint
  const didCreateResp = await fetchImpl(`${cloudAgentUrl}/did-registrar/dids`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': apiKey },
    body: JSON.stringify({
      documentTemplate: {
        publicKeys: [{ id: 'auth-0', purpose: 'authentication' }],
        services: [{ id: 'photo', type: 'LinkedPhoto', serviceEndpoint: proxyUrl }]
      }
    })
  });
  if (!didCreateResp.ok) throw new Error(`DID create failed: ${await didCreateResp.text()}`);
  const didData = await didCreateResp.json();
  const longFormDid = didData.longFormDid;

  // 3. Publish (fire-and-forget)
  fetchImpl(`${cloudAgentUrl}/did-registrar/dids/${encodeURIComponent(longFormDid)}/publications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': apiKey }
  }).catch(() => {});

  // 4. Store mapping
  photoDIDs[uniqueId] = { photoDID: longFormDid, iagonFileId, proxyUrl, createdAt: new Date().toISOString() };
  savePhotoDIDs();

  return { photoDID: longFormDid, iagonFileId, proxyUrl };
}

// ── Endpoint branch-selection logic — mirrors POST /api/credentials/update-realperson ────

async function updateRealPersonHandler({ uniqueId, newPhoto }, deps) {
  const { userConnectionMappings, photoDIDs, createPhotoDIDFn, updateExistingPhotoDIDFn } = deps;
  if (!uniqueId) return { status: 400, body: { success: false, error: 'uniqueId is required' } };
  if (!newPhoto) return { status: 400, body: { success: false, error: 'newPhoto is required' } };

  const mapping = userConnectionMappings.get(uniqueId);
  if (!mapping) return { status: 404, body: { success: false, error: `No user mapping found for uniqueId: ${uniqueId}` } };

  const existingPhotoDID = photoDIDs[uniqueId];
  if (!existingPhotoDID) {
    await createPhotoDIDFn(uniqueId, newPhoto);
    return { status: 200, body: { success: true, action: 'photo-created', message: 'Photo added — no existing photo DID, created a new one' } };
  }

  await updateExistingPhotoDIDFn(uniqueId, newPhoto, existingPhotoDID);
  return { status: 200, body: { success: true, action: 'photo-updated', message: 'Photo updated in place — no re-issuance needed' } };
}

// ── Endpoint branch-selection logic — mirrors POST /api/photos/update/:uniqueId ──────────

async function photosUpdateHandler({ uniqueId, photo }, deps) {
  const { userConnectionMappings, photoDIDs, createPhotoDIDFn, updateExistingPhotoDIDFn } = deps;
  if (!photo) return { status: 400, body: { error: 'photo is required' } };

  const existing = photoDIDs[uniqueId];
  if (!existing) {
    const mapping = userConnectionMappings.get(uniqueId);
    if (!mapping) return { status: 404, body: { error: `No user mapping found for uniqueId: ${uniqueId}` } };

    const created = await createPhotoDIDFn(uniqueId, photo);
    return { status: 200, body: { success: true, action: 'photo-created', proxyUrl: created.proxyUrl, photoDID: created.photoDID } };
  }

  const updated = await updateExistingPhotoDIDFn(uniqueId, photo, existing);
  return { status: 200, body: { success: true, proxyUrl: updated.proxyUrl, photoDID: existing.photoDID } };
}

// ── Test fixtures / fakes ─────────────────────────────────────────────────────────────────

function makeFakes() {
  const calls = { uploadPhotoToIagon: 0, didCreate: 0, didPublish: 0, didUpdateService: 0, savePhotoDIDs: 0 };

  const uploadPhotoToIagon = async (buffer, filename) => {
    calls.uploadPhotoToIagon++;
    return `iagon-file-${calls.uploadPhotoToIagon}`;
  };

  const fetchImpl = async (url, options) => {
    if (url.includes('/did-registrar/dids') && options.method === 'POST' && !url.includes('/updates') && !url.includes('/publications')) {
      calls.didCreate++;
      return { ok: true, json: async () => ({ longFormDid: `did:prism:fake${calls.didCreate}:longform` }) };
    }
    if (url.includes('/publications')) {
      calls.didPublish++;
      return { ok: true, status: 202, text: async () => '' };
    }
    if (url.includes('/updates')) {
      calls.didUpdateService++;
      return { ok: true, status: 200, text: async () => '' };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const photoDIDs = {};
  const savePhotoDIDs = () => { calls.savePhotoDIDs++; };

  return { calls, uploadPhotoToIagon, fetchImpl, photoDIDs, savePhotoDIDs };
}

// ── Tests: createPhotoDID ──────────────────────────────────────────────────────────────────

test('createPhotoDID — creates a new mapping when none exists', async (t) => {
  const { calls, uploadPhotoToIagon, fetchImpl, photoDIDs, savePhotoDIDs } = makeFakes();

  const result = await createPhotoDID('user-new-1', 'data:image/jpeg;base64,ZmFrZQ==', {
    uploadPhotoToIagon, fetchImpl, apiKey: 'k', cloudAgentUrl: 'https://agent.example', publicBaseUrl: 'https://ca.example', photoDIDs, savePhotoDIDs
  });

  assert.equal(calls.uploadPhotoToIagon, 1);
  assert.equal(calls.didCreate, 1);
  assert.equal(calls.savePhotoDIDs, 1);
  assert.ok(result.photoDID.startsWith('did:prism:fake'));
  assert.equal(result.proxyUrl, `https://ca.example/photo-proxy/${result.iagonFileId}`);

  // Mapping persisted
  assert.ok(photoDIDs['user-new-1']);
  assert.equal(photoDIDs['user-new-1'].photoDID, result.photoDID);
  assert.equal(photoDIDs['user-new-1'].iagonFileId, result.iagonFileId);
  assert.ok(photoDIDs['user-new-1'].createdAt);
});

test('createPhotoDID — propagates error when DID creation fails', async (t) => {
  const fakes = makeFakes();
  const failingFetch = async (url, options) => {
    if (url.includes('/did-registrar/dids') && !url.includes('/updates') && !url.includes('/publications')) {
      return { ok: false, status: 500, text: async () => 'agent error' };
    }
    return fakes.fetchImpl(url, options);
  };

  await assert.rejects(
    () => createPhotoDID('user-fail', 'data:image/jpeg;base64,ZmFrZQ==', {
      uploadPhotoToIagon: fakes.uploadPhotoToIagon, fetchImpl: failingFetch, apiKey: 'k',
      cloudAgentUrl: 'https://agent.example', publicBaseUrl: 'https://ca.example',
      photoDIDs: fakes.photoDIDs, savePhotoDIDs: fakes.savePhotoDIDs
    }),
    /DID create failed/
  );
  // Must not persist a partial mapping on failure
  assert.equal(Object.keys(fakes.photoDIDs).length, 0);
});

// ── Tests: /api/credentials/update-realperson branch selection ────────────────────────────

test('update-realperson — creates new photoDID when none exists (no re-issuance)', async (t) => {
  const userConnectionMappings = new Map([['user-1', { holderInfo: { firstName: 'A' } }]]);
  const photoDIDs = {};
  let createCalledWith = null;
  let updateCalled = false;

  const result = await updateRealPersonHandler({ uniqueId: 'user-1', newPhoto: 'data:image/jpeg;base64,abc' }, {
    userConnectionMappings, photoDIDs,
    createPhotoDIDFn: async (uniqueId, photo) => { createCalledWith = { uniqueId, photo }; return { photoDID: 'did:prism:new' }; },
    updateExistingPhotoDIDFn: async () => { updateCalled = true; }
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.action, 'photo-created');
  assert.deepEqual(createCalledWith, { uniqueId: 'user-1', photo: 'data:image/jpeg;base64,abc' });
  assert.equal(updateCalled, false, 'update branch must not run when creating');
});

test('update-realperson — existing behavior for update case is unchanged (calls UPDATE_SERVICE patch, not create)', async (t) => {
  const userConnectionMappings = new Map([['user-2', { holderInfo: { firstName: 'B' } }]]);
  const photoDIDs = { 'user-2': { photoDID: 'did:prism:existing', iagonFileId: 'old-file' } };
  let createCalled = false;
  let updateCalledWith = null;

  const result = await updateRealPersonHandler({ uniqueId: 'user-2', newPhoto: 'data:image/jpeg;base64,abc' }, {
    userConnectionMappings, photoDIDs,
    createPhotoDIDFn: async () => { createCalled = true; },
    updateExistingPhotoDIDFn: async (uniqueId, photo, existing) => { updateCalledWith = { uniqueId, photo, existing }; }
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.action, 'photo-updated');
  assert.equal(createCalled, false, 'create branch must not run when a photoDID already exists');
  assert.deepEqual(updateCalledWith, { uniqueId: 'user-2', photo: 'data:image/jpeg;base64,abc', existing: photoDIDs['user-2'] });
});

test('update-realperson — 404s when uniqueId has no user mapping (unchanged pre-existing check)', async (t) => {
  const result = await updateRealPersonHandler({ uniqueId: 'ghost-user', newPhoto: 'data:image/jpeg;base64,abc' }, {
    userConnectionMappings: new Map(), photoDIDs: {},
    createPhotoDIDFn: async () => { throw new Error('should not be called'); },
    updateExistingPhotoDIDFn: async () => { throw new Error('should not be called'); }
  });
  assert.equal(result.status, 404);
  assert.equal(result.body.success, false);
});

// ── Tests: /api/photos/update/:uniqueId branch selection + new userConnectionMappings guard ─

test('photos/update — creates new photoDID for a known user when none exists', async (t) => {
  const userConnectionMappings = new Map([['user-3', { holderInfo: { firstName: 'C' } }]]);
  const photoDIDs = {};
  let createCalledWith = null;

  const result = await photosUpdateHandler({ uniqueId: 'user-3', photo: 'data:image/jpeg;base64,abc' }, {
    userConnectionMappings, photoDIDs,
    createPhotoDIDFn: async (uniqueId, photo) => { createCalledWith = { uniqueId, photo }; return { photoDID: 'did:prism:new3', proxyUrl: 'https://ca.example/photo-proxy/f3' }; },
    updateExistingPhotoDIDFn: async () => { throw new Error('should not be called'); }
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.action, 'photo-created');
  assert.equal(result.body.photoDID, 'did:prism:new3');
  assert.equal(result.body.proxyUrl, 'https://ca.example/photo-proxy/f3');
  assert.deepEqual(createCalledWith, { uniqueId: 'user-3', photo: 'data:image/jpeg;base64,abc' });
});

test('photos/update — rejects unknown uniqueId on the create path (new guard)', async (t) => {
  const userConnectionMappings = new Map(); // 'unknown-user' is not in the map
  const photoDIDs = {};
  let createCalled = false;

  const result = await photosUpdateHandler({ uniqueId: 'unknown-user', photo: 'data:image/jpeg;base64,abc' }, {
    userConnectionMappings, photoDIDs,
    createPhotoDIDFn: async () => { createCalled = true; },
    updateExistingPhotoDIDFn: async () => { throw new Error('should not be called'); }
  });

  assert.equal(result.status, 404);
  assert.equal(createCalled, false, 'must not create a photo DID for an unknown uniqueId');
});

test('photos/update — existing behavior for update case is unchanged (no userConnectionMappings check on update branch)', async (t) => {
  // Deliberately empty userConnectionMappings — the update branch (existing photoDID) must NOT
  // be gated by it, only the new create branch is.
  const userConnectionMappings = new Map();
  const photoDIDs = { 'user-4': { photoDID: 'did:prism:existing4', iagonFileId: 'old-file-4' } };
  let updateCalledWith = null;
  let createCalled = false;

  const result = await photosUpdateHandler({ uniqueId: 'user-4', photo: 'data:image/jpeg;base64,abc' }, {
    userConnectionMappings, photoDIDs,
    createPhotoDIDFn: async () => { createCalled = true; },
    updateExistingPhotoDIDFn: async (uniqueId, photo, existing) => {
      updateCalledWith = { uniqueId, photo, existing };
      return { proxyUrl: 'https://ca.example/photo-proxy/new-file-4' };
    }
  });

  assert.equal(result.status, 200);
  assert.equal(createCalled, false);
  assert.equal(result.body.photoDID, 'did:prism:existing4');
  assert.deepEqual(updateCalledWith, { uniqueId: 'user-4', photo: 'data:image/jpeg;base64,abc', existing: photoDIDs['user-4'] });
});

test('photos/update — 400s when photo is missing', async (t) => {
  const result = await photosUpdateHandler({ uniqueId: 'user-5', photo: undefined }, {
    userConnectionMappings: new Map(), photoDIDs: {},
    createPhotoDIDFn: async () => { throw new Error('should not be called'); },
    updateExistingPhotoDIDFn: async () => { throw new Error('should not be called'); }
  });
  assert.equal(result.status, 400);
});
