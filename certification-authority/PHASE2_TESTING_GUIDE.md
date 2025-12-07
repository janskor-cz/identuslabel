# Phase 2 Client-Side Decryption - Testing Guide

## Quick Testing Steps

### Prerequisites

1. **Services Running:**
   ```bash
   # Cloud Agent
   docker ps | grep cloud-agent

   # Mediator
   docker ps | grep mediator

   # Certification Authority (port 3005)
   lsof -i :3005

   # Alice Wallet (port 3001)
   lsof -i :3001
   ```

2. **User Has Credentials:**
   - Identity VC (firstName, lastName)
   - Security Clearance VC (clearanceLevel, x25519PublicKey)

---

## Test 1: End-to-End Decryption Flow

### Step 1: Authenticate with VCs

1. Open CA portal: `http://91.99.4.54:3005`
2. Click "Get Security Clearance"
3. Complete verification flow with wallet
4. Obtain session URL: `/dashboard?session=xxx`

### Step 2: Verify Encrypted Content Display

1. Open dashboard with session URL
2. **Expected:**
   - User info shows: "John Doe | CONFIDENTIAL" (or your clearance level)
   - Multiple section cards visible
   - Each encrypted section shows:
     - Lock icon (🔒)
     - Text: "Encrypted content - Open wallet to decrypt"
     - Gray gradient background
   - Button appears: "🔓 Decrypt Content with Wallet"

3. **Browser Console Should Show:**
   ```
   [Dashboard] Session encryption capability: true
   [Dashboard] Using ENCRYPTED content endpoint
   [Dashboard] Received data: encrypted 5 sections
   [Dashboard] Total sections: 5, Encrypted: 5
   ```

### Step 3: Trigger Decryption

1. Click "🔓 Decrypt Content with Wallet" button
2. **Expected:**
   - Small popup window opens (450x650)
   - URL: `http://91.99.4.54:3001`
   - Status notification appears (top-right): "Opening wallet..." (blue)

3. **Browser Console Should Show:**
   ```
   [Wallet] Opening wallet window...
   [Status] Opening wallet... (info)
   [Wallet] Wallet window opened, waiting for WALLET_READY signal...
   [Status] Wallet opened. Waiting for connection... (info)
   ```

### Step 4: Wallet Connection

1. **Expected:**
   - Wallet loads in popup
   - Within 2-3 seconds, status changes: "Wallet connected. Starting decryption..." (green)

2. **Browser Console Should Show:**
   ```
   [Wallet] Ready signal received from: alice
   [Status] Wallet connected. Starting decryption... (success)
   [Wallet] Starting decryption of 5 sections
   [Decrypt Request] Requesting decryption for section: public-1
   [Decrypt Request] Sent to wallet for section: public-1
   [Decrypt Request] Requesting decryption for section: internal-1
   ...
   ```

### Step 5: Progressive Decryption

1. **Expected:**
   - Status notification updates: "Decrypted 1/5 sections", "Decrypted 2/5 sections", etc.
   - Sections reveal progressively with fade-in animation
   - Each decrypted section shows:
     - Green checkmark: "✅ Decrypted locally in wallet"
     - Plaintext content below

2. **Browser Console Should Show:**
   ```
   [Decrypt Response] Received for section: public-1
   [Decrypt Response] Latency: 45ms
   [Decrypt Response] ✅ Content updated for section: public-1 (1/5)
   [Status] Decrypted 1/5 sections (success)
   [Decrypt Response] Received for section: internal-1
   [Decrypt Response] Latency: 52ms
   [Decrypt Response] ✅ Content updated for section: internal-1 (2/5)
   ...
   ```

### Step 6: Completion and Auto-Close

1. **Expected:**
   - After all sections decrypted, status: "All content decrypted successfully! 🎉" (green)
   - Wait 2 seconds
   - Wallet popup closes automatically
   - Wait 2 seconds
   - Status notification disappears

2. **Browser Console Should Show:**
   ```
   [Dashboard] ✅ All sections decrypted successfully
   [Status] All content decrypted successfully! 🎉 (success)
   [Dashboard] Auto-closing wallet window...
   ```

3. **Final State:**
   - All content visible in plaintext
   - No popup window
   - No status notification
   - User can scroll and read content

---

## Test 2: Popup Blocker Error Handling

### Steps:

1. Enable popup blocker in browser
2. Follow Test 1 Steps 1-2
3. Click "Decrypt Content with Wallet" button

### Expected:

- Error notification appears: "Failed to open wallet - popup blocked?" (red)
- No wallet window opens
- Console shows: `Failed to open wallet. Please disable popup blocker and try again.`

### Resolution:

1. Disable popup blocker for `91.99.4.54`
2. Retry clicking button
3. Should now work correctly

---

## Test 3: Wallet Connection Timeout

### Steps:

1. Kill Alice wallet process: `pkill -f "alice-wallet"`
2. Follow Test 1 Steps 1-2
3. Click "Decrypt Content with Wallet" button
4. Wait 10 seconds

### Expected:

- Status: "Opening wallet..." → "Wallet opened. Waiting for connection..."
- After 10 seconds: "Wallet connection timeout. Please try again." (red)
- Wallet window auto-closes
- Console shows: `[Wallet] Wallet ready timeout`

### Resolution:

1. Restart Alice wallet: `cd /root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/alice-wallet && yarn dev &`
2. Wait for wallet to start (check `lsof -i :3001`)
3. Retry decryption flow

---

## Test 4: Wallet Already Open

### Steps:

1. Manually open Alice wallet in another browser tab: `http://91.99.4.54:3001`
2. Follow Test 1 Steps 1-2
3. Click "Decrypt Content with Wallet" button

### Expected:

- Existing wallet tab/window is focused (brought to front)
- Status: "Wallet window focused. Waiting for connection..." (blue)
- Decryption proceeds normally
- Console shows: `[Wallet] Wallet already open, focusing...`

---

## Test 5: Session Without Encryption Capability

### Steps:

1. Authenticate with **only Identity VC** (no Security Clearance)
2. Session created without `x25519PublicKey`
3. Open dashboard: `/dashboard?session=xxx`

### Expected:

- Dashboard uses **plaintext endpoint**: `/api/dashboard/content`
- Content displayed immediately (no encryption)
- No "Decrypt Content with Wallet" button
- Console shows: `[Dashboard] Using PLAINTEXT content endpoint (no encryption capability)`

---

## Test 6: Manual Wallet Close During Decryption

### Steps:

1. Follow Test 1 Steps 1-3 (start decryption)
2. **Immediately** close wallet popup manually (click X)
3. Observe behavior

### Expected:

- Sections that didn't decrypt show: "⏱️ Decryption timeout. Please ensure wallet is open and try again."
- Status notification may show partial progress: "Decrypted 2/5 sections"
- No auto-close trigger (wallet already closed)
- Console shows timeout errors for pending sections

### Recovery:

1. Click "Decrypt Content with Wallet" button again
2. Let wallet stay open until completion

---

## Test 7: Different Clearance Levels

### Test 7A: INTERNAL Clearance

1. Use Security Clearance VC with `clearanceLevel: "INTERNAL"`
2. Complete authentication
3. **Expected Sections:**
   - 1 PUBLIC section
   - 2 INTERNAL sections
   - **Total: 3 sections** (no CONFIDENTIAL/RESTRICTED/TOP-SECRET)
4. Decryption progress: "Decrypted 1/3 sections", "Decrypted 2/3 sections", etc.

### Test 7B: TOP-SECRET Clearance

1. Use Security Clearance VC with `clearanceLevel: "TOP-SECRET"`
2. Complete authentication
3. **Expected Sections:**
   - 1 PUBLIC section
   - 2 INTERNAL sections
   - 2 CONFIDENTIAL sections
   - 1 RESTRICTED section
   - 1 TOP-SECRET section
   - **Total: 7 sections** (all content)
4. Decryption progress: "Decrypted 1/7 sections" ... "Decrypted 7/7 sections"

---

## Performance Benchmarks

### Typical Performance Expectations

| Clearance Level | Sections | Expected Decryption Time | Wallet Open Duration |
|-----------------|----------|-------------------------|----------------------|
| PUBLIC | 1 | 1-2 seconds | 3-4 seconds |
| INTERNAL | 3 | 2-3 seconds | 4-5 seconds |
| CONFIDENTIAL | 5 | 2-3 seconds | 4-5 seconds |
| RESTRICTED | 6 | 3-4 seconds | 5-6 seconds |
| TOP-SECRET | 7 | 3-4 seconds | 5-6 seconds |

**Note:** Wallet open duration includes decryption time + 2-second delay before auto-close.

### Performance Red Flags

| Issue | Symptom | Investigation |
|-------|---------|---------------|
| **Slow decryption** | >5 seconds for 5 sections | Check wallet console for errors, verify X25519 keys correct |
| **Wallet doesn't close** | Stays open >10 seconds after completion | Check browser console for JavaScript errors |
| **High CPU usage** | Browser sluggish | Check for memory leaks, restart browser |

---

## Browser Developer Tools Checklist

### Console Logs to Monitor

**Successful Flow:**
```
✅ [Dashboard] Initializing...
✅ [postMessage] Listener initialized successfully
✅ [Dashboard] Using ENCRYPTED content endpoint
✅ [Wallet] Ready signal received from: alice
✅ [Decrypt Response] ✅ Content updated for section: xxx (X/Y)
✅ [Dashboard] ✅ All sections decrypted successfully
✅ [Dashboard] Auto-closing wallet window...
```

**Error Indicators:**
```
❌ Failed to open wallet
❌ [Wallet] Wallet ready timeout
❌ [Decrypt Request] Timeout for section: xxx
❌ [Decrypt Error] Failed for section xxx: [error message]
```

### Network Tab

**Expected Requests:**
1. `GET /api/session/{sessionId}` - Check encryption capability
2. `GET /api/secure-content?session={sessionId}` - Fetch encrypted content
3. **No additional requests** during decryption (all local via postMessage)

**No Requests Expected:**
- ❌ `/api/dashboard/content` (should not be called if encryption capable)
- ❌ Any decryption-related API calls (all client-side)

### Application Tab (IndexedDB)

**Check Wallet Storage (in wallet popup):**
- Database: `identus-wallet-alice`
- Store: `credentials`
- Verify: X25519 key pair exists

**Check Dashboard Storage:**
- No credentials stored
- No plaintext content persisted
- Session ID in `sessionStorage` (optional)

---

## Troubleshooting Common Issues

### Issue 1: Sections Show "Encrypted content - Open wallet to decrypt"

**Cause:** Wallet not detected or not opened

**Solution:**
1. Click "Decrypt Content with Wallet" button
2. Ensure popup blocker disabled
3. Wait for wallet to load and send WALLET_READY

### Issue 2: Status Shows "Waiting for connection..." for >10 seconds

**Cause:** Wallet not sending WALLET_READY signal

**Solution:**
1. Check wallet console for errors
2. Hard refresh wallet: Ctrl+Shift+R (Windows/Linux) or Cmd+Shift+R (Mac)
3. Restart wallet dev server: `cd alice-wallet && yarn dev`

### Issue 3: Some Sections Show Timeout Error

**Cause:** Wallet closed too early or decryption failed

**Solution:**
1. Check wallet console for decryption errors
2. Verify X25519 keys match (wallet public key = server recipient key)
3. Retry decryption by clicking button again

### Issue 4: Wallet Doesn't Auto-Close

**Cause:** JavaScript error or not all sections decrypted

**Solution:**
1. Check browser console for errors
2. Verify decryption counter matches total: `decryptedSectionsCount === totalEncryptedSections`
3. Manually close wallet and retry

### Issue 5: Content Not Displaying After Decryption

**Cause:** DOM update failed or content element not found

**Solution:**
1. Check console for: `Content element not found: content-xxx`
2. Verify section IDs match in API response and DOM
3. Hard refresh dashboard: Ctrl+Shift+R

---

## Automated Testing (Future)

### Playwright Test Script Example

```javascript
// test/phase2-decryption.spec.ts
import { test, expect } from '@playwright/test';

test('should decrypt content with wallet', async ({ page, context }) => {
  // Step 1: Navigate to dashboard with session
  await page.goto('http://91.99.4.54:3005/dashboard?session=test-session-id');

  // Step 2: Verify encrypted content displayed
  await expect(page.locator('.content.encrypted')).toHaveCount(5);

  // Step 3: Click decrypt button
  const [walletPopup] = await Promise.all([
    context.waitForEvent('page'),
    page.click('#open-wallet-btn')
  ]);

  // Step 4: Verify wallet opened
  await expect(walletPopup).toHaveURL('http://91.99.4.54:3001');

  // Step 5: Wait for decryption
  await page.waitForSelector('.decryption-success-indicator', { timeout: 10000 });

  // Step 6: Verify all sections decrypted
  const decryptedSections = await page.locator('.decryption-success-indicator').count();
  expect(decryptedSections).toBe(5);

  // Step 7: Verify wallet auto-closed
  await page.waitForTimeout(3000); // Wait for auto-close
  expect(walletPopup.isClosed()).toBeTruthy();
});
```

---

## Regression Testing Checklist

Before deploying Phase 2, verify:

- ✅ Phase 1 plaintext content still works (no encryption)
- ✅ Session management unchanged
- ✅ Authentication flow unchanged
- ✅ Public content accessible without session
- ✅ Error handling graceful
- ✅ Console logs appropriate (not excessive)
- ✅ No memory leaks (check with Chrome DevTools Memory profiler)
- ✅ Mobile responsive (test on smaller screens)

---

## Security Testing

### Security Checklist

1. **Origin Validation:**
   - Modify wallet URL to different domain
   - Verify: postMessage rejected with console warning

2. **Session Expiration:**
   - Use expired session ID
   - Verify: 401 Unauthorized error from API

3. **XSS Protection:**
   - Inject `<script>alert('XSS')</script>` in content
   - Verify: Content escaped with `escapeHtml()`, no script execution

4. **Private Key Protection:**
   - Check Network tab during decryption
   - Verify: No private key transmitted (only public key in session)

5. **Content Encryption:**
   - Inspect `/api/secure-content` response
   - Verify: `encryptedContent.ciphertext` is base64url-encoded gibberish
   - Verify: Cannot decrypt without wallet

---

## Acceptance Criteria

### Must Pass All:

- ✅ Encrypted content displays with lock icon placeholder
- ✅ "Decrypt Content with Wallet" button appears for encrypted content
- ✅ Wallet opens in popup window on button click
- ✅ WALLET_READY signal received within 10 seconds
- ✅ All encrypted sections decrypt successfully
- ✅ Progress notification updates: "Decrypted X/Y sections"
- ✅ Decrypted content displays with green checkmark
- ✅ Fade-in animation plays on content reveal
- ✅ Wallet auto-closes 2 seconds after completion
- ✅ Status notification clears 2 seconds after wallet close
- ✅ Error handling graceful (popup blocker, timeout, etc.)
- ✅ Console logs helpful for debugging
- ✅ No JavaScript errors in console
- ✅ No memory leaks (test with Chrome DevTools)
- ✅ Backward compatible with Phase 1 (plaintext content)

---

## Test Report Template

```markdown
# Phase 2 Decryption Test Report

**Date:** YYYY-MM-DD
**Tester:** [Name]
**Environment:** Production / Staging / Dev
**Browser:** Chrome 120.x / Firefox 121.x / Safari 17.x

## Test Results

| Test # | Test Name | Result | Notes |
|--------|-----------|--------|-------|
| 1 | End-to-end decryption flow | ✅ PASS | All sections decrypted in 3.2s |
| 2 | Popup blocker error handling | ✅ PASS | Clear error message displayed |
| 3 | Wallet connection timeout | ✅ PASS | Auto-closed after 10s |
| 4 | Wallet already open | ✅ PASS | Focused existing window |
| 5 | Session without encryption | ✅ PASS | Fallback to plaintext |
| 6 | Manual wallet close | ✅ PASS | Graceful error handling |
| 7A | INTERNAL clearance | ✅ PASS | 3 sections decrypted |
| 7B | TOP-SECRET clearance | ✅ PASS | 7 sections decrypted |

## Performance Metrics

- **Sections Decrypted:** 5
- **Total Decryption Time:** 2.8 seconds
- **Average Latency:** 48ms per section
- **Wallet Open Duration:** 4.8 seconds

## Issues Found

[List any issues discovered during testing]

## Recommendations

[List any recommendations for improvement]

---

**Overall Assessment:** ✅ APPROVED FOR PRODUCTION / ⚠️ REQUIRES FIXES / ❌ NOT READY
```

---

**Document Version:** 1.0
**Last Updated:** 2025-11-02
**Status:** Ready for Testing
