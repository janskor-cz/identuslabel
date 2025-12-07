/**
 * Employee Training Page - Client-Side Logic
 * VERSION: 20251121g - FIXED: DOMContentLoaded timing issue
 *
 * Handles CIS training completion flow:
 * 1. Verify employee session
 * 2. Enable submit button when checkbox checked
 * 3. Submit training completion
 * 4. Poll for VC issuance
 * 5. Redirect to dashboard when complete
 */

const SCRIPT_VERSION = '20251121g';
console.log(`%c[Training] JavaScript Version: ${SCRIPT_VERSION}`, 'color: blue; font-weight: bold; font-size: 16px');

// DOM Elements - will be assigned in init() after DOM is ready
let completionCheck;
let submitButton;
let statusMessage;

// Session token from localStorage
const sessionToken = localStorage.getItem('employee_session_token');
console.log('[Training] Session token RAW value:', sessionToken);
console.log('[Training] Session token type:', typeof sessionToken);
console.log('[Training] Session token length:', sessionToken ? sessionToken.length : 0);

// Validate token is not the string "undefined" or "null"
const isValidToken = sessionToken &&
                     sessionToken !== 'undefined' &&
                     sessionToken !== 'null' &&
                     sessionToken.length > 20;

console.log('[Training] Session token valid?', isValidToken);

// Base API URL (handles reverse proxy path)
const API_BASE = window.location.pathname.startsWith('/company-admin')
    ? '/company-admin/api'
    : '/api';

/**
 * Initialize page
 */
async function init() {
    console.log('[Training] ===== INIT FUNCTION STARTED =====');
    console.log('[Training] Version:', SCRIPT_VERSION);

    // Assign DOM elements now that DOM is ready
    completionCheck = document.getElementById('completionCheck');
    submitButton = document.getElementById('submitButton');
    statusMessage = document.getElementById('statusMessage');

    console.log('[Training] DOM elements assigned:');
    console.log('[Training]   completionCheck:', completionCheck);
    console.log('[Training]   submitButton:', submitButton);
    console.log('[Training]   statusMessage:', statusMessage);

    // Check session
    if (!isValidToken) {
        console.error('[Training] ❌ CRITICAL: Invalid or missing session token');
        console.error('[Training] Token value:', sessionToken);
        console.error('[Training] localStorage keys:', Object.keys(localStorage));

        if (sessionToken === 'undefined' || sessionToken === 'null') {
            showError('Invalid session token detected. The login process failed. Please clear your browser data and try logging in again.');
            console.error('[Training] 🐛 BUG: Token was stored as string "undefined" or "null" - this indicates a bug in the login flow');
        } else {
            showError('No valid session found. Please log in first.');
        }

        // TEMPORARILY DISABLED: Don't redirect immediately for debugging
        console.log('[Training] ⚠️ Redirect DISABLED for debugging');
        console.log('[Training] 💡 To fix: Clear localStorage and log in again');
        return;
    }

    console.log('[Training] ✅ Session token found:', sessionToken.substring(0, 20) + '...');

    // Verify session is valid
    try {
        console.log('[Training] 📡 Calling profile API:', `${API_BASE}/employee-portal/profile`);
        const response = await fetch(`${API_BASE}/employee-portal/profile`, {
            headers: {
                'x-session-token': sessionToken
            }
        });

        console.log('[Training] 📡 Profile API response status:', response.status);

        if (!response.ok) {
            throw new Error(`Invalid session (HTTP ${response.status})`);
        }

        const data = await response.json();
        console.log('[Training] 📋 Profile data received:', JSON.stringify(data, null, 2));

        // Check if already has training
        console.log('[Training] 🔍 Checking training status...');
        console.log('[Training]    data.training exists:', !!data.training);
        console.log('[Training]    data.training.hasValidTraining:', data.training?.hasValidTraining);

        if (data.training && data.training.hasValidTraining) {
            console.log('[Training] ✅ User HAS valid training - redirecting to dashboard');
            showInfo('You have already completed training. Redirecting to dashboard...');
            setTimeout(() => {
                window.location.href = '/company-admin/employee-portal-dashboard.html';
            }, 2000);
            return;
        }

        console.log('[Training] ❌ User DOES NOT have valid training - showing form');
        console.log('[Training] Employee:', data.employee?.email);
    } catch (error) {
        console.error('[Training] ❌ Session verification failed:', error);
        console.error('[Training] Error details:', error.message);
        showError('Session verification failed: ' + error.message + '. You can still complete training.');
        // Continue to setup event listeners even if API fails
    }

    // Setup event listeners
    console.log('[Training] 🔧 Setting up event listeners');
    console.log('[Training] completionCheck element:', completionCheck);
    console.log('[Training] submitButton element:', submitButton);

    if (completionCheck && submitButton) {
        completionCheck.addEventListener('change', handleCheckboxChange);
        submitButton.addEventListener('click', handleSubmit);
        console.log('[Training] ✅ Event listeners attached successfully');
    } else {
        console.error('[Training] ❌ CRITICAL: Elements not found!');
        console.error('[Training]   completionCheck:', completionCheck);
        console.error('[Training]   submitButton:', submitButton);
    }
    console.log('[Training] ✅ Initialization complete - form is ready');
}

/**
 * Handle completion checkbox change
 */
function handleCheckboxChange() {
    console.log('[Training] 📋 Checkbox changed!');
    console.log('[Training]    Checked:', completionCheck.checked);
    console.log('[Training]    Button was disabled:', submitButton.disabled);

    submitButton.disabled = !completionCheck.checked;

    console.log('[Training]    Button now disabled:', submitButton.disabled);
}

/**
 * Handle training completion submission
 */
async function handleSubmit() {
    console.log('[Training] 🚀 Submit button clicked!');
    console.log('[Training] Checkbox checked?', completionCheck.checked);
    console.log('[Training] Session token exists?', !!sessionToken);

    if (!completionCheck.checked) {
        showError('Please check the completion box to proceed.');
        return;
    }

    submitButton.disabled = true;
    completionCheck.disabled = true;

    try {
        // Step 1: Submit training completion
        showLoading('Submitting training completion...');

        const response = await fetch(`${API_BASE}/employee-portal/training/complete`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-session-token': sessionToken
            }
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.message || 'Failed to submit training completion');
        }

        const data = await response.json();

        if (!data.success) {
            throw new Error(data.message || 'Training completion failed');
        }

        console.log('[Training] Completion submitted:', data);

        // Step 2: Show issuing message
        showLoading('Issuing CIS Training Certificate...', [
            'Creating credential offer',
            'Waiting for edge wallet acceptance',
            'Finalizing credential issuance'
        ]);

        // Step 3: Poll for VC issuance completion
        const recordId = data.vcRecordId;
        const issued = await pollForVCIssuance(recordId);

        if (!issued) {
            throw new Error('Training certificate issuance timed out');
        }

        // Step 4: Show success and redirect
        showSuccess('Training completed successfully! Certificate issued. Redirecting to dashboard...');

        setTimeout(() => {
            window.location.href = '/company-admin/employee-portal-dashboard.html';
        }, 2000);

    } catch (error) {
        console.error('[Training] Submission error:', error);
        showError(`Error: ${error.message}`);
        submitButton.disabled = false;
        completionCheck.disabled = false;
    }
}

/**
 * Poll for VC issuance completion
 * @param {string} recordId - Credential record ID
 * @returns {Promise<boolean>} True if issued, false if timeout
 */
async function pollForVCIssuance(recordId) {
    const maxAttempts = 30; // 30 attempts
    const interval = 2000; // 2 seconds
    let attempts = 0;

    return new Promise((resolve) => {
        const pollInterval = setInterval(async () => {
            attempts++;

            try {
                const response = await fetch(`${API_BASE}/employee-portal/training/status/${recordId}`, {
                    headers: {
                        'x-session-token': sessionToken
                    }
                });

                if (!response.ok) {
                    console.error('[Training] Status check failed:', response.status);
                    if (attempts >= maxAttempts) {
                        clearInterval(pollInterval);
                        resolve(false);
                    }
                    return;
                }

                const data = await response.json();

                console.log(`[Training] Attempt ${attempts}/${maxAttempts} - State: ${data.state}`);

                // Check if VC is issued (CredentialSent state)
                if (data.state === 'CredentialSent') {
                    clearInterval(pollInterval);
                    resolve(true);
                    return;
                }

                // Check for failure states
                if (data.state === 'OfferRejected' || data.state === 'RequestRejected') {
                    clearInterval(pollInterval);
                    console.error('[Training] VC offer rejected');
                    resolve(false);
                    return;
                }

                // Timeout check
                if (attempts >= maxAttempts) {
                    clearInterval(pollInterval);
                    console.error('[Training] Polling timeout');
                    resolve(false);
                }

            } catch (error) {
                console.error('[Training] Polling error:', error);
                if (attempts >= maxAttempts) {
                    clearInterval(pollInterval);
                    resolve(false);
                }
            }
        }, interval);
    });
}

/**
 * Show loading message with optional steps
 * @param {string} message - Main message
 * @param {Array<string>} steps - Optional progress steps
 */
function showLoading(message, steps = []) {
    statusMessage.className = 'status-message status-loading';

    let html = `
        <div class="spinner"></div>
        <span>${message}</span>
    `;

    if (steps.length > 0) {
        html += '<div class="progress-steps">';
        steps.forEach(step => {
            html += `<div>${step}</div>`;
        });
        html += '</div>';
    }

    statusMessage.innerHTML = html;
    statusMessage.classList.remove('hidden');
}

/**
 * Show success message
 * @param {string} message - Success message
 */
function showSuccess(message) {
    statusMessage.className = 'status-message status-success';
    statusMessage.textContent = message;
    statusMessage.classList.remove('hidden');
}

/**
 * Show error message
 * @param {string} message - Error message
 */
function showError(message) {
    statusMessage.className = 'status-message status-error';
    statusMessage.textContent = message;
    statusMessage.classList.remove('hidden');
}

/**
 * Show info message
 * @param {string} message - Info message
 */
function showInfo(message) {
    statusMessage.className = 'status-message status-loading';
    statusMessage.textContent = message;
    statusMessage.classList.remove('hidden');
}

// Initialize on page load
// Handle both normal load and dynamic script injection
if (document.readyState === 'loading') {
    // DOM not ready yet, wait for DOMContentLoaded
    document.addEventListener('DOMContentLoaded', init);
} else {
    // DOM already ready (script loaded dynamically after page load)
    console.log('[Training] DOM already ready, calling init() immediately');
    init();
}
