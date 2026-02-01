/**
 * Buffer Error Detection Test
 *
 * Monitors browser console for "undefined 't' error" or any Buffer-related errors.
 * This test helps diagnose the iPhone QR scanning issue.
 */

const puppeteer = require('puppeteer');

(async () => {
  console.log('🚀 Starting Buffer Error Detection Test...\n');

  let browser;
  let testsPassed = 0;
  let testsFailed = 0;

  try {
    // Launch browser
    console.log('📱 Launching Chromium browser...');
    browser = await puppeteer.launch({
      executablePath: '/snap/bin/chromium',
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });
    console.log('✅ Browser launched successfully\n');

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Track all console messages
    let consoleMessages = [];
    page.on('console', msg => {
      const type = msg.type();
      const text = msg.text();
      consoleMessages.push({ type, text });

      // Highlight suspicious messages
      if (text.toLowerCase().includes('buffer') ||
          text.toLowerCase().includes(' t is not') ||
          text.toLowerCase().includes('undefined')) {
        console.log(`  ⚠️  [${type}] ${text}`);
      }
    });

    // Track page errors
    let pageErrors = [];
    page.on('pageerror', error => {
      pageErrors.push(error.message);
      console.log('  ❌ Page Error:', error.message);
    });

    // Navigate to wallet
    console.log('🔗 Loading Alice wallet...');
    await page.goto('http://91.99.4.54:3001', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    console.log('✅ Page loaded\n');

    // Wait for initialization
    console.log('⏳ Waiting for wallet initialization (10 seconds)...');
    await new Promise(resolve => setTimeout(resolve, 10000));
    console.log('✅ Initialization complete\n');

    // Test 1: Check for Buffer-related errors
    console.log('🔍 Test 1: Checking for Buffer errors...');
    const bufferErrors = pageErrors.filter(err =>
      err.toLowerCase().includes('buffer') ||
      err.toLowerCase().includes(' t is not') ||
      err.toLowerCase().includes('t.from')
    );

    if (bufferErrors.length === 0) {
      console.log('✅ No Buffer-related errors detected\n');
      testsPassed++;
    } else {
      console.log(`❌ Found ${bufferErrors.length} Buffer-related errors:`);
      bufferErrors.forEach(err => console.log(`  - ${err}`));
      console.log('');
      testsFailed++;
    }

    // Test 2: Check console messages for warnings
    console.log('🔍 Test 2: Checking console messages...');
    const suspiciousMessages = consoleMessages.filter(msg =>
      msg.text.toLowerCase().includes('buffer') ||
      msg.text.toLowerCase().includes(' t is not') ||
      msg.text.toLowerCase().includes('undefined')
    );

    if (suspiciousMessages.length === 0) {
      console.log('✅ No suspicious console messages\n');
      testsPassed++;
    } else {
      console.log(`⚠️  Found ${suspiciousMessages.length} suspicious messages:`);
      suspiciousMessages.forEach(msg => console.log(`  [${msg.type}] ${msg.text}`));
      console.log('');
      // This is a warning, not a failure
      testsPassed++;
    }

    // Test 3: Navigate to Verify page (triggers QR scanner component)
    console.log('🔍 Test 3: Loading Verify page (QR scanner)...');
    try {
      await page.goto('http://91.99.4.54:3001/verify', {
        waitUntil: 'networkidle2',
        timeout: 15000
      });

      await new Promise(resolve => setTimeout(resolve, 3000));

      // Check for new errors after loading QR page
      const newBufferErrors = pageErrors.filter(err =>
        err.toLowerCase().includes('buffer') ||
        err.toLowerCase().includes(' t is not')
      ).length - bufferErrors.length;

      if (newBufferErrors === 0) {
        console.log('✅ Verify page loaded without Buffer errors\n');
        testsPassed++;
      } else {
        console.log(`❌ Verify page triggered ${newBufferErrors} new Buffer errors\n`);
        testsFailed++;
      }
    } catch (error) {
      console.log('❌ Failed to load Verify page:', error.message, '\n');
      testsFailed++;
    }

    // Summary
    console.log('=' .repeat(60));
    console.log('BUFFER ERROR TEST SUMMARY');
    console.log('=' .repeat(60));
    console.log(`Total page errors: ${pageErrors.length}`);
    console.log(`Buffer-related errors: ${bufferErrors.length}`);
    console.log(`Suspicious console messages: ${suspiciousMessages.length}`);
    console.log('');
    console.log(`✅ Tests Passed: ${testsPassed}`);
    console.log(`❌ Tests Failed: ${testsFailed}`);
    console.log('=' .repeat(60));

    // Detailed error report
    if (pageErrors.length > 0) {
      console.log('\n📋 Full Error Report:');
      pageErrors.forEach((err, i) => {
        console.log(`${i + 1}. ${err}`);
      });
    }

    await browser.close();
    process.exit(testsFailed > 0 ? 1 : 0);

  } catch (error) {
    console.error('❌ Test execution failed:', error.message);
    if (browser) {
      await browser.close();
    }
    process.exit(1);
  }
})();
