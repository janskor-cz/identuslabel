/**
 * DocumentTracker.js
 *
 * Tracks which external document DIDs each company has explicitly opted in to watch.
 *
 * Own documents (ownerCompanyDID === companyDID) are always discoverable and do NOT
 * need to be tracked here. This module only manages the "external tracking" list.
 *
 * Persistence: JSON file signed with HMAC-SHA256 (same pattern as FolderRegistry).
 */

const fs = require('fs').promises;
const crypto = require('crypto');
const path = require('path');

class DocumentTracker {
  constructor() {
    this.storagePath = path.join(__dirname, '..', 'data', 'document-tracker.json');
    this.signatureKey = 'document-tracker-integrity-key';
    // companyDID → Set<documentDID>
    this.tracked = new Map();
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async initialize() {
    console.log('[DocumentTracker] Initializing...');
    try {
      await fs.access(this.storagePath);
    } catch {
      console.log('[DocumentTracker] No saved tracker found — starting empty');
      return;
    }

    try {
      const fileContent = await fs.readFile(this.storagePath, 'utf8');
      const persisted = JSON.parse(fileContent);

      if (!persisted.signature) {
        console.log('[DocumentTracker] Fresh bootstrap file — starting empty');
        return;
      }

      const dataStr = JSON.stringify(persisted.trackerState);
      const expected = crypto.createHmac('sha256', this.signatureKey).update(dataStr).digest('hex');
      if (persisted.signature !== expected) {
        throw new Error('Signature verification failed — document tracker may be tampered');
      }

      for (const { companyDID, documentDIDs } of persisted.trackerState.entries) {
        this.tracked.set(companyDID, new Set(documentDIDs));
      }

      const totalEntries = Array.from(this.tracked.values()).reduce((s, v) => s + v.size, 0);
      console.log(`[DocumentTracker] ✅ Loaded ${this.tracked.size} companies, ${totalEntries} tracked documents`);
    } catch (error) {
      console.error('[DocumentTracker] ❌ Failed to load:', error.message);
      throw error;
    }
  }

  async save() {
    const entries = Array.from(this.tracked.entries()).map(([companyDID, dids]) => ({
      companyDID,
      documentDIDs: Array.from(dids)
    }));

    const trackerState = {
      version: '1.0',
      savedAt: new Date().toISOString(),
      companyCount: this.tracked.size,
      entries
    };

    const dataStr = JSON.stringify(trackerState);
    const signature = crypto.createHmac('sha256', this.signatureKey).update(dataStr).digest('hex');
    const persisted = { trackerState, signature, signedAt: new Date().toISOString() };

    await fs.mkdir(path.dirname(this.storagePath), { recursive: true });
    await fs.writeFile(this.storagePath, JSON.stringify(persisted, null, 2), 'utf8');
  }

  // ─── API ──────────────────────────────────────────────────────────────────

  async trackDocument(companyDID, documentDID) {
    if (!this.tracked.has(companyDID)) {
      this.tracked.set(companyDID, new Set());
    }
    this.tracked.get(companyDID).add(documentDID);
    await this.save();
  }

  async untrackDocument(companyDID, documentDID) {
    this.tracked.get(companyDID)?.delete(documentDID);
    await this.save();
  }

  isTracked(companyDID, documentDID) {
    return this.tracked.get(companyDID)?.has(documentDID) ?? false;
  }

  getTrackedForCompany(companyDID) {
    return Array.from(this.tracked.get(companyDID) ?? []);
  }
}

module.exports = new DocumentTracker();
