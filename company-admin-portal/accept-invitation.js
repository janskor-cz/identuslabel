#!/usr/bin/env node

const puppeteer = require('puppeteer');

const ALICE_WALLET_URL = 'https://identuslabel.cz/alice';
const INVITATION_URL = 'https://my.domain.com/path?_oob=eyJpZCI6ImIxMDVhOTg3LWY5YzgtNDk1MS05MDgyLWViNGE3ZjUzODhhOCIsInR5cGUiOiJodHRwczovL2RpZGNvbW0ub3JnL291dC1vZi1iYW5kLzIuMC9pbnZpdGF0aW9uIiwiZnJvbSI6ImRpZDpwZWVyOjIuRXo2TFNlNnZGR1dkd0Q3RExES3BYbjF4WUY4U0VleHpDTjdreFp2NHRQTEM1OTNIcy5WejZNa3VuYUE5VVA1OWh5dVFHUWZmNHMzR0R3Q1BLa1F5c3lGNERjZmNoWTIyTFpOLlNleUowSWpvaVpHMGlMQ0p6SWpwN0luVnlhU0k2SW1oMGRIQnpPaTh2YVdSbGJuUjFjMnhoWW1Wc0xtTjZMM1JsWTJoamIzSndMMlJwWkdOdmJXMGlMQ0p5SWpwYlhTd2lZU0k2V3lKa2FXUmpiMjF0TDNZeUlsMTlmUSIsImJvZHkiOnsiZ29hbCI6IkNvbm5lY3QgYXMgVGVjaENvcnAgQ29ycG9yYXRpb24gZW1wbG95ZWUiLCJhY2NlcHQiOltdLCJnb2FsX2NvZGUiOiJjb21wYW55LWVtcGxveWVlLXZlcmlmaWNhdGlvbiJ9LCJyZXF1ZXN0c19hdHRhY2giOlt7IkBpZCI6ImNvbXBhbnktaWRlbnRpdHktY3JlZGVudGlhbCIsIm1pbWUtdHlwZSI6ImFwcGxpY2F0aW9uL2pzb24iLCJkYXRhIjp7Impzb24iOnsiY3JlZGVudGlhbCI6ImV5SjBlWEFpT2lKS1YxUWlMQ0poYkdjaU9pSkZVekkxTmtzaWZRLmV5SnBjM01pT2lKa2FXUTZjSEpwYzIwNk4yWmlNR1JoTnpFMVpXVmtNVFExTVdGak5EUXlZMkl6WmpobVltWTNNMkV3T0RSbU9HWTNNMkZtTVRZMU1qRTRNVEpsWkdReU1tUXlOMlE0WmpreFl5SXNJbk4xWWlJNkltUnBaRHB3Y21semJUbzJaV1UzTlRkak1qa3hNMkUzTm1GaE5HVmlNbVl3T1dVNVkyUXpZMk0wTUdWaFpEY3pZMlpoWm1aak4yUTNNVEpqTXpBelpXVTFZbU16T0dZeU1XSm1Pa052TkVORGIzTkRSV28wUzBOdFJqRmtSMmQwWVRKV05VeFVSVkZDUlc5MVEyZHNlbHBYVG5kTmFsVXlZWHBGVTBsUlQzUmthelEzWjJ0MFNVSjJkMUJyUVZsUmRWUmtlVlZJV1VsQk1FNVhjemx0V1d0dloyeEpOWGxJZDFKS1JFTm5PV2hqTTA1c1kyNVNjR0l5TkhSaE1sWTFURlJGVVVGcmIzVkRaMng2V2xkT2QwMXFWVEpoZWtWVFNWRk1jR3RQWkhaQ1FtUklhMHRJTUZWU1NrUXdiR0ZtV0ZkVmRFMW5WbTltY2sxNGVVa3hhbkpTY2tscGFFazNRMmRrZEZsWVRqQmFXRWwzUlVGR1MweG5iMHBqTWxacVkwUkpNVTV0YzNoRmFVVkRRVlZFVFhvNVVsSndRVFY1YlRsc1VGZEhORGxQZEVWUWRYbHdVazlIWVZOMFpsSm9TRTlvT0ZOYVkyRlNkMjlRV1RJNWRHTkhSblZsVXpFeldsZEtlbUZZVW14RmFFWmlTV3Q0Y0dKdGRHeGFSVkoyWWxkR2NHSnVUV2xZVW05b1YzbEtiMlJJVW5kamVtOTJURE5TYkZreWFHcGlNMHAzVEcxV05GbFhNWGRpUjFWMVdUSTVkRXg1U21RaUxDSnVZbVlpT2pFM05qSTJOREl5T1RJc0luWmpJanA3SW1OeVpXUmxiblJwWVd4VFkyaGxiV0VpT2x0N0ltbGtJam9pYUhSMGNEcGNMMXd2T1RFdU9Ua3VOQzQxTkRvNE1EQXdYQzlqYkc5MVpDMWhaMlZ1ZEZ3dmMyTm9aVzFoTFhKbFoybHpkSEo1WEM5elkyaGxiV0Z6WEM5bE5qUmpaRGxsWWkwMllUUmxMVE5oTW1RdE9ERmlNeTFqTnpjME1URmtObVppWkdJaUxDSjBlWEJsSWpvaVEzSmxaR1Z1ZEdsaGJGTmphR1Z0WVRJd01qSWlmVjBzSW1OeVpXUmxiblJwWVd4VGRXSnFaV04wSWpwN0ltMTFiSFJwZEdWdVlXNWplVmRoYkd4bGRFbGtJam9pTkRCbE0yUmlOVGt0WVdaallpMDBObVkzTFdGbE16a3RORGMwTVRkaFpEZzVOR1E1SWl3aWFYTnpkV1ZrUkdGMFpTSTZJakl3TWpVdE1URXRNRGdpTENKM1pXSnphWFJsSWpvaWFIUjBjSE02WEM5Y0wzUmxZMmhqYjNKd0xtVjRZVzF3YkdVdVkyOXRJaXdpWlhOMFlXSnNhWE5vWldSRVlYUmxJam9pTWpBeU5DMHdNUzB4TlNJc0ltcDFjbWx6WkdsamRHbHZiaUk2SWtSbGJHRjNZWEpsTENCVlUwRWlMQ0pqYjIxd1lXNTVUbUZ0WlNJNklsUmxZMmhEYjNKd0lFTnZjbkJ2Y21GMGFXOXVJaXdpYVc1a2RYTjBjbmtpT2lKVVpXTm9ibTlzYjJkNUlDWWdTVzV1YjNaaGRHbHZiaUlzSW1WNGNHbHllVVJoZEdVaU9pSXlNREkyTFRFeExUQTRJaXdpWTNKbFpHVnVkR2xoYkZSNWNHVWlPaUpEYjIxd1lXNTVTV1JsYm5ScGRIa2lMQ0poZFhSb2IzSnBlbVZrVkc5SmMzTjFaVU55WldSbGJuUnBZV3h6SWpwMGNuVmxMQ0p5WldkcGMzUnlZWFJwYjI1T2RXMWlaWElpT2lKVVF5MHlNREkwTFRBd01TSXNJbU55WldSbGJuUnBZV3hKWkNJNkluUmxZMmhqYjNKd0xXTnZiWEJoYm5rdGFXUmxiblJwZEhrdE1EQXhJaXdpYVdRaU9pSmthV1E2Y0hKcGMyMDZObVZsTnpVM1l6STVNVE5oTnpaaFlUUmxZakptTURsbE9XTmtNMk5qTkRCbFlXUTNNMk5tWVdabVl6ZGtOekV5WXpNd00yVmxOV0pqTXpobU1qRmlaanBEYnpSRFEyOXpRMFZxTkV0RGJVWXhaRWRuZEdFeVZqVk1WRVZSUWtWdmRVTm5iSHBhVjA1M1RXcFZNbUY2UlZOSlVVOTBaR3MwTjJkcmRFbENkbmRRYTBGWlVYVlVaSGxWU0ZsSlFUQk9WM001YlZscmIyZHNTVFY1U0hkU1NrUkRaemxvWXpOT2JHTnVVbkJpTWpSMFlUSldOVXhVUlZGQmEyOTFRMmRzZWxwWFRuZE5hbFV5WVhwRlUwbFJUSEJyVDJSMlFrSmtTR3RMU0RCVlVrcEVNR3hoWmxoWFZYUk5aMVp2Wm5KTmVIbEpNV3B5VW5KSmFXaEpOME5uWkhSWldFNHdXbGhKZDBWQlJrdE1aMjlLWXpKV2FtTkVTVEZPYlhONFJXbEZRMEZWUkUxNk9WSlNjRUUxZVcwNWJGQlhSelE1VDNSRlVIVjVjRkpQUjJGVGRHWlNhRWhQYURoVFdtTmhVbmR2VUZreU9YUmpSMFoxWlZNeE0xcFhTbnBoV0ZKc1JXaEdZa2xyZUhCaWJYUnNXa1ZTZG1KWFJuQmliazFwV0ZKdmFGZDVTbTlrU0ZKM1kzcHZka3d6VW14Wk1taHFZak5LZDB4dFZqUlpWekYzWWtkVmRWa3lPWFJNZVVwa0lpd2lZMjl0Y0dGdWVVUnBjM0JzWVhsT1lXMWxJam9pVkdWamFFTnZjbkFpZlN3aWRIbHdaU0k2V3lKV1pYSnBabWxoWW14bFEzSmxaR1Z1ZEdsaGJDSmRMQ0pBWTI5dWRHVjRkQ0k2V3lKb2RIUndjenBjTDF3dmQzZDNMbmN6TG05eVoxd3ZNakF4T0Z3dlkzSmxaR1Z1ZEdsaGJITmNMM1l4SWwwc0ltbHpjM1ZsY2lJNmV5SnBaQ0k2SW1ScFpEcHdjbWx6YlRvM1ptSXdaR0UzTVRWbFpXUXhORFV4WVdNME5ESmpZak5tT0daaVpqY3pZVEE0TkdZNFpqY3pZV1l4TmpVeU1UZ3hNbVZrWkRJeVpESTNaRGhtT1RGaklpd2lkSGx3WlNJNklsQnliMlpwYkdVaWZTd2lZM0psWkdWdWRHbGhiRk4wWVhSMWN5STZleUp6ZEdGMGRYTlFkWEp3YjNObElqb2lVbVYyYjJOaGRHbHZiaUlzSW5OMFlYUjFjMHhwYzNSSmJtUmxlQ0k2TkRZc0ltbGtJam9pYUhSMGNITTZYQzljTDJsa1pXNTBkWE5zWVdKbGJDNWplbHd2WTJ4dmRXUXRZV2RsYm5SY0wyTnlaV1JsYm5ScFlXd3RjM1JoZEhWelhDODRaR0U1T1RRd1pDMHpObVV6TFRSbE5URXRZakkzT1Mxak5USmpNRFEwT1dWaVlqTWpORFlpTENKMGVYQmxJam9pVTNSaGRIVnpUR2x6ZERJd01qRkZiblJ5ZVNJc0luTjBZWFIxYzB4cGMzUkRjbVZrWlc1MGFXRnNJam9pYUhSMGNITTZYQzljTDJsa1pXNTBkWE5zWVdKbGJDNWplbHd2WTJ4dmRXUXRZV2RsYm5SY0wyTnlaV1JsYm5ScFlXd3RjM1JoZEhWelhDODRaR0U1T1RRd1pDMHpObVV6TFRSbE5URXRZakkzT1Mxak5USmpNRFEwT1dWaVlqTWlmWDE5LmhSeUxaU1Jmb09YMm10VHdocWhyTk55MThUaHVkUkEzVVpaa0FRME1KSm5QX2lnUXMxallWMnFjbm1vdmdVMllRTW50VFhKU1pMcGxfcWZId2pZYWRRIiwiY2xhaW1zIjp7Im11bHRpdGVuYW5jeVdhbGxldElkIjoiNDBlM2RiNTktYWZjYi00NmY3LWFlMzktNDc0MTdhZDg5NGQ5IiwiaXNzdWVkRGF0ZSI6IjIwMjUtMTEtMDgiLCJ3ZWJzaXRlIjoiaHR0cHM6Ly90ZWNoY29ycC5leGFtcGxlLmNvbSIsImVzdGFibGlzaGVkRGF0ZSI6IjIwMjQtMDEtMTUiLCJqdXJpc2RpY3Rpb24iOiJEZWxhd2FyZSwgVVNBIiwiY29tcGFueU5hbWUiOiJUZWNoQ29ycCBDb3Jwb3JhdGlvbiIsImluZHVzdHJ5IjoiVGVjaG5vbG9neSAmIElubm92YXRpb24iLCJleHBpcnlEYXRlIjoiMjAyNi0xMS0wOCIsImNyZWRlbnRpYWxUeXBlIjoiQ29tcGFueUlkZW50aXR5IiwiYXV0aG9yaXplZFRvSXNzdWVDcmVkZW50aWFscyI6dHJ1ZSwicmVnaXN0cmF0aW9uTnVtYmVyIjoiVEMtMjAyNC0wMDEiLCJjcmVkZW50aWFsSWQiOiJ0ZWNoY29ycC1jb21wYW55LWlkZW50aXR5LTAwMSIsImlkIjoiZGlkOnByaXNtOjZlZTc1N2MyOTEzYTc2YWE0ZWIyZjA5ZTljZDNjYzQwZWFkNzNjZmFmZmM3ZDcxMmMzMDNlZTViYzM4ZjIxYmY6Q280Q0Nvc0NFajRLQ21GMWRHZ3RhMlY1TFRFUUJFb3VDZ2x6WldOd01qVTJhekVTSVFPdGRrNDdna3RJQnZ3UGtBWVF1VGR5VUhZSUEwTldzOW1Za29nbEk1eUh3UkpEQ2c5aGMzTmxjblJwYjI0dGEyVjVMVEVRQWtvdUNnbHpaV053TWpVMmF6RVNJUUxwa09kdkJCZEhrS0gwVVJKRDBsYWZYV1V0TWdWb2ZyTXh5STFqclJySWloSTdDZ2R0WVhOMFpYSXdFQUZLTGdvSmMyVmpjREkxTm1zeEVpRUNBVURNejlSUnBBNXltOWxQV0c0OU90RVB1eXBST0dhU3RmUmhIT2g4U1pjYVJ3b1BZMjl0Y0dGdWVTMTNaV0p6YVhSbEVoRmJJa3hwYm10bFpFUnZiV0ZwYm5NaVhSb2hXeUpvZEhSd2N6b3ZMM1JsWTJoamIzSndMbVY0WVcxd2JHVXVZMjl0THlKZCIsImNvbXBhbnlEaXNwbGF5TmFtZSI6IlRlY2hDb3JwIn0sImlzc3VlckRJRCI6ImRpZDpwcmlzbTo3ZmIwZGE3MTVlZWQxNDUxYWM0NDJjYjNmOGZiZjczYTA4NGY4ZjczYWYxNjUyMTgxMmVkZDIyZDI3ZDhmOTFjIiwiaG9sZGVyRElEIjoiZGlkOnByaXNtOjZlZTc1N2MyOTEzYTc2YWE0ZWIyZjA5ZTljZDNjYzQwZWFkNzNjZmFmZmM3ZDcxMmMzMDNlZTViYzM4ZjIxYmY6Q280Q0Nvc0NFajRLQ21GMWRHZ3RhMlY1TFRFUUJFb3VDZ2x6WldOd01qVTJhekVTSVFPdGRrNDdna3RJQnZ3UGtBWVF1VGR5VUhZSUEwTldzOW1Za29nbEk1eUh3UkpEQ2c5aGMzTmxjblJwYjI0dGEyVjVMVEVRQWtvdUNnbHpaV053TWpVMmF6RVNJUUxwa09kdkJCZEhrS0gwVVJKRDBsYWZYV1V0TWdWb2ZyTXh5STFqclJySWloSTdDZ2R0WVhOMFpYSXdFQUZLTGdvSmMyVmpjREkxTm1zeEVpRUNBVURNejlSUnBBNXltOWxQV0c0OU90RVB1eXBST0dhU3RmUmhIT2g4U1pjYVJ3b1BZMjl0Y0dGdWVTMTNaV0p6YVhSbEVoRmJJa3hwYm10bFpFUnZiV0ZwYm5NaVhSb2hXeUpvZEhSd2N6b3ZMM1JsWTJoamIzSndMbVY0WVcxd2JHVXVZMjl0THlKZCIsImNyZWRlbnRpYWxUeXBlIjoiQ29tcGFueUlkZW50aXR5In19fV19';

const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const BLUE = '\x1b[0;34m';
const YELLOW = '\x1b[1;33m';
const NC = '\x1b[0m';

function log(message, color = NC) {
    console.log(`${color}${message}${NC}`);
}

async function acceptInvitation() {
    log('\n🌐 Opening Chromium with Alice wallet...', BLUE);

    const browser = await puppeteer.launch({
        headless: true, // Headless mode (no X server available)
        executablePath: '/usr/bin/chromium-browser',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--start-maximized'
        ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    try {
        // Enable console logging from browser
        page.on('console', msg => {
            const text = msg.text();
            if (text.includes('Agent') || text.includes('Connection') || text.includes('Credential')) {
                log(`[Browser] ${text}`, YELLOW);
            }
        });

        log('📂 Navigating to Alice wallet...', BLUE);
        await page.goto(ALICE_WALLET_URL, { waitUntil: 'networkidle2', timeout: 30000 });

        log('⏳ Waiting for page to load...', BLUE);
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Check if agent needs to be started
        const pageText = await page.evaluate(() => document.body.innerText);
        if (pageText.includes('Start the agent first') || pageText.includes('Connect')) {
            log('🔌 Starting the agent...', BLUE);

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
                log('⏳ Waiting for wallet UI to be ready...', BLUE);
                let walletReady = false;
                for (let attempt = 1; attempt <= 20; attempt++) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    const pageText = await page.evaluate(() => document.body.innerText);
                    const hasNavTabs = pageText.includes('Credentials') && pageText.includes('Connections');
                    if (hasNavTabs) {
                        walletReady = true;
                        log(`✅ Wallet UI ready after ${attempt * 2} seconds`, GREEN);
                        break;
                    }
                    log(`⏳ Still waiting for wallet UI (${attempt * 2}s elapsed)...`);
                }

                if (!walletReady) {
                    throw new Error('❌ Wallet UI failed to load within 40 seconds');
                }

                log('⏳ Allowing 5 more seconds for agent to settle...', BLUE);
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }

        // Take screenshot
        await page.screenshot({ path: '/tmp/wallet-ready.png', fullPage: true });
        log('📸 Screenshot saved: /tmp/wallet-ready.png', GREEN);

        // Navigate to Connections tab
        log('\n🔗 Navigating to Connections tab...', BLUE);
        const connectionsUrl = `${ALICE_WALLET_URL}/connections`;
        await page.goto(connectionsUrl, { waitUntil: 'networkidle2', timeout: 10000 });
        await new Promise(resolve => setTimeout(resolve, 3000));

        await page.screenshot({ path: '/tmp/connections-page.png', fullPage: true });
        log('📸 Screenshot saved: /tmp/connections-page.png', GREEN);

        // Find invitation input
        log('\n📝 Looking for invitation input field...', BLUE);

        const inputSelectors = [
            'textarea[placeholder*="invitation"]',
            'textarea[placeholder*="Invitation"]',
            'input[placeholder*="invitation"]',
            'textarea[placeholder*="OOB"]'
        ];

        let invitationInput = null;
        for (const selector of inputSelectors) {
            try {
                invitationInput = await page.$(selector);
                if (invitationInput) {
                    log(`✅ Found invitation input with selector: ${selector}`, GREEN);
                    break;
                }
            } catch (e) {
                // Continue
            }
        }

        if (!invitationInput) {
            throw new Error('❌ Could not find invitation input field');
        }

        log('📋 Pasting invitation URL...', BLUE);
        await page.evaluate((url) => {
            const textarea = document.querySelector('textarea[placeholder*="invitation"]');
            if (textarea) {
                textarea.value = url;
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
                textarea.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }, INVITATION_URL);

        await new Promise(resolve => setTimeout(resolve, 1000));
        await page.screenshot({ path: '/tmp/invitation-pasted.png', fullPage: true });
        log('📸 Screenshot saved: /tmp/invitation-pasted.png', GREEN);

        log('\n🔍 Looking for Accept button...', BLUE);

        const acceptClicked = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const acceptBtn = buttons.find(btn =>
                btn.textContent.includes('Accept') ||
                btn.textContent.includes('Submit') ||
                btn.textContent.includes('Parse')
            );
            if (acceptBtn) {
                acceptBtn.click();
                return true;
            }
            return false;
        });

        if (!acceptClicked) {
            throw new Error('❌ Could not find Accept button');
        }

        log('✅ Clicked Accept button!', GREEN);

        log('\n⏳ Waiting for connection to establish (20 seconds)...', BLUE);
        await new Promise(resolve => setTimeout(resolve, 20000));

        await page.screenshot({ path: '/tmp/connection-accepted.png', fullPage: true });
        log('📸 Screenshot saved: /tmp/connection-accepted.png', GREEN);

        log('\n✅ Invitation accepted successfully!', GREEN);

        log('\n⏳ Waiting 5 more seconds before closing browser...', BLUE);
        await new Promise(resolve => setTimeout(resolve, 5000));

        await browser.close();
        log('🎉 Done! Browser closed.', GREEN);
        process.exit(0);

    } catch (error) {
        log(`\n❌ Error: ${error.message}`, RED);
        await page.screenshot({ path: '/tmp/error.png', fullPage: true });
        log('📸 Error screenshot saved: /tmp/error.png', RED);
        await browser.close();
        process.exit(1);
    }
}

acceptInvitation();
