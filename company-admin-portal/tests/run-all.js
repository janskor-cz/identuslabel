#!/usr/bin/env node
/**
 * run-all.js — Test orchestrator for 7 Three-Tier Encryption tasks
 *
 * Usage: node company-admin-portal/tests/run-all.js
 *
 * Writes report to: company-admin-portal/tests/TEST_REPORT.md
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Set up CMK env vars if not already set (for unit tests that don't start services)
const LEVELS = ['INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'TOP_SECRET'];
for (const level of LEVELS) {
  if (!process.env[`CMK_${level}`]) {
    process.env[`CMK_${level}`] = crypto.randomBytes(32).toString('base64');
    console.log(`[run-all] Set CMK_${level} (test-only random key)`);
  }
}

const testFiles = [
  'task1-cmk-store.test.js',
  'task2-dek-wrapping.test.js',
  'task3-registry-cleanup.test.js',
  'task4-access-pipeline.test.js',
  'task5-vc-schema.test.js',
  'task6-content-hash.test.js',
  'task7-sig-fallback.test.js'
];

async function main() {
  console.log('\n=== Three-Tier Encryption Task Tests ===\n');

  const allResults = [];

  for (const file of testFiles) {
    const filePath = path.join(__dirname, file);
    console.log(`\n--- Running ${file} ---`);

    let mod;
    try {
      mod = require(filePath);
    } catch (e) {
      console.error(`  LOAD ERROR: ${e.message}`);
      allResults.push({ task: file, name: `Load ${file}`, pass: false, error: e.message });
      continue;
    }

    try {
      const results = await mod.run();
      for (const r of results) {
        const icon = r.pass ? '✅' : '❌';
        console.log(`  ${icon} ${r.name}`);
        if (!r.pass) console.log(`     Error: ${r.error}`);
        allResults.push(r);
      }
    } catch (e) {
      console.error(`  RUN ERROR: ${e.message}`);
      allResults.push({ task: file, name: `Run ${file}`, pass: false, error: e.message });
    }
  }

  // Generate report
  const reportPath = path.join(__dirname, 'TEST_REPORT.md');
  const { generateReport } = require('./helpers/report');
  const summary = generateReport(allResults, reportPath);

  console.log('\n=== Summary ===');
  console.log(`Total: ${summary.total} | Passed: ${summary.passed} | Failed: ${summary.failed}`);
  console.log(`\nReport written to: ${reportPath}`);

  if (summary.failed > 0) {
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
