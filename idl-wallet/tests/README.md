# Alice Wallet Automated Tests

Automated browser testing using Puppeteer + Chromium headless.

## Prerequisites

- Chromium browser installed: `/snap/bin/chromium`
- Puppeteer installed: `npm install puppeteer`
- Alice wallet running on port 3001

## Available Tests

### 1. Basic Load Test (`basic-load.test.js`)

Tests fundamental wallet functionality:
- Page loads successfully (HTTP 200)
- No JavaScript errors
- UI elements render correctly
- Screenshot capture

**Run**:
```bash
cd /root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/alice-wallet
npm run test:basic
```

**Expected Output**:
```
✅ Test 1: Page loaded successfully (HTTP 200)
✅ Test 2: No JavaScript errors detected
✅ Test 3: Wallet UI elements detected
✅ Test 4: Screenshot saved to /tmp/alice-wallet-screenshot.png
```

---

### 2. Buffer Error Test (`buffer-error.test.js`)

Detects Buffer-related errors including "undefined 't' error":
- Monitors console for Buffer errors
- Checks page errors
- Tests QR scanner page loading

**Run**:
```bash
npm run test:buffer
```

**Expected Output** (if no errors):
```
✅ No Buffer-related errors detected
✅ No suspicious console messages
✅ Verify page loaded without Buffer errors
```

**If errors found**:
```
❌ Found 2 Buffer-related errors:
  - TypeError: t is not a function
  - Buffer is not defined
```

---

## Running All Tests

```bash
npm run test
```

This runs both tests sequentially.

---

## Test Output

**Console logs**: Test results printed to stdout
**Screenshots**: Saved to `/tmp/alice-wallet-screenshot.png`
**Exit codes**:
- `0` = All tests passed
- `1` = One or more tests failed

---

## Troubleshooting

### "Error: Failed to launch browser"

**Cause**: Chromium not found or incorrect path

**Solution**:
```bash
# Verify Chromium installed
chromium --version

# Check path
which chromium
# Should output: /snap/bin/chromium
```

---

### "ECONNREFUSED" error

**Cause**: Alice wallet not running on port 3001

**Solution**:
```bash
# Start Alice wallet
cd /root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/alice-wallet
yarn dev

# Verify it's running
curl -I http://91.99.4.54:3001
```

---

### Tests timeout

**Cause**: Wallet takes too long to load

**Solution**: Increase timeout in test file:
```javascript
await page.goto('http://91.99.4.54:3001', {
  waitUntil: 'networkidle2',
  timeout: 60000 // Increase to 60 seconds
});
```

---

## Adding New Tests

Create a new file in `tests/` directory:

```javascript
const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/snap/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.goto('http://91.99.4.54:3001');

  // Your test logic here

  await browser.close();
})();
```

Add npm script in `package.json`:
```json
{
  "scripts": {
    "test:mytest": "node tests/mytest.test.js"
  }
}
```

---

## CI/CD Integration

Tests can be run in continuous integration:

```yaml
# Example GitHub Actions workflow
- name: Run wallet tests
  run: |
    cd alice-wallet
    npm run test
```

---

## Performance Notes

- **Chromium launch**: ~1-2 seconds
- **Page load**: ~2-3 seconds
- **Total test time**: ~10-15 seconds per test

---

## Known Limitations

- Headless mode cannot test QR code camera access (requires real device)
- IndexedDB data persists between test runs (may need cleanup)
- Tests run sequentially (no parallel execution)

---

## Future Enhancements

- [ ] Connect to CA button test
- [ ] DIDComm connection flow test
- [ ] Credential issuance test
- [ ] QR code simulation (via clipboard paste)
- [ ] Performance benchmarking

---

**Last Updated**: November 6, 2025
**Maintainer**: Hyperledger Identus Team
