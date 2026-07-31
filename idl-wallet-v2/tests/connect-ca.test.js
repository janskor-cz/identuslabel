/**
 * Connect to CA Button Diagnostic Test
 *
 * Diagnoses why the "Connect to CA" button doesn't work.
 * Checks agent initialization, mediator configuration, button state,
 * and captures all console logs when button is clicked.
 */

const puppeteer = require('puppeteer');

(async () => {
  console.log('🚀 Starting "Connect to CA" Button Diagnostic Test...\n');

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

    // Capture all console messages
    let consoleMessages = [];
    page.on('console', msg => {
      const type = msg.type();
      const text = msg.text();
      consoleMessages.push({ type, text, timestamp: Date.now() });

      // Echo important logs
      if (text.includes('[CA CONNECT]') ||
          text.includes('Agent started') ||
          text.includes('Mediator')) {
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
    // SIMULATE USER WORKFLOW: Initialize wallet first
    // ====================================================================
    console.log('🔧 SIMULATING USER WORKFLOW: Initialize wallet first\n');

    // Step 1: Load home page
    console.log('🔗 Step 1: Loading wallet home page...');
    await page.goto('http://91.99.4.54:3001/', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    console.log('✅ Home page loaded\n');

    // Wait for React to initialize
    console.log('⏳ Waiting for React initialization (3 seconds)...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Step 2: Click "Connect" button to initialize agent
    console.log('🔧 Step 2: Clicking "Connect" button to initialize agent...');
    const connectButtonClicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const connectButton = buttons.find(btn =>
        btn.textContent.includes('Connect') &&
        !btn.textContent.includes('Connect to')
      );

      if (connectButton) {
        connectButton.click();
        return true;
      }
      return false;
    });

    if (connectButtonClicked) {
      console.log('✅ Connect button clicked\n');

      // Wait for agent initialization
      console.log('⏳ Waiting for agent initialization (10 seconds)...');
      await new Promise(resolve => setTimeout(resolve, 10000));
      console.log('');
    } else {
      console.log('⚠️  Connect button not found - agent may already be initialized\n');
    }

    // Step 3: Navigate to connections page
    console.log('🔗 Step 3: Navigating to connections page...');
    await page.goto('http://91.99.4.54:3001/connections', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    console.log('✅ Connections page loaded\n');

    // Wait for page to settle
    console.log('⏳ Waiting for page to settle (2 seconds)...');
    await new Promise(resolve => setTimeout(resolve, 2000));
    console.log('');

    // ====================================================================
    // TEST 1: Check if agent is initialized
    // ====================================================================
    console.log('🔍 Test 1: Checking agent initialization...');

    const agentInfo = await page.evaluate(() => {
      // Access global agent variable (set by wallet initialization)
      if (typeof agent !== 'undefined' && agent) {
        return {
          exists: true,
          type: agent.constructor?.name || 'Unknown',
          hasMediator: !!agent.currentMediatorDID,
          mediatorDID: agent.currentMediatorDID ? agent.currentMediatorDID.toString() : null
        };
      }
      return { exists: false };
    });

    if (agentInfo.exists) {
      console.log(`✅ Agent initialized (type: ${agentInfo.type})\n`);
      testsPassed++;
    } else {
      console.log('❌ Agent NOT initialized - this is why button does nothing!\n');
      console.log('  📋 Solution: User must initialize wallet first:');
      console.log('     1. Go to wallet home page');
      console.log('     2. Click "Connect" button');
      console.log('     3. Wait for agent to start');
      console.log('     4. Return to connections page\n');
      testsFailed++;
    }

    // ====================================================================
    // TEST 2: Check mediator configuration
    // ====================================================================
    console.log('🔍 Test 2: Checking mediator configuration...');

    if (!agentInfo.exists) {
      console.log('⏭️  Skipped (agent not initialized)\n');
    } else if (agentInfo.hasMediator) {
      console.log(`✅ Mediator configured:`);
      console.log(`   ${agentInfo.mediatorDID}\n`);
      testsPassed++;
    } else {
      console.log('❌ Mediator NOT configured - button will fail when clicked!\n');
      console.log('  📋 Solution: User must connect to mediator:');
      console.log('     1. Go to wallet home page');
      console.log('     2. Click "Connect" button');
      console.log('     3. Wait for "Connected to mediator" message');
      console.log('     4. Return to connections page\n');
      testsFailed++;
    }

    // ====================================================================
    // TEST 3: Check for proactive mediator warning (NEW FIX)
    // ====================================================================
    console.log('🔍 Test 3: Checking for proactive mediator warning...');

    const warningBoxInfo = await page.evaluate(() => {
      // Look for orange warning box about mediator
      const orangeBoxes = document.querySelectorAll('[class*="bg-orange"]');

      for (const box of orangeBoxes) {
        const text = box.textContent;
        if (text.includes('Mediator Required') || text.includes('mediator')) {
          return {
            found: true,
            text: text.substring(0, 500)
          };
        }
      }
      return { found: false };
    });

    if (warningBoxInfo.found && agentInfo.exists && !agentInfo.hasMediator) {
      console.log('✅ Proactive warning displayed correctly');
      console.log('   Warning message:', warningBoxInfo.text.substring(0, 150) + '...');
      console.log('   This is the NEW FIX - users now see clear guidance!\n');
      testsPassed++;
    } else if (!agentInfo.exists) {
      console.log('⏭️  Skipped (agent not initialized)\n');
    } else if (agentInfo.hasMediator) {
      console.log('✅ No warning needed (mediator already configured)\n');
      testsPassed++;
    } else if (!warningBoxInfo.found) {
      console.log('❌ Warning box NOT found - fix may not be working');
      console.log('   Expected: Orange box with "Mediator Required" message\n');
      testsFailed++;
    }

    // ====================================================================
    // TEST 4: Check if button exists and is enabled
    // ====================================================================
    console.log('🔍 Test 4: Checking "Connect to CA" button...');

    const buttonInfo = await page.evaluate(() => {
      // Find button by text content
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
        classes: connectButton.className,
        text: connectButton.textContent.trim()
      };
    });

    if (!buttonInfo.exists) {
      console.log('❌ "Connect to CA" button not found on page!\n');
      testsFailed++;
    } else if (buttonInfo.disabled) {
      console.log(`❌ Button is DISABLED`);
      console.log(`   Text: "${buttonInfo.text}"`);
      console.log(`   This confirms agent not initialized\n`);
      testsFailed++;
    } else {
      console.log(`✅ Button exists and is ENABLED`);
      console.log(`   Text: "${buttonInfo.text}"\n`);
      testsPassed++;
    }

    // ====================================================================
    // TEST 5: Click the button and monitor console
    // ====================================================================
    if (buttonInfo.exists && !buttonInfo.disabled) {
      console.log('🔍 Test 5: Clicking "Connect to CA" button...');

      // Clear previous console messages
      const preClickMessageCount = consoleMessages.length;

      // Click the button
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const connectButton = buttons.find(btn =>
          btn.textContent.includes('Connect to CA')
        );
        if (connectButton) {
          connectButton.click();
        }
      });

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Check if error box appeared after clicking
      console.log('🔍 Checking for error box in UI...');
      const errorBoxInfo = await page.evaluate(() => {
        // Look for error box (red background)
        const errorBoxes = document.querySelectorAll('[class*="bg-red"], [class*="text-red"]');
        if (errorBoxes.length > 0) {
          const errorTexts = Array.from(errorBoxes).map(box => box.textContent.trim());
          return {
            found: true,
            count: errorBoxes.length,
            messages: errorTexts
          };
        }
        return { found: false };
      });

      if (errorBoxInfo.found) {
        console.log(`✅ Error box displayed to user (${errorBoxInfo.count} elements)`);
        errorBoxInfo.messages.forEach((msg, i) => {
          console.log(`   Error ${i + 1}: ${msg.substring(0, 200)}`);
        });
        console.log('');
      } else {
        console.log('❌ No error box visible - this explains "nothing happens"!');
        console.log('   The error may be thrown but not displayed to the user\n');
      }

      // Analyze console messages after click
      const postClickMessages = consoleMessages.slice(preClickMessageCount);

      console.log(`\n  📊 Captured ${postClickMessages.length} console messages after click\n`);

      if (postClickMessages.length === 0) {
        console.log('❌ No console output after clicking - button handler may not be firing\n');
        testsFailed++;
      } else {
        // Check for specific log patterns
        const hasCheckingMediator = postClickMessages.some(m =>
          m.text.includes('Checking mediator configuration')
        );
        const hasNoMediator = postClickMessages.some(m =>
          m.text.includes('No mediator configured')
        );
        const hasFetchingInvitation = postClickMessages.some(m =>
          m.text.includes('Fetching well-known invitation')
        );
        const hasSuccess = postClickMessages.some(m =>
          m.text.includes('Successfully connected to Certification Authority')
        );
        const hasError = postClickMessages.some(m =>
          m.type === 'error' || m.text.includes('[CA CONNECT] Failed')
        );

        console.log('  📋 Console Log Analysis:');
        console.log(`     Mediator check initiated: ${hasCheckingMediator ? '✅' : '❌'}`);
        console.log(`     Mediator missing error: ${hasNoMediator ? '✅ (expected if no mediator)' : '✅ (no error)'}`);
        console.log(`     Fetching CA invitation: ${hasFetchingInvitation ? '✅' : '❌'}`);
        console.log(`     Success message: ${hasSuccess ? '✅' : '❌'}`);
        console.log(`     Errors detected: ${hasError ? '⚠️  YES' : '✅ NO'}`);
        console.log('');

        if (hasSuccess) {
          console.log('✅ Button works correctly - connection successful!\n');
          testsPassed++;
        } else if (hasNoMediator) {
          console.log('❌ Button clicked but failed: Missing mediator configuration\n');
          testsFailed++;
        } else if (hasError) {
          console.log('❌ Button clicked but encountered an error\n');
          testsFailed++;
        } else {
          console.log('⚠️  Button clicked but outcome unclear - see logs below\n');
        }

        // Print full console log
        console.log('  📋 Full Console Output:');
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
      console.log('⏭️  Test 5: Skipped (button disabled or not found)\n');
    }

    // ====================================================================
    // TEST 6: Check for error messages on page
    // ====================================================================
    console.log('🔍 Test 6: Checking for visible error messages...');

    const errorMessages = await page.evaluate(() => {
      // Find error boxes (typically red or yellow background)
      const errorBoxes = document.querySelectorAll('.bg-red-50, .bg-yellow-50, .bg-orange-50');
      return Array.from(errorBoxes).map(box => ({
        type: box.className.includes('red') ? 'error' : 'warning',
        text: box.textContent.trim().substring(0, 200)
      }));
    });

    if (errorMessages.length > 0) {
      console.log(`⚠️  Found ${errorMessages.length} error/warning messages on page:`);
      errorMessages.forEach((msg, i) => {
        console.log(`\n  ${i + 1}. [${msg.type}] ${msg.text}`);
      });
      console.log('');
    } else {
      console.log('✅ No error messages visible on page\n');
    }

    // ====================================================================
    // SUMMARY & DIAGNOSIS
    // ====================================================================
    console.log('=' .repeat(70));
    console.log('DIAGNOSTIC SUMMARY');
    console.log('=' .repeat(70));
    console.log(`✅ Tests Passed: ${testsPassed}`);
    console.log(`❌ Tests Failed: ${testsFailed}`);
    console.log('=' .repeat(70));
    console.log('');

    console.log('🔬 ROOT CAUSE DIAGNOSIS:');
    console.log('');

    if (!agentInfo.exists) {
      console.log('❌ PRIMARY ISSUE: Wallet agent not initialized');
      console.log('   - Button is disabled (grayed out)');
      console.log('   - User cannot click it');
      console.log('   - No console logs appear when attempting to click');
      console.log('');
      console.log('💡 SOLUTION:');
      console.log('   1. User must go to wallet home page');
      console.log('   2. Click the "Connect" button');
      console.log('   3. Wait for "Agent started" message in console');
      console.log('   4. Return to connections page and try again');
    } else if (!agentInfo.hasMediator) {
      console.log('❌ PRIMARY ISSUE: Mediator not configured');
      console.log('   - Agent is initialized');
      console.log('   - Button is enabled (clickable)');
      console.log('   - But clicking fails with "No mediator configured" error');
      console.log('');
      console.log('💡 SOLUTION:');
      console.log('   1. User must complete mediator registration');
      console.log('   2. On home page, click "Connect" and wait');
      console.log('   3. Look for "Connected to mediator" confirmation');
      console.log('   4. Then "Connect to CA" will work');
    } else {
      console.log('✅ NO ISSUES DETECTED');
      console.log('   - Agent is initialized');
      console.log('   - Mediator is configured');
      console.log('   - Button should work correctly');
      console.log('');
      if (testsFailed > 0) {
        console.log('⚠️  But test failures detected - check console logs above');
      }
    }

    console.log('');
    console.log('=' .repeat(70));

    // Take screenshot
    await page.screenshot({
      path: '/tmp/connect-ca-test-screenshot.png',
      fullPage: true
    });
    console.log('📸 Screenshot saved: /tmp/connect-ca-test-screenshot.png');
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
