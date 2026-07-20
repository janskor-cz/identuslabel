'use strict';

/**
 * AccessGateLogDedup.js
 *
 * Pure "was this recently logged" decision used by POST /api/access-gate/notify to avoid
 * writing a second, noise-duplicate access-gate-log.jsonl row for a document that was already
 * logged — by /api/access-gate/present's grant write (the single site both /present and its
 * DIDComm-equivalent /api/document-access/complete loopback-call through), or by a previous
 * /notify call — within the last DEDUP_WINDOW_MS.
 *
 * Background: the wallet calls /notify every time it decrypts a document via a cached
 * ephemeral key, including the very first view immediately after a fresh grant. Since the
 * grant flow already writes a "Granted" row, every real access produced two rows — one with
 * the real viewer's name, one noise duplicate with viewerName: null. Deduping in-memory (no
 * file I/O, no linear scan of a possibly-large JSONL file per request) is the cheapest fix.
 *
 * Kept as a standalone pure function (no fs, no Map ownership) so the actual skip/don't-skip
 * decision has a real unit test instead of only a source-level regression check. The caller
 * owns the `documentDID -> lastLoggedAt` Map and passes in whatever value it looked up.
 */

const DEDUP_WINDOW_MS = 60 * 1000;

/**
 * @param {number|undefined|null} lastLoggedAt - epoch ms of the last known access-gate-log
 *   write for this documentDID, or undefined/null if none is known.
 * @param {number} now - current epoch ms.
 * @param {number} [windowMs] - dedup window in ms (defaults to DEDUP_WINDOW_MS).
 * @returns {boolean} true if a new write for this documentDID should be SKIPPED as a duplicate.
 */
function shouldSkipDuplicateLog(lastLoggedAt, now, windowMs = DEDUP_WINDOW_MS) {
  if (lastLoggedAt === undefined || lastLoggedAt === null) return false;
  if (typeof lastLoggedAt !== 'number' || typeof now !== 'number') return false;
  return (now - lastLoggedAt) < windowMs;
}

module.exports = { shouldSkipDuplicateLog, DEDUP_WINDOW_MS };
