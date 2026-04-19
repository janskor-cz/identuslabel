/**
 * FolderRegistry.js
 *
 * Server-side folder/file system for the employee portal document view.
 * Provides company-scoped folder trees and document→folder memberships.
 *
 * Design decisions:
 * - Folder names are not sensitive, so no encryption is applied.
 * - Folders are strictly company-scoped (ownerCompanyDID).
 * - Document access control (releasability + clearance) remains in DocumentRegistry.
 * - HMAC-SHA256 signature for tamper detection, matching DocumentRegistryPersistence pattern.
 */

const fs = require('fs').promises;
const crypto = require('crypto');
const path = require('path');

class FolderRegistry {
  constructor() {
    this.storagePath = path.join(__dirname, '..', 'data', 'folder-registry.json');
    this.signatureKey = 'folder-registry-integrity-key';

    // folderId → FolderRecord
    this.folders = new Map();

    // documentDID → folderId | null  (null = root / uncategorized)
    this.memberships = new Map();
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async initialize() {
    console.log('[FolderRegistry] Initializing...');
    try {
      await fs.access(this.storagePath);
    } catch {
      console.log('[FolderRegistry] No saved registry found (first run) — starting empty');
      return;
    }

    try {
      const fileContent = await fs.readFile(this.storagePath, 'utf8');
      const persisted = JSON.parse(fileContent);

      // Verify signature (empty signature = fresh bootstrap file, treat as first run)
      if (!persisted.signature) {
        console.log('[FolderRegistry] Fresh bootstrap file — starting empty');
        return;
      }
      const dataStr = JSON.stringify(persisted.registryState);
      const expected = crypto.createHmac('sha256', this.signatureKey).update(dataStr).digest('hex');
      if (persisted.signature !== expected) {
        throw new Error('Signature verification failed — folder registry may be tampered');
      }

      const { folders, memberships } = persisted.registryState;

      this.folders = new Map(folders.map(f => [f.folderId, f]));
      this.memberships = new Map(memberships.map(m => [m.documentDID, m.folderId]));

      console.log(`[FolderRegistry] ✅ Loaded ${this.folders.size} folders, ${this.memberships.size} memberships`);
    } catch (error) {
      console.error('[FolderRegistry] ❌ Failed to load:', error.message);
      throw error;
    }
  }

  async save() {
    const registryState = {
      version: '1.0',
      savedAt: new Date().toISOString(),
      folderCount: this.folders.size,
      membershipCount: this.memberships.size,
      folders: Array.from(this.folders.values()),
      memberships: Array.from(this.memberships.entries()).map(([documentDID, folderId]) => ({
        documentDID,
        folderId
      }))
    };

    const dataStr = JSON.stringify(registryState);
    const signature = crypto.createHmac('sha256', this.signatureKey).update(dataStr).digest('hex');

    const persisted = { registryState, signature, signedAt: new Date().toISOString() };

    await fs.mkdir(path.dirname(this.storagePath), { recursive: true });
    await fs.writeFile(this.storagePath, JSON.stringify(persisted, null, 2), 'utf8');
  }

  // ─── Folder CRUD ──────────────────────────────────────────────────────────

  /**
   * Create a new folder.
   * @param {Object} opts
   * @param {string} opts.name
   * @param {string|null} opts.parentFolderId
   * @param {string} opts.ownerCompanyDID
   * @param {string} [opts.createdByEmployeeId]
   * @returns {Object} FolderRecord
   */
  async createFolder({ name, parentFolderId = null, ownerCompanyDID, createdByEmployeeId = null }) {
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw new Error('Folder name is required');
    }
    if (name.trim().length > 100) {
      throw new Error('Folder name must be 100 characters or fewer');
    }

    if (parentFolderId) {
      const parent = this.folders.get(parentFolderId);
      if (!parent) throw new Error('Parent folder not found');
      if (parent.ownerCompanyDID !== ownerCompanyDID) throw new Error('Parent folder belongs to a different company');
    }

    const folderId = 'fldr-' + crypto.randomUUID();
    const now = new Date().toISOString();

    const record = {
      folderId,
      name: name.trim(),
      parentFolderId: parentFolderId || null,
      ownerCompanyDID,
      createdByEmployeeId,
      createdAt: now,
      updatedAt: now
    };

    this.folders.set(folderId, record);
    await this.save();
    return record;
  }

  /**
   * Rename a folder (validates ownership).
   */
  async renameFolder(folderId, newName, ownerCompanyDID) {
    const folder = this.folders.get(folderId);
    if (!folder) throw new Error('Folder not found');
    if (folder.ownerCompanyDID !== ownerCompanyDID) throw new Error('Access denied');
    if (!newName || newName.trim().length === 0) throw new Error('Folder name is required');
    if (newName.trim().length > 100) throw new Error('Folder name must be 100 characters or fewer');

    folder.name = newName.trim();
    folder.updatedAt = new Date().toISOString();
    await this.save();
    return folder;
  }

  /**
   * Delete a folder. Child folders are re-parented to this folder's parent.
   * Documents in the folder are moved to root (null).
   */
  async deleteFolder(folderId, ownerCompanyDID) {
    const folder = this.folders.get(folderId);
    if (!folder) throw new Error('Folder not found');
    if (folder.ownerCompanyDID !== ownerCompanyDID) throw new Error('Access denied');

    const newParent = folder.parentFolderId;

    // Re-parent direct child folders
    for (const [id, f] of this.folders) {
      if (f.parentFolderId === folderId && f.ownerCompanyDID === ownerCompanyDID) {
        f.parentFolderId = newParent;
        f.updatedAt = new Date().toISOString();
      }
    }

    // Move documents in this folder to parent (root if no parent)
    let movedDocCount = 0;
    for (const [did, fid] of this.memberships) {
      if (fid === folderId) {
        this.memberships.set(did, newParent);
        movedDocCount++;
      }
    }

    this.folders.delete(folderId);
    await this.save();
    return { movedDocumentCount: movedDocCount };
  }

  // ─── Membership ───────────────────────────────────────────────────────────

  /**
   * Add a document to a folder. Validates folder ownership.
   */
  async addDocumentToFolder(documentDID, folderId, ownerCompanyDID) {
    const folder = this.folders.get(folderId);
    if (!folder) throw new Error('Folder not found');
    if (folder.ownerCompanyDID !== ownerCompanyDID) throw new Error('Access denied');

    this.memberships.set(documentDID, folderId);
    await this.save();
  }

  /**
   * Remove a document from its folder (moves it back to root).
   */
  async removeDocumentFromFolder(documentDID) {
    this.memberships.set(documentDID, null);
    await this.save();
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  /**
   * Get all folders for a company with document counts.
   * @param {string} ownerCompanyDID
   * @returns {Array<FolderRecord & { documentCount: number }>}
   */
  getFoldersForCompany(ownerCompanyDID) {
    const companyFolderIds = new Set(
      Array.from(this.folders.values())
        .filter(f => f.ownerCompanyDID === ownerCompanyDID)
        .map(f => f.folderId)
    );

    // Count memberships per folder (only for this company's folders)
    const counts = new Map();
    for (const [, folderId] of this.memberships) {
      if (folderId && companyFolderIds.has(folderId)) {
        counts.set(folderId, (counts.get(folderId) || 0) + 1);
      }
    }

    return Array.from(this.folders.values())
      .filter(f => f.ownerCompanyDID === ownerCompanyDID)
      .map(f => ({ ...f, documentCount: counts.get(f.folderId) || 0 }));
  }

  /**
   * Build membership map for a specific company, filtered to a given set of visible document DIDs.
   * Returns { documentDID → folderId } for documents that have a folder assignment.
   * @param {string} ownerCompanyDID
   * @param {string[]} visibleDocumentDIDs
   * @returns {Object}
   */
  getMembershipMapForCompany(ownerCompanyDID, visibleDocumentDIDs) {
    const companyFolderIds = new Set(
      Array.from(this.folders.values())
        .filter(f => f.ownerCompanyDID === ownerCompanyDID)
        .map(f => f.folderId)
    );

    const map = {};
    for (const did of visibleDocumentDIDs) {
      const folderId = this.memberships.get(did);
      // Only include if folderId belongs to this company
      if (folderId && companyFolderIds.has(folderId)) {
        map[did] = folderId;
      }
    }
    return map;
  }

  /**
   * Get direct contents of a folder.
   * @param {string} folderId
   * @returns {{ subFolders: FolderRecord[], documentDIDs: string[] }}
   */
  getFolderContents(folderId) {
    const subFolders = Array.from(this.folders.values()).filter(f => f.parentFolderId === folderId);
    const documentDIDs = Array.from(this.memberships.entries())
      .filter(([, fid]) => fid === folderId)
      .map(([did]) => did);
    return { subFolders, documentDIDs };
  }

  /**
   * Get the folder a document is assigned to, or null if at root.
   * @param {string} documentDID
   * @returns {string|null}
   */
  getDocumentFolder(documentDID) {
    return this.memberships.get(documentDID) ?? null;
  }
}

module.exports = new FolderRegistry();
