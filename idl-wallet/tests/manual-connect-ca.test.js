/**
 * Manual Connect to CA Test
 *
 * Simulates exact user workflow:
 * 1. Open Alice wallet at https://identuslabel.cz/alice
 * 2. Connect wallet (initialize agent)
 * 3. Navigate to Connections tab
 * 4. Click "Connect to CA" button
 * 5. Verify proactive warning and behavior
 */

const puppeteer = require('puppeteer');

(async () => {
  console.log('🚀 Starting Manual "Connect to CA" Test...\n');

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
        '--ignore-certificate-errors' // For HTTPS
      ]
    });
    console.log('✅ Browser launched successfully\n');

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Capture all console messages
    let consoleMessages = [];
    page.on('console', msg => {
      const type = msg.type();
      const text = msg.text();
      consoleMessages.push({ type, text, timestamp: Date.now() });

      // Echo important logs
      if (text.includes('[CA CONNECT]') ||
          text.includes('Agent started') ||
          text.includes('Mediator') ||
          text.includes('ConnectToCA')) {
        console.log(`  [Browser ${type}] ${text}`);
      }
    });

    // Capture errors
    let pageErrors = [];
    page.on('pageerror', error => {
      pageErrors.push(error.message);
      console.log('  ❌ Page Error:', error.message);
    });

    // ====================================================================
    // STEP 1: Navigate to Alice wallet
    // ====================================================================
    console.log('🔗 STEP 1: Loading Alice wallet...');
    console.log('   URL: https://identuslabel.cz/alice\n');

    await page.goto('https://identuslabel.cz/alice', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    console.log('✅ Alice wallet loaded\n');

    // Wait for React to initialize
    console.log('⏳ Waiting for React initialization (3 seconds)...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    console.log('');

    // ====================================================================
    // STEP 2: Initialize agent (Click "Connect" button)
    // ====================================================================
    console.log('🔧 STEP 2: Initializing wallet agent...');

    const connectButtonClicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const connectButton = buttons.find(btn =>
        btn.textContent.includes('Connect') &&
        !btn.textContent.includes('Connect to')
      );

      if (connectButton) {
        console.log('[TEST] Found Connect button, clicking...');
        connectButton.click();
        return true;
      }
      return false;
    });

    if (connectButtonClicked) {
      console.log('✅ "Connect" button clicked\n');

      // Wait for agent initialization
      console.log('⏳ Waiting for agent initialization (10 seconds)...');
      await new Promise(resolve => setTimeout(resolve, 10000));
      console.log('');
    } else {
      console.log('⚠️  "Connect" button not found - agent may already be initialized\n');
    }

    // ====================================================================
    // STEP 3: Navigate to Connections tab
    // ====================================================================
    console.log('🔗 STEP 3: Navigating to Connections tab...');

    await page.goto('https://identuslabel.cz/alice/connections', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    console.log('✅ Connections page loaded\n');

    // Wait for page to settle
    console.log('⏳ Waiting for page to settle (3 seconds)...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    console.log('');

    // ====================================================================
    // TEST: Check for proactive warning box
    // ====================================================================
    console.log('🔍 TEST: Checking for proactive warning box...\n');

    const warningBoxInfo = await page.evaluate(() => {
      // Look for orange warning box about mediator
      const orangeBoxes = document.querySelectorAll('[class*="bg-orange"]');

      for (const box of orangeBoxes) {
        const text = box.textContent;
        if (text.includes('Mediator Required') ||
            text.includes('mediator') ||
            text.includes('Mediator')) {
          return {
            found: true,
            text: text.substring(0, 500),
            visible: box.offsetParent !== null
          };
        }
      }
      return { found: false };
    });

    if (warningBoxInfo.found) {
      console.log('✅ PROACTIVE WARNING BOX FOUND!');
      console.log('   Visible:', warningBoxInfo.visible ? 'YES' : 'NO');
      console.log('   Content preview:');
      console.log('   ' + warningBoxInfo.text.substring(0, 200) + '...\n');
      testsPassed++;
    } else {
      console.log('❌ Proactive warning box NOT found');
      console.log('   Expected: Orange box with mediator configuration guidance\n');
      testsFailed++;
    }

    // ====================================================================
    // TEST: Check for "Connect to CA" button
    // ====================================================================
    console.log('🔍 TEST: Checking "Connect to CA" button...\n');

    const buttonInfo = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const connectButton = buttons.find(btn =>
        btn.textContent.includes('Connect to CA') ||
        btn.textContent.includes('Connect to Certification Authority')
      );

      if (!connectButton) {
        return { exists: false };
      }

      return {
        exists: true,
        disabled: connectButton.disabled,
        text: connectButton.textContent.trim(),
        visible: connectButton.offsetParent !== null
      };
    });

    if (!buttonInfo.exists) {
      console.log('❌ "Connect to CA" button not found on page!\n');
      testsFailed++;
    } else {
      console.log(`✅ "Connect to CA" button found`);
      console.log(`   Text: "${buttonInfo.text}"`);
      console.log(`   Disabled: ${buttonInfo.disabled ? 'YES' : 'NO'}`);
      console.log(`   Visible: ${buttonInfo.visible ? 'YES' : 'NO'}\n`);
      testsPassed++;
    }

    // ====================================================================
    // STEP 4: Click "Connect to CA" button
    // ====================================================================
    if (buttonInfo.exists && !buttonInfo.disabled) {
      console.log('🔧 STEP 4: Clicking "Connect to CA" button...\n');

      // Clear previous console messages counter
      const preClickMessageCount = consoleMessages.length;

      // Click the button
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const connectButton = buttons.find(btn =>
          btn.textContent.includes('Connect to CA')
        );
        if (connectButton) {
          console.log('[TEST] Clicking Connect to CA button...');
          connectButton.click();
        }
      });

      // Wait for processing
      console.log('⏳ Waiting for response (8 seconds)...');
      await new Promise(resolve => setTimeout(resolve, 8000));
      console.log('');

      // Check for error box in UI
      console.log('🔍 Checking for error/success messages in UI...');
      const messageBoxInfo = await page.evaluate(() => {
        // Look for error boxes (red background)
        const errorBoxes = document.querySelectorAll('[class*="bg-red"]');
        // Look for success boxes (green background)
        const successBoxes = document.querySelectorAll('[class*="bg-green"]');

        const errors = Array.from(errorBoxes).map(box => box.textContent.trim());
        const successes = Array.from(successBoxes).map(box => box.textContent.trim());

        return {
          errorCount: errors.length,
          successCount: successes.length,
          errors: errors,
          successes: successes
        };
      });

      if (messageBoxInfo.errorCount > 0) {
        console.log(`⚠️  Found ${messageBoxInfo.errorCount} error message(s):`);
        messageBoxInfo.errors.forEach((msg, i) => {
          console.log(`   ${i + 1}. ${msg.substring(0, 150)}`);
        });
        console.log('');
      }

      if (messageBoxInfo.successCount > 0) {
        console.log(`✅ Found ${messageBoxInfo.successCount} success message(s):`);
        messageBoxInfo.successes.forEach((msg, i) => {
          console.log(`   ${i + 1}. ${msg.substring(0, 150)}`);
        });
        console.log('');
      }

      if (messageBoxInfo.errorCount === 0 && messageBoxInfo.successCount === 0) {
        console.log('ℹ️  No error or success messages visible in UI\n');
      }

      // Analyze console messages after click
      const postClickMessages = consoleMessages.slice(preClickMessageCount);

      console.log(`📊 Captured ${postClickMessages.length} console messages after button click\n`);

      if (postClickMessages.length > 0) {
        console.log('📋 Console Log Analysis:');
        console.log('  ' + '='.repeat(60));

        postClickMessages.forEach(msg => {
          const prefix = msg.type === 'error' ? '❌' :
                        msg.type === 'warning' ? '⚠️ ' :
                        msg.text.includes('[CA CONNECT]') ? '🔍' : '  ';
          console.log(`  ${prefix} [${msg.type}] ${msg.text}`);
        });

        console.log('  ' + '='.repeat(60));
        console.log('');
      }
    } else {
      console.log('⏭️  STEP 4: Skipped (button disabled or not found)\n');
    }

    // ====================================================================
    // Take screenshot
    // ====================================================================
    await page.screenshot({
      path: '/tmp/connect-ca-manual-test.png',
      fullPage: true
    });
    console.log('📸 Screenshot saved: /tmp/connect-ca-manual-test.png\n');

    // ====================================================================
    // SUMMARY
    // ====================================================================
    console.log('=' .repeat(70));
    console.log('TEST SUMMARY');
    console.log('=' .repeat(70));
    console.log(`✅ Tests Passed: ${testsPassed}`);
    console.log(`❌ Tests Failed: ${testsFailed}`);
    console.log('=' .repeat(70));
    console.log('');

    console.log('🔬 KEY FINDINGS:');
    console.log('');

    if (warningBoxInfo.found) {
      console.log('✅ Proactive warning box is working correctly');
      console.log('   Users see guidance BEFORE clicking the button');
    } else {
      console.log('❌ Proactive warning box not displayed');
      console.log('   Users may click button without seeing guidance');
    }

    console.log('');
    console.log('📸 Review screenshot at: /tmp/connect-ca-manual-test.png');
    console.log('');

    await browser.close();
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
