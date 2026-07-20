/**
 * ReleasablePartnersRegistry.js
 *
 * Admin-manageable "Releasable To" partner list for the employee document-upload
 * modal. Each company's admin maintains their own list of partner entries
 * (Name + DID) — companies whose employees may be granted discovery access to a
 * newly-uploaded classified document. The employee-facing upload modal renders
 * this list dynamically (plus the uploading employee's own company, always
 * locked on) instead of the old hardcoded two-checkbox HTML.
 *
 * Design decisions:
 * - Company-scoped: each companyId owns its own independent partner array.
 * - HMAC-SHA256 signature for tamper detection, matching FolderRegistry /
 *   DocumentRegistryPersistence pattern.
 * - Route handlers must derive the company identifier from the verified
 *   session/req.company — never from client-supplied input — same rule as
 *   FolderRegistry's own documented security fix.
 */

const fs = require('fs').promises;
const crypto = require('crypto');
const path = require('path');

class ReleasablePartnersRegistry {
  constructor() {
    this.storagePath = path.join(__dirname, '..', 'data', 'releasable-partners.json');
    this.signatureKey = 'releasable-partners-integrity-key';

    // companyId → Array<{ id, name, did, addedAt }>
    this.partners = new Map();
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async initialize() {
    console.log('[ReleasablePartnersRegistry] Initializing...');
    try {
      await fs.access(this.storagePath);
    } catch {
      console.log('[ReleasablePartnersRegistry] No saved registry found (first run) — starting empty');
      return;
    }

    try {
      const fileContent = await fs.readFile(this.storagePath, 'utf8');
      const persisted = JSON.parse(fileContent);

      // Verify signature (empty signature = fresh bootstrap file, treat as first run)
      if (!persisted.signature) {
        console.log('[ReleasablePartnersRegistry] Fresh bootstrap file — starting empty');
        return;
      }
      const dataStr = JSON.stringify(persisted.registryState);
      const expected = crypto.createHmac('sha256', this.signatureKey).update(dataStr).digest('hex');
      if (persisted.signature !== expected) {
        throw new Error('Signature verification failed — releasable partners registry may be tampered');
      }

      const { partners } = persisted.registryState;
      this.partners = new Map(partners.map(p => [p.companyId, p.entries]));

      console.log(`[ReleasablePartnersRegistry] ✅ Loaded partner lists for ${this.partners.size} companies`);
    } catch (error) {
      console.error('[ReleasablePartnersRegistry] ❌ Failed to load:', error.message);
      throw error;
    }
  }

  async save() {
    const registryState = {
      version: '1.0',
      savedAt: new Date().toISOString(),
      partners: Array.from(this.partners.entries()).map(([companyId, entries]) => ({
        companyId,
        entries
      }))
    };

    const dataStr = JSON.stringify(registryState);
    const signature = crypto.createHmac('sha256', this.signatureKey).update(dataStr).digest('hex');

    const persisted = { registryState, signature, signedAt: new Date().toISOString() };

    await fs.mkdir(path.dirname(this.storagePath), { recursive: true });
    await fs.writeFile(this.storagePath, JSON.stringify(persisted, null, 2), 'utf8');
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  /**
   * Get all partners registered for a company.
   * @param {string} companyId
   * @returns {Array<{id, name, did, addedAt}>} empty array if none added yet
   */
  getPartnersForCompany(companyId) {
    return this.partners.get(companyId) || [];
  }

  // ─── Mutators ─────────────────────────────────────────────────────────────

  /**
   * Add a partner (Name + DID) to a company's releasable-to list.
   * @param {string} companyId
   * @param {Object} opts
   * @param {string} opts.name
   * @param {string} opts.did
   * @returns {Object} the new partner entry
   */
  async addPartner(companyId, { name, did }) {
    const trimmedName = typeof name === 'string' ? name.trim() : '';
    if (!trimmedName) {
      throw new Error('Partner name is required');
    }
    if (typeof did !== 'string' || !did.startsWith('did:')) {
      throw new Error('Partner did must start with "did:"');
    }
    // Defense-in-depth: DIDs are structured identifiers (method-name + method-specific-id,
    // RFC3986 URI-safe characters only) and should never legitimately contain whitespace or
    // HTML/attribute-breaking characters. Rejecting these here means a malicious admin can't
    // plant a did value that breaks out of an HTML attribute when later rendered in the
    // employee-facing upload modal (see escapeAttr() in employee-portal-dashboard.js).
    if (/[\s<>"'`]/.test(did)) {
      throw new Error('Partner did must not contain whitespace or HTML-significant characters');
    }

    const entry = {
      id: crypto.randomUUID(),
      name: trimmedName,
      did,
      addedAt: new Date().toISOString()
    };

    const existing = this.partners.get(companyId) || [];
    existing.push(entry);
    this.partners.set(companyId, existing);

    await this.save();
    return entry;
  }

  /**
   * Remove a partner from a company's releasable-to list.
   * No-op (no throw) if the partner id isn't found.
   * @param {string} companyId
   * @param {string} partnerId
   */
  async removePartner(companyId, partnerId) {
    const existing = this.partners.get(companyId) || [];
    this.partners.set(companyId, existing.filter(p => p.id !== partnerId));
    await this.save();
  }
}

module.exports = new ReleasablePartnersRegistry();
// Expose the class too (attached to the singleton export) so tests can construct an
// independent instance pointed at a temp storagePath, without touching the real
// data/releasable-partners.json used by the singleton required elsewhere.
module.exports.ReleasablePartnersRegistry = ReleasablePartnersRegistry;
