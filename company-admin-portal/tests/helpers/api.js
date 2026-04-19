/**
 * Shared API helpers for task tests
 */

const COMPANY_ADMIN_URL = process.env.COMPANY_ADMIN_URL || 'http://localhost:3010';
const DOCUMENT_SERVICE_URL = process.env.DOCUMENT_SERVICE_URL || 'http://localhost:3020';

async function get(path, base = COMPANY_ADMIN_URL) {
  const res = await fetch(`${base}${path}`);
  return res;
}

async function post(path, body, base = COMPANY_ADMIN_URL) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res;
}

async function healthCheck() {
  const res = await get('/api/health');
  if (!res.ok) throw new Error(`Company admin health check failed: ${res.status}`);
  return res.json();
}

async function healthCheckDocService() {
  const res = await get('/health', DOCUMENT_SERVICE_URL);
  if (!res.ok) throw new Error(`Document service health check failed: ${res.status}`);
  return res.json();
}

module.exports = { get, post, healthCheck, healthCheckDocService, COMPANY_ADMIN_URL, DOCUMENT_SERVICE_URL };
