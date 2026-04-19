/**
 * walletFolderStorage.ts
 *
 * Client-side folder management for the wallet's file explorer.
 * Stores folders and document-to-folder mappings in localStorage
 * via the existing prefixedStorage utilities.
 */

import { getItem, setItem } from './prefixedStorage';

export interface WalletFolder {
  id: string;
  name: string;
  parentId: string | null; // null = root level
  createdAt: string;
}

const FOLDERS_KEY    = 'wallet-folders';
const DOC_FOLDER_KEY = 'wallet-doc-folders';

// ── Folder CRUD ────────────────────────────────────────────────────────────

export function getFolders(): WalletFolder[] {
  return (getItem(FOLDERS_KEY) as WalletFolder[]) || [];
}

function saveFolders(folders: WalletFolder[]): void {
  setItem(FOLDERS_KEY, folders);
}

export function createFolder(name: string, parentId: string | null = null): WalletFolder {
  const folders = getFolders();
  const folder: WalletFolder = {
    id: crypto.randomUUID(),
    name,
    parentId,
    createdAt: new Date().toISOString(),
  };
  folders.push(folder);
  saveFolders(folders);
  return folder;
}

export function renameFolder(id: string, name: string): void {
  const folders = getFolders();
  const f = folders.find(f => f.id === id);
  if (f) {
    f.name = name;
    saveFolders(folders);
  }
}

export function deleteFolder(id: string): void {
  const folders = getFolders();
  const target = folders.find(f => f.id === id);
  const parentId = target?.parentId ?? null;

  // Collect all descendant folder IDs (recursive)
  function descendants(fid: string): string[] {
    const children = folders.filter(f => f.parentId === fid);
    return [fid, ...children.flatMap(c => descendants(c.id))];
  }
  const toDelete = new Set(descendants(id));

  // Move documents that were inside any deleted folder up to parent
  const map = getDocFolderMap();
  for (const did of Object.keys(map)) {
    const fid = map[did];
    if (fid && toDelete.has(fid)) {
      map[did] = parentId;
    }
  }
  saveDocFolderMap(map);

  // Remove the folders
  saveFolders(folders.filter(f => !toDelete.has(f.id)));
}

// ── Document ↔ Folder mapping ──────────────────────────────────────────────

export function getDocFolderMap(): Record<string, string | null> {
  return (getItem(DOC_FOLDER_KEY) as Record<string, string | null>) || {};
}

function saveDocFolderMap(map: Record<string, string | null>): void {
  setItem(DOC_FOLDER_KEY, map);
}

/** Assign a document to a folder (or null for root). */
export function setDocFolder(originalDocumentDID: string, folderId: string | null): void {
  const map = getDocFolderMap();
  map[originalDocumentDID] = folderId;
  saveDocFolderMap(map);
}

/** Remove a document from all folder tracking (e.g. on delete). */
export function removeDocFromFolders(originalDocumentDID: string): void {
  const map = getDocFolderMap();
  delete map[originalDocumentDID];
  saveDocFolderMap(map);
}
