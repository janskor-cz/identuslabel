'use strict';

const fs   = require('fs');
const fsP  = require('fs').promises;
const path = require('path');

const LOG_FILE = path.join(__dirname, '..', 'data', 'access.log');

/**
 * Append one access event to the local log (fire-and-forget, sync to avoid blocking requests).
 * Each line is a JSON object.
 */
function append(event) {
  try {
    const line = JSON.stringify({ ...event, timestamp: event.timestamp || new Date().toISOString() }) + '\n';
    fs.appendFileSync(LOG_FILE, line);
  } catch (err) {
    console.warn('[LocalAuditLog] Failed to write log entry:', err.message);
  }
}

/**
 * Read and filter log entries.
 *
 * @param {object} opts
 * @param {number}  opts.limit       - max entries per page (default 50)
 * @param {number}  opts.offset      - skip N entries from filtered set (default 0)
 * @param {string}  opts.documentDID - filter by exact document DID
 * @param {boolean} opts.granted     - filter by access granted (true/false, omit = all)
 * @param {string}  opts.fromDate    - ISO date string lower bound
 * @param {string}  opts.toDate      - ISO date string upper bound
 * @returns {Promise<{ total: number, entries: object[] }>}
 */
async function getEntries({ limit = 50, offset = 0, documentDID, granted, fromDate, toDate } = {}) {
  let raw;
  try {
    raw = await fsP.readFile(LOG_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { total: 0, entries: [] };
    throw err;
  }

  let entries = [];
  for (const line of raw.trim().split('\n')) {
    if (!line) continue;
    try { entries.push(JSON.parse(line)); } catch (_) { /* skip malformed */ }
  }

  // Newest first
  entries.reverse();

  if (documentDID) entries = entries.filter(e => e.documentDID === documentDID);
  if (granted !== undefined && granted !== null) entries = entries.filter(e => e.accessGranted === granted);
  if (fromDate) entries = entries.filter(e => (e.timestamp || '') >= fromDate);
  if (toDate)   entries = entries.filter(e => (e.timestamp || '') <= toDate);

  return { total: entries.length, entries: entries.slice(offset, offset + limit) };
}

module.exports = { append, getEntries };
