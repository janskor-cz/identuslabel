#!/usr/bin/env node

const puppeteer = require('puppeteer');

const ALICE_WALLET_URL = 'https://identuslabel.cz/alice';

const BLUE = '\x1b[0;34m';
const GREEN = '\x1b[0;32m';
const NC = '\x1b[0m';

async function checkConnections() {
    console.log(`${BLUE}Opening Alice wallet to check connections...${NC}`);

    const browser = await puppeteer.launch({
        headless: true,
        executablePath: '/usr/bin/chromium-browser',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });

    const page = await browser.newPage();

    try {
        await page.goto(`${ALICE_WALLET_URL}/connections`, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Extract connection information from page
        const pageText = await page.evaluate(() => document.body.innerText);
        console.log(`\n${GREEN}=== ALICE WALLET CONNECTIONS ===${NC}\n`);
        console.log(pageText);

        await page.screenshot({ path: '/tmp/wallet-connections-check.png', fullPage: true });
        console.log(`\n${GREEN}Screenshot saved: /tmp/wallet-connections-check.png${NC}\n`);

        await browser.close();
    } catch (error) {
        console.error(`Error: ${error.message}`);
        await browser.close();
        process.exit(1);
    }
}

checkConnections();
