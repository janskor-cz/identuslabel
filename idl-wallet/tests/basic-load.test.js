/**
 * Basic Wallet Load Test
 *
 * Tests that Puppeteer can launch Chromium and load the Alice wallet
 * without errors. This is a foundational test to verify the setup.
 */

const puppeteer = require('puppeteer');

(async () => {
  console.log('🚀 Starting Basic Wallet Load Test...\n');

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
        '--disable-gpu',
        '--disable-software-rasterizer'
      ]
    });
    console.log('✅ Browser launched successfully\n');

    // Create new page
    const page = await browser.newPage();

    // Set viewport
    await page.setViewport({ width: 1280, height: 800 });

    // Enable console logging
    page.on('console', msg => {
      const type = msg.type();
      const text = msg.text();

      // Filter out noise
      if (text.includes('Agent started')) {
        console.log('  ✅ Browser Console:', text);
      } else if (type === 'error') {
        console.log('  ❌ Browser Console Error:', text);
      }
    });

    // Track page errors
    let pageErrors = [];
    page.on('pageerror', error => {
      pageErrors.push(error.message);
      console.log('  ❌ Page Error:', error.message);
    });

    // Navigate to wallet
    console.log('🔗 Navigating to Alice wallet (http://91.99.4.54:3001)...');
    const response = await page.goto('http://91.99.4.54:3001', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Test 1: Page loads successfully
    if (response && response.status() === 200) {
      console.log('✅ Test 1: Page loaded successfully (HTTP 200)\n');
      testsPassed++;
    } else {
      console.log(`❌ Test 1: Page load failed (HTTP ${response ? response.status() : 'N/A'})\n`);
      testsFailed++;
    }

    // Wait for page to settle
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Test 2: No critical JavaScript errors
    if (pageErrors.length === 0) {
      console.log('✅ Test 2: No JavaScript errors detected\n');
      testsPassed++;
    } else {
      console.log(`❌ Test 2: ${pageErrors.length} JavaScript errors detected:`);
      pageErrors.forEach(err => console.log(`  - ${err}`));
      console.log('');
      testsFailed++;
    }

    // Test 3: Check for specific elements
    console.log('🔍 Checking for wallet UI elements...');
    const hasNavigation = await page.$('nav') !== null;
    const hasMainContent = await page.$('main') !== null || await page.$('#__next') !== null;

    if (hasNavigation || hasMainContent) {
      console.log('✅ Test 3: Wallet UI elements detected\n');
      testsPassed++;
    } else {
      console.log('❌ Test 3: Expected UI elements not found\n');
      testsFailed++;
    }

    // Test 4: Take screenshot
    console.log('📸 Taking screenshot...');
    await page.screenshot({ path: '/tmp/alice-wallet-screenshot.png', fullPage: true });
    console.log('✅ Test 4: Screenshot saved to /tmp/alice-wallet-screenshot.png\n');
    testsPassed++;

    // Summary
    console.log('=' .repeat(60));
    console.log('TEST SUMMARY');
    console.log('=' .repeat(60));
    console.log(`✅ Passed: ${testsPassed}`);
    console.log(`❌ Failed: ${testsFailed}`);
    console.log(`📊 Total:  ${testsPassed + testsFailed}`);
    console.log('=' .repeat(60));

    await browser.close();

    // Exit with appropriate code
    process.exit(testsFailed > 0 ? 1 : 0);

  } catch (error) {
    console.error('❌ Test execution failed:', error.message);
    console.error('Stack trace:', error.stack);
    if (browser) {
      await browser.close();
    }
    process.exit(1);
  }
})();
