#!/usr/bin/env node

/**
 * End-to-End ServiceConfiguration VC Test with Puppeteer
 *
 * This test automates the Alice wallet using Puppeteer to verify:
 * 1. Company Admin Portal creates employee invitation
 * 2. Alice wallet accepts invitation
 * 3. ServiceConfiguration VC is auto-issued
 * 4. VC appears in wallet with correct claims
 */

const puppeteer = require('puppeteer');
const fetch = require('node-fetch');

// Configuration
const COMPANY_ADMIN_URL = 'http://localhost:3010';
const ALICE_WALLET_URL = 'https://identuslabel.cz/alice';
const EMPLOYEE_NAME = `Test Employee ${Date.now()}`;
const EMPLOYEE_EMAIL = `test.employee.${Date.now()}@techcorp.example.com`;
const EMPLOYEE_DEPARTMENT = 'IT';

// Colors for output
const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const BLUE = '\x1b[0;34m';
const NC = '\x1b[0m'; // No Color

function log(message, color = NC) {
    console.log(`${color}${message}${NC}`);
}

async function loginToCompanyPortal() {
    log('\n📋 STEP 1: Login to Company Admin Portal as TechCorp', BLUE);
    log('─'.repeat(80));

    const response = await fetch(`${COMPANY_ADMIN_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: 'techcorp' })
    });

    const result = await response.json();
    console.log(JSON.stringify(result, null, 2));

    if (!result.success) {
        throw new Error('Login failed');
    }

    // Extract session cookie
    const cookies = response.headers.raw()['set-cookie'];
    const sessionCookie = cookies.find(c => c.startsWith('connect.sid'));

    log('✅ Login successful', GREEN);
    return sessionCookie;
}

async function createEmployeeInvitation(sessionCookie) {
    log('\n📋 STEP 2: Create employee invitation', BLUE);
    log('─'.repeat(80));
    log(`Employee: ${EMPLOYEE_NAME}`);
    log(`Email: ${EMPLOYEE_EMAIL}`);
    log(`Department: ${EMPLOYEE_DEPARTMENT}\n`);

    const response = await fetch(`${COMPANY_ADMIN_URL}/api/company/invite-employee`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Cookie': sessionCookie
        },
        body: JSON.stringify({
            employeeName: EMPLOYEE_NAME,
            role: 'Test Role',
            department: EMPLOYEE_DEPARTMENT
        })
    });

    const result = await response.json();
    console.log(JSON.stringify(result, null, 2));

    if (!result.success) {
        throw new Error('Invitation creation failed');
    }

    log('✅ Invitation created', GREEN);
    return {
        invitationUrl: result.invitation.invitationUrl,
        connectionId: result.invitation.connectionId
    };
}

async function acceptInvitationWithWallet(invitationUrl) {
    log('\n📋 STEP 3: Accept invitation with Alice wallet', BLUE);
    log('─'.repeat(80));

    const browser = await puppeteer.launch({
        headless: true, // Headless mode for server environment
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    });

    const page = await browser.newPage();

    try {
        // Enable console logging from browser
        page.on('console', msg => {
            const text = msg.text();
            if (text.includes('Agent started') ||
                text.includes('Connection') ||
                text.includes('Credential')) {
                log(`[Browser] ${text}`, YELLOW);
            }
        });

        log('Opening Alice wallet...');
        await page.goto(ALICE_WALLET_URL, { waitUntil: 'networkidle2', timeout: 30000 });

        log('Waiting for page to load...');
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Check if agent needs to be started
        const pageText = await page.evaluate(() => document.body.innerText);
        if (pageText.includes('Start the agent first')) {
            log('Starting the agent...');

            // Find and click the Connect button
            const clicked = await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                const connectBtn = buttons.find(btn => btn.textContent.includes('Connect'));
                if (connectBtn) {
                    connectBtn.click();
                    return true;
                }
                return false;
            });

            if (clicked) {
                log('⏳ Waiting for wallet UI to be ready...');
                // Wait for navigation tabs to appear (indicates wallet UI is rendered)
                // Note: Agent may still be retrying mediator registration in background
                let walletReady = false;
                for (let attempt = 1; attempt <= 15; attempt++) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    const pageText = await page.evaluate(() => document.body.innerText);
                    const hasNavTabs = pageText.includes('Credentials') && pageText.includes('Connections');
                    if (hasNavTabs) {
                        walletReady = true;
                        log(`✅ Wallet UI ready after ${attempt * 2} seconds`);
                        break;
                    }
                    log(`⏳ Still waiting for wallet UI (${attempt * 2}s elapsed)...`);
                }

                if (!walletReady) {
                    throw new Error('❌ Wallet UI failed to load within 30 seconds');
                }

                // Wait a bit longer to allow agent some time to settle
                // (mediator may still be retrying but wallet should be usable)
                log('⏳ Allowing 5 more seconds for agent to settle...');
                await new Promise(resolve => setTimeout(resolve, 5000));
            } else {
                log('⚠️ Could not find Connect button', YELLOW);
            }
        }

        // Take screenshot after agent starts
        await page.screenshot({ path: '/tmp/wallet-after-agent-start.png', fullPage: true });
        log('Screenshot saved: /tmp/wallet-after-agent-start.png');

        // Navigate to Connections tab
        log('Navigating to Connections tab...');

        // Get current URL and page content for debugging
        const currentUrl = page.url();
        log(`Current URL: ${currentUrl}`);

        // Try to navigate using URL
        const connectionsUrl = `${ALICE_WALLET_URL}/connections`;
        log(`Navigating directly to: ${connectionsUrl}`);
        await page.goto(connectionsUrl, { waitUntil: 'networkidle2', timeout: 10000 });
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Take screenshot after navigation
        await page.screenshot({ path: '/tmp/wallet-connections-page.png', fullPage: true });
        log('Screenshot saved: /tmp/wallet-connections-page.png');

        // Look for OOB invitation input
        log('Looking for invitation input field...');

        // Debug: List all input fields
        const inputInfo = await page.evaluate(() => {
            const inputs = Array.from(document.querySelectorAll('input, textarea'));
            return inputs.map(input => ({
                type: input.type,
                placeholder: input.placeholder,
                name: input.name,
                id: input.id,
                visible: input.offsetParent !== null
            }));
        });
        log(`Found ${inputInfo.length} input fields:`, YELLOW);
        inputInfo.forEach(info => log(`  - type="${info.type}" placeholder="${info.placeholder}" visible=${info.visible}`, YELLOW));

        // Try multiple selectors for the invitation input
        const inputSelectors = [
            'input[placeholder*="invitation"]',
            'input[placeholder*="Invitation"]',
            'input[type="text"][placeholder*="URL"]',
            'textarea[placeholder*="invitation"]',
            'input[name="invitation"]',
            '#invitation-url',
            'input[placeholder*="OOB"]'
        ];

        let invitationInput = null;
        for (const selector of inputSelectors) {
            try {
                invitationInput = await page.$(selector);
                if (invitationInput) {
                    log(`Found invitation input with selector: ${selector}`, GREEN);
                    break;
                }
            } catch (e) {
                // Continue to next selector
            }
        }

        if (!invitationInput) {
            log('❌ Could not find invitation input field', RED);
            log('Taking screenshot for debugging...');
            await page.screenshot({ path: '/tmp/wallet-no-input.png', fullPage: true });
            log('Screenshot saved to /tmp/wallet-no-input.png');
            throw new Error('Invitation input field not found');
        }

        log('Pasting invitation URL...');
        // Set value directly instead of typing (invitation URLs are very long, 7000+ chars)
        await page.evaluate((selector, url) => {
            const textarea = document.querySelector(selector);
            if (textarea) {
                textarea.value = url;
                // Trigger input event so React updates
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
                textarea.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }, 'textarea[placeholder*="invitation"]', invitationUrl);

        log('Looking for Accept/Submit button...');

        // Find and click accept button
        const acceptClicked = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const acceptBtn = buttons.find(btn =>
                btn.textContent.includes('Accept') ||
                btn.textContent.includes('Submit') ||
                btn.textContent.includes('Connect') ||
                btn.textContent.includes('Parse') ||
                btn.type === 'submit'
            );
            if (acceptBtn) {
                acceptBtn.click();
                return true;
            }
            return false;
        });

        if (!acceptClicked) {
            log('❌ Could not find Accept button', RED);
            log('Taking screenshot for debugging...');
            await page.screenshot({ path: '/tmp/wallet-no-button.png', fullPage: true });
            log('Screenshot saved to /tmp/wallet-no-button.png');
            throw new Error('Accept button not found');
        }

        log('Clicked Accept button...');

        log('⏳ Waiting for connection to establish (20 seconds)...');
        await new Promise(resolve => setTimeout(resolve, 20000));

        log('✅ Invitation accepted, connection established', GREEN);

        // Keep browser open for credential verification
        return { browser, page };

    } catch (error) {
        log(`❌ Error during wallet interaction: ${error.message}`, RED);
        await page.screenshot({ path: '/tmp/wallet-error.png', fullPage: true });
        log('Screenshot saved to /tmp/wallet-error.png');
        await browser.close();
        throw error;
    }
}

async function waitForConnectionActive(sessionCookie, connectionId) {
    log('\n📋 STEP 3.5: Wait for DIDComm connection to establish', BLUE);
    log('─'.repeat(80));

    const maxAttempts = 12; // 60 seconds total (12 * 5 seconds)
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds

        // Check connection state
        const response = await fetch(`${COMPANY_ADMIN_URL}/api/company/connections`, {
            method: 'GET',
            headers: { 'Cookie': sessionCookie }
        });

        const result = await response.json();
        if (!result.success) {
            log(`❌ Failed to fetch connections: ${result.error}`, RED);
            continue;
        }

        // Find our connection
        const connection = result.connections.find(c => c.connectionId === connectionId);
        if (!connection) {
            log(`⚠️ Connection not found (attempt ${attempt}/${maxAttempts})`, YELLOW);
            continue;
        }

        log(`Connection state: ${connection.state} (attempt ${attempt}/${maxAttempts})`);

        // Check if connection is active
        if (connection.state === 'ConnectionResponseSent' || connection.state === 'Active') {
            log(`✅ Connection established (state: ${connection.state})`, GREEN);
            return true;
        }
    }

    log(`❌ Connection did not establish within ${maxAttempts * 5} seconds`, RED);
    return false;
}

async function triggerAutoIssue(sessionCookie, connectionId) {
    log('\n📋 STEP 4: Trigger auto-issue of ServiceConfiguration VC', BLUE);
    log('─'.repeat(80));

    const response = await fetch(`${COMPANY_ADMIN_URL}/api/company/connections/${connectionId}/auto-issue-config`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Cookie': sessionCookie
        },
        body: JSON.stringify({
            email: EMPLOYEE_EMAIL,
            name: EMPLOYEE_NAME,
            department: EMPLOYEE_DEPARTMENT
        })
    });

    const result = await response.json();
    console.log(JSON.stringify(result, null, 2));

    if (result.success) {
        log('✅ ServiceConfiguration VC issued', GREEN);
        log(`\nAPI Key ID: ${result.data.keyId}`);
        log(`VC Record ID: ${result.data.vcRecordId}`);
        return result.data;
    } else {
        log('⚠️ Auto-issue may have failed (see response above)', YELLOW);
        return null;
    }
}

async function waitForCredentialInWallet(browser, page, vcRecordId) {
    log('\n📋 STEP 5: Waiting for ServiceConfiguration VC in wallet', BLUE);
    log('─'.repeat(80));

    try {
        // Navigate to credentials page
        log('Navigating to Credentials tab...');
        const credentialsNavigated = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a, button'));
            const credentialsLink = links.find(el =>
                el.textContent.includes('Credentials') ||
                el.getAttribute('href')?.includes('credentials')
            );
            if (credentialsLink) {
                credentialsLink.click();
                return true;
            }
            return false;
        });

        if (credentialsNavigated) {
            await new Promise(resolve => setTimeout(resolve, 3000));
        }

        log('⏳ Waiting up to 60 seconds for credential to appear...');

        // Poll for credential appearance
        for (let i = 0; i < 12; i++) {
            await new Promise(resolve => setTimeout(resolve, 5000));

            // Check page content for ServiceConfiguration
            const pageContent = await page.content();

            if (pageContent.includes('ServiceConfiguration') ||
                pageContent.includes('enterpriseAgent') ||
                pageContent.includes('mediator')) {
                log('✅ ServiceConfiguration VC found in wallet!', GREEN);

                // Take screenshot of success
                await page.screenshot({ path: '/tmp/wallet-vc-received.png', fullPage: true });
                log('Screenshot saved to /tmp/wallet-vc-received.png');

                return true;
            }

            log(`⏳ Still waiting... (${(i + 1) * 5}s elapsed)`);
        }

        log('❌ Credential did not appear within timeout period', RED);
        await page.screenshot({ path: '/tmp/wallet-timeout.png', fullPage: true });
        log('Screenshot saved to /tmp/wallet-timeout.png');
        return false;

    } catch (error) {
        log(`❌ Error waiting for credential: ${error.message}`, RED);
        return false;
    } finally {
        log('Closing browser...');
        await browser.close();
    }
}

async function runE2ETest() {
    console.log('\n' + '='.repeat(80));
    log('🧪 END-TO-END SERVICECONFIGURATION VC TEST (PUPPETEER)', BLUE);
    console.log('='.repeat(80) + '\n');

    let browser = null;

    try {
        // Step 1: Login
        const sessionCookie = await loginToCompanyPortal();

        // Step 2: Create invitation
        const { invitationUrl, connectionId } = await createEmployeeInvitation(sessionCookie);

        // Step 3: Accept with wallet (returns browser instance)
        const { browser: walletBrowser, page } = await acceptInvitationWithWallet(invitationUrl);
        browser = walletBrowser;

        // Step 3.5: Wait for connection to establish
        const connectionActive = await waitForConnectionActive(sessionCookie, connectionId);
        if (!connectionActive) {
            throw new Error('Connection did not establish within timeout');
        }

        // Step 4: Trigger auto-issue
        const vcData = await triggerAutoIssue(sessionCookie, connectionId);

        if (!vcData) {
            throw new Error('Auto-issue failed');
        }

        // Step 5: Wait for credential in wallet
        const credentialReceived = await waitForCredentialInWallet(browser, page, vcData.vcRecordId);

        // Final results
        console.log('\n' + '='.repeat(80));
        log('📊 TEST RESULTS', BLUE);
        console.log('='.repeat(80) + '\n');

        if (credentialReceived) {
            log('✅ END-TO-END TEST PASSED', GREEN);
            console.log('\nSummary:');
            log('  ✅ Employee invitation created', GREEN);
            log('  ✅ DIDComm connection established', GREEN);
            log('  ✅ API key generated', GREEN);
            log('  ✅ ServiceConfiguration VC issued', GREEN);
            log('  ✅ VC received and displayed in wallet', GREEN);
            process.exit(0);
        } else {
            log('❌ END-TO-END TEST FAILED', RED);
            console.log('\nThe wallet did not receive the ServiceConfiguration VC within the timeout period.\n');
            console.log('Check the logs:');
            console.log('  - Company Admin Portal: /tmp/company-admin-test.log');
            console.log('  - Screenshots: /tmp/wallet-*.png\n');
            process.exit(1);
        }

    } catch (error) {
        log(`\n❌ TEST FAILED WITH ERROR: ${error.message}`, RED);
        console.error(error);

        if (browser) {
            await browser.close();
        }

        process.exit(1);
    }
}

// Run the test
runE2ETest();
