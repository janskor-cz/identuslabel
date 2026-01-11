// Employee Portal Dashboard JavaScript
// Handles profile display, training status, and session management

const API_BASE = '/company-admin/api/employee-portal';

// Session management
function getSessionToken() {
    return localStorage.getItem('employee_session_token');
}

function clearSession() {
    localStorage.removeItem('employee_session_token');
    localStorage.removeItem('employee_profile');
}

// Show/hide loading overlay
function showLoading(show = true) {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) {
        overlay.style.display = show ? 'flex' : 'none';
    }
}

// Show error banner
function showError(message) {
    const banner = document.getElementById('errorBanner');
    if (banner) {
        banner.textContent = message;
        banner.classList.add('show');

        // Auto-hide after 5 seconds
        setTimeout(() => {
            banner.classList.remove('show');
        }, 5000);
    }
}

// Check authentication and redirect if needed
function checkAuthentication() {
    const token = getSessionToken();
    if (!token) {
        window.location.href = '/company-admin/employee-portal-login.html?error=session_required';
        return false;
    }
    return true;
}

// Load employee profile
async function loadProfile() {
    const token = getSessionToken();
    if (!token) {
        return null;
    }

    try {
        const response = await fetch(`${API_BASE}/profile`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'x-session-token': token
            }
        });

        if (response.status === 401) {
            // Session expired
            clearSession();
            window.location.href = '/company-admin/employee-portal-login.html?error=session_expired';
            return null;
        }

        if (!response.ok) {
            throw new Error(`Failed to load profile: ${response.statusText}`);
        }

        const data = await response.json();

        // Cache profile in localStorage
        localStorage.setItem('employee_profile', JSON.stringify(data));

        return data;
    } catch (error) {
        console.error('Error loading profile:', error);
        showError('Failed to load profile. Please try again.');
        return null;
    }
}

// Display profile data
function displayProfile(profile) {
    if (!profile || !profile.employee) return;

    const employee = profile.employee;

    // Update header with employee name
    const employeeNameEl = document.getElementById('employeeName');
    if (employeeNameEl) {
        employeeNameEl.textContent = `Welcome back, ${employee.fullName || 'Employee'}!`;
    }

    // Update profile fields
    const fields = {
        employeeId: employee.employeeId || 'N/A',
        fullName: employee.fullName || 'N/A',
        department: employee.department || 'N/A',
        role: employee.role || 'N/A',
        prismDid: formatDID(employee.prismDid) || 'Not assigned'
    };

    Object.entries(fields).forEach(([id, value]) => {
        const element = document.getElementById(id);
        if (element) {
            // For DID, only update the span (not the button)
            if (id === 'prismDid') {
                element.textContent = value;
            } else {
                element.textContent = value;
            }
        }
    });

    // Update clearance level display and button visibility
    const clearanceLevelEl = document.getElementById('clearanceLevel');
    const verifyClearanceBtn = document.getElementById('verifyClearanceBtn');

    // Check both profile.clearance and direct properties (server returns both formats)
    const hasClearance = profile.hasClearanceVC || (profile.clearance && profile.clearance.hasClearanceVC);
    const clearanceLevel = profile.clearanceLevel || (profile.clearance && profile.clearance.level);

    if (clearanceLevelEl) {
        if (hasClearance && clearanceLevel) {
            clearanceLevelEl.textContent = clearanceLevel;
            clearanceLevelEl.style.color = getClearanceColor(clearanceLevel);
            clearanceLevelEl.style.fontWeight = '600';
            // Hide verify button if clearance is already verified
            if (verifyClearanceBtn) {
                verifyClearanceBtn.style.display = 'none';
            }
        } else {
            clearanceLevelEl.textContent = 'Not Verified';
            clearanceLevelEl.style.color = '#718096'; // Gray color
            clearanceLevelEl.style.fontWeight = '400';
            // Show verify button if no clearance
            if (verifyClearanceBtn) {
                verifyClearanceBtn.style.display = 'inline-block';
            }
        }
    }
}

// Get color based on clearance level
function getClearanceColor(level) {
    switch (level) {
        case 'TOP-SECRET':
            return '#9f7aea'; // Purple
        case 'RESTRICTED':
            return '#e53e3e'; // Red
        case 'CONFIDENTIAL':
            return '#ed8936'; // Orange
        case 'INTERNAL':
        default:
            return '#38a169'; // Green
    }
}

// Current verification ID and polling interval (for tracking)
let currentVerificationId = null;
let clearancePollingInterval = null;
let clearancePollingStartTime = null;
const CLEARANCE_POLLING_TIMEOUT = 5 * 60 * 1000; // 5 minutes

// Open clearance verification modal (show instructions, don't start yet)
function openClearanceModal() {
    const modal = document.getElementById('clearanceVerificationModal');
    if (modal) {
        modal.classList.remove('hidden');
        modal.style.display = 'flex';
    }

    // Reset modal to show content and buttons (not waiting state)
    const content = document.getElementById('clearanceVerificationContent');
    const loading = document.getElementById('clearanceVerificationLoading');
    const success = document.getElementById('clearanceVerificationSuccess');
    const error = document.getElementById('clearanceVerificationError');
    const waitingDiv = document.getElementById('clearanceVerificationWaiting');
    const buttons = document.getElementById('clearanceVerificationButtons');

    // Show content and buttons, hide everything else
    if (content) content.classList.remove('hidden');
    if (buttons) buttons.classList.remove('hidden');
    if (loading) loading.classList.add('hidden');
    if (success) success.classList.add('hidden');
    if (error) error.classList.add('hidden');
    if (waitingDiv) waitingDiv.classList.add('hidden');
}

// Start the actual clearance verification (called from "Start Verification" button in modal)
async function initiateClearanceVerification() {
    const token = getSessionToken();
    if (!token) {
        showError('Session expired. Please log in again.');
        return;
    }

    // Show waiting state (not the dropdown)
    showClearanceWaitingState();

    try {
        // Initiate DIDComm proof request to personal wallet via CA
        const response = await fetch(`${API_BASE}/clearance/initiate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-session-token': token
            }
        });

        const data = await response.json();

        if (!response.ok || !data.success) {
            // Handle specific error cases
            if (data.error === 'NoDirectConnection') {
                showClearanceError('No Direct Connection',
                    'No DIDComm connection found from your company to your personal wallet. ' +
                    'Please ensure your Alice Wallet is connected to TechCorp before verifying clearance.');
                return;
            }
            if (data.error === 'NoCAConnection') {
                showClearanceError('No CA Connection',
                    'You must first connect to the Certification Authority via Alice Wallet to receive your Security Clearance credential.');
                return;
            }
            throw new Error(data.message || 'Failed to initiate clearance verification');
        }

        currentVerificationId = data.verificationId;
        clearancePollingStartTime = Date.now();
        console.log('[Clearance] DIDComm proof request sent:', currentVerificationId);
        console.log('[Clearance] Instructions:', data.instructions);

        // Update modal with instructions
        updateClearanceInstructions(data.instructions, data.aliceWalletUrl);

        // Start polling for verification status
        startClearancePolling();

    } catch (error) {
        console.error('[Clearance] Initiation error:', error);
        showClearanceError('Verification Failed', error.message || 'Failed to initiate verification');
    }
}

// Show waiting state in modal
function showClearanceWaitingState() {
    const content = document.getElementById('clearanceVerificationContent');
    const loading = document.getElementById('clearanceVerificationLoading');
    const success = document.getElementById('clearanceVerificationSuccess');
    const error = document.getElementById('clearanceVerificationError');
    const waitingDiv = document.getElementById('clearanceVerificationWaiting');
    const buttons = document.getElementById('clearanceVerificationButtons');

    // Hide all states including buttons (they're redundant once verification starts)
    if (content) content.classList.add('hidden');
    if (loading) loading.classList.add('hidden');
    if (success) success.classList.add('hidden');
    if (error) error.classList.add('hidden');
    if (buttons) buttons.classList.add('hidden');

    // Show or create waiting state
    if (waitingDiv) {
        waitingDiv.classList.remove('hidden');
    } else {
        // Create waiting state dynamically
        const modalContent = document.querySelector('.modal-content');
        if (modalContent) {
            const waiting = document.createElement('div');
            waiting.id = 'clearanceVerificationWaiting';
            waiting.innerHTML = `
                <div style="text-align: center; padding: 20px;">
                    <div class="spinner" style="margin: 0 auto 15px;"></div>
                    <h3>Sending Proof Request...</h3>
                    <p id="clearanceWaitingMessage">Requesting Security Clearance verification via DIDComm...</p>
                    <div id="clearanceInstructions" style="margin-top: 15px; text-align: left; background: #f7fafc; padding: 15px; border-radius: 8px; display: none;">
                        <strong>Instructions:</strong>
                        <ol id="clearanceInstructionsList" style="margin: 10px 0 0 20px; line-height: 1.8;"></ol>
                        <a id="aliceWalletLink" href="#" target="_blank" style="display: inline-block; margin-top: 15px; background: #4299e1; color: white; padding: 10px 20px; border-radius: 5px; text-decoration: none;">
                            Open Alice Wallet
                        </a>
                    </div>
                    <p id="clearancePollingStatus" style="margin-top: 15px; color: #718096; font-size: 0.9em;">
                        Waiting for wallet response...
                    </p>
                    <button onclick="closeClearanceModal()" style="margin-top: 20px; background: #e2e8f0; color: #2d3748; border: none; padding: 10px 20px; border-radius: 8px; font-size: 14px; cursor: pointer;">
                        Cancel
                    </button>
                </div>
            `;
            // Insert before success/error divs
            const successDiv = document.getElementById('clearanceVerificationSuccess');
            if (successDiv) {
                modalContent.insertBefore(waiting, successDiv);
            } else {
                modalContent.appendChild(waiting);
            }
        }
    }
}

// Update instructions in waiting state
function updateClearanceInstructions(instructions, aliceWalletUrl) {
    const instructionsDiv = document.getElementById('clearanceInstructions');
    const instructionsList = document.getElementById('clearanceInstructionsList');
    const walletLink = document.getElementById('aliceWalletLink');
    const waitingMessage = document.getElementById('clearanceWaitingMessage');

    if (waitingMessage) {
        waitingMessage.textContent = 'A proof request has been sent to your Alice Wallet. Please approve it.';
    }

    if (instructionsDiv && instructionsList && instructions) {
        instructionsList.innerHTML = instructions.map(inst => `<li>${inst}</li>`).join('');
        instructionsDiv.style.display = 'block';
    }

    if (walletLink && aliceWalletUrl) {
        walletLink.href = aliceWalletUrl;
    }
}

// Start polling for clearance verification status
function startClearancePolling() {
    // Clear any existing interval
    if (clearancePollingInterval) {
        clearInterval(clearancePollingInterval);
    }

    // Poll every 2 seconds
    clearancePollingInterval = setInterval(async () => {
        await pollClearanceStatus();
    }, 2000);

    // Initial poll
    pollClearanceStatus();
}

// Poll clearance verification status
async function pollClearanceStatus() {
    if (!currentVerificationId) {
        stopClearancePolling();
        return;
    }

    // Check for timeout
    if (clearancePollingStartTime && (Date.now() - clearancePollingStartTime) > CLEARANCE_POLLING_TIMEOUT) {
        stopClearancePolling();
        showClearanceError('Verification Timeout',
            'The verification request has expired. Please try again.');
        return;
    }

    const token = getSessionToken();
    if (!token) {
        stopClearancePolling();
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/clearance/status/${currentVerificationId}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'x-session-token': token
            }
        });

        const data = await response.json();

        // Update polling status display
        const statusEl = document.getElementById('clearancePollingStatus');
        const elapsedSeconds = Math.floor((Date.now() - clearancePollingStartTime) / 1000);
        if (statusEl) {
            statusEl.textContent = `Waiting for wallet response... (${elapsedSeconds}s)`;
        }

        if (data.status === 'verified' && data.clearanceLevel) {
            // Success! Stop polling and show result
            stopClearancePolling();
            showClearanceSuccess(data.clearanceLevel);
        } else if (data.status === 'declined') {
            // User declined
            stopClearancePolling();
            showClearanceError('Request Declined',
                'You declined the proof request in your wallet.');
        } else if (data.error === 'VerificationExpired') {
            // Expired
            stopClearancePolling();
            showClearanceError('Verification Expired',
                'The verification request has expired. Please try again.');
        }
        // else: still pending, continue polling

    } catch (error) {
        console.error('[Clearance] Poll error:', error);
        // Don't stop polling on transient errors
    }
}

// Stop clearance polling
function stopClearancePolling() {
    if (clearancePollingInterval) {
        clearInterval(clearancePollingInterval);
        clearancePollingInterval = null;
    }
}

// Show clearance verification success
function showClearanceSuccess(clearanceLevel) {
    const waitingDiv = document.getElementById('clearanceVerificationWaiting');
    const success = document.getElementById('clearanceVerificationSuccess');
    const verifiedLevel = document.getElementById('verifiedClearanceLevel');

    if (waitingDiv) waitingDiv.classList.add('hidden');
    if (success) success.classList.remove('hidden');
    if (verifiedLevel) verifiedLevel.textContent = clearanceLevel;

    console.log('[Clearance] Verification successful:', clearanceLevel);

    // Update the profile display and reload documents after a delay
    setTimeout(async () => {
        closeClearanceModal();
        // Refresh profile to show updated clearance
        const profile = await loadProfile();
        if (profile) {
            displayProfile(profile);
        }
        // IMPORTANT: Reload documents with new clearance level
        console.log('[Clearance] Reloading documents with new clearance level:', clearanceLevel);
        await loadDocuments(profile);
    }, 2000);
}

// Show clearance verification error
function showClearanceError(title, message) {
    const waitingDiv = document.getElementById('clearanceVerificationWaiting');
    const loading = document.getElementById('clearanceVerificationLoading');
    const errorDiv = document.getElementById('clearanceVerificationError');
    const errorMsg = document.getElementById('clearanceErrorMessage');

    if (waitingDiv) waitingDiv.classList.add('hidden');
    if (loading) loading.classList.add('hidden');
    if (errorDiv) errorDiv.classList.remove('hidden');
    if (errorMsg) errorMsg.textContent = message;

    console.error('[Clearance]', title, ':', message);
}

// Reset clearance modal to initial state
function resetClearanceModal() {
    stopClearancePolling();
    currentVerificationId = null;
    clearancePollingStartTime = null;

    const content = document.getElementById('clearanceVerificationContent');
    const loading = document.getElementById('clearanceVerificationLoading');
    const success = document.getElementById('clearanceVerificationSuccess');
    const error = document.getElementById('clearanceVerificationError');
    const waitingDiv = document.getElementById('clearanceVerificationWaiting');

    if (content) content.classList.add('hidden'); // Hide dropdown content
    if (loading) loading.classList.add('hidden');
    if (success) success.classList.add('hidden');
    if (error) error.classList.add('hidden');
    if (waitingDiv) waitingDiv.classList.add('hidden');
}

// Close clearance modal
function closeClearanceModal() {
    stopClearancePolling();
    const modal = document.getElementById('clearanceVerificationModal');
    if (modal) {
        modal.classList.add('hidden');
        modal.style.display = 'none';
    }
    currentVerificationId = null;
    clearancePollingStartTime = null;
}

// Legacy function - kept for backwards compatibility but no longer used
async function submitClearanceVerification() {
    console.warn('[Clearance] submitClearanceVerification is deprecated - verification now happens via DIDComm');
}

// Display training status
function displayTrainingStatus(profile) {
    if (!profile || !profile.training) return;

    const training = profile.training;
    const now = new Date();
    const expiryDate = new Date(training.expiryDate);
    const daysUntilExpiry = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
    const isExpired = daysUntilExpiry < 0;
    const isWarning = daysUntilExpiry <= 30 && daysUntilExpiry >= 0;

    // Update status badge
    const statusBadge = document.getElementById('statusBadge');
    const statusTitle = document.getElementById('statusTitle');
    const statusDetail = document.getElementById('statusDetail');

    if (statusBadge && statusTitle && statusDetail) {
        if (isExpired) {
            statusBadge.classList.remove('valid');
            statusBadge.classList.add('expired');
            statusBadge.textContent = '✕';

            statusTitle.classList.remove('valid');
            statusTitle.classList.add('expired');
            statusTitle.textContent = 'CIS Training Expired';

            statusDetail.textContent = 'Your training certification has expired. Please renew.';
        } else if (isWarning) {
            statusBadge.classList.remove('expired');
            statusBadge.classList.add('valid');
            statusBadge.textContent = '⚠';

            statusTitle.classList.remove('expired');
            statusTitle.classList.add('valid');
            statusTitle.style.color = '#ed8936';
            statusTitle.textContent = 'CIS Training Expiring Soon';

            statusDetail.textContent = 'Your training certification expires soon. Please renew.';
        } else {
            statusBadge.classList.remove('expired');
            statusBadge.classList.add('valid');
            statusBadge.textContent = '✓';

            statusTitle.classList.remove('expired');
            statusTitle.classList.add('valid');
            statusTitle.style.color = '#38a169';
            statusTitle.textContent = 'CIS Training Valid';

            statusDetail.textContent = 'Your training certification is up to date';
        }
    }

    // Update expiry date
    const expiryDateEl = document.getElementById('expiryDate');
    if (expiryDateEl) {
        expiryDateEl.textContent = formatDate(training.expiryDate);
        if (isExpired) {
            expiryDateEl.classList.add('expired');
        } else if (isWarning) {
            expiryDateEl.classList.add('warning');
        }
    }

    // Update days until expiry
    const daysUntilExpiryEl = document.getElementById('daysUntilExpiry');
    if (daysUntilExpiryEl) {
        if (isExpired) {
            daysUntilExpiryEl.textContent = 'Expired';
            daysUntilExpiryEl.classList.add('expired');
        } else if (isWarning) {
            daysUntilExpiryEl.textContent = daysUntilExpiry;
            daysUntilExpiryEl.classList.add('warning');
        } else {
            daysUntilExpiryEl.textContent = daysUntilExpiry;
        }
    }
}

// Format DID for display (show first and last parts)
function formatDID(did) {
    if (!did) return 'Not assigned';

    // For PRISM DIDs, show full short form
    if (did.startsWith('did:prism:')) {
        return did;
    }

    // For other DIDs, truncate middle
    if (did.length > 60) {
        return `${did.substring(0, 30)}...${did.substring(did.length - 20)}`;
    }

    return did;
}

// Format date for display
function formatDate(dateString) {
    if (!dateString) return 'N/A';

    const date = new Date(dateString);
    const options = { year: 'numeric', month: 'short', day: 'numeric' };
    return date.toLocaleDateString('en-US', options);
}

// Copy to clipboard
async function copyToClipboard(elementId, buttonElement) {
    const element = document.getElementById(elementId);
    if (!element) return;

    const text = element.textContent.trim();

    try {
        await navigator.clipboard.writeText(text);

        // Update button to show success
        const originalText = buttonElement.textContent;
        buttonElement.textContent = 'Copied!';
        buttonElement.classList.add('copied');

        setTimeout(() => {
            buttonElement.textContent = originalText;
            buttonElement.classList.remove('copied');
        }, 2000);
    } catch (error) {
        console.error('Failed to copy:', error);
        showError('Failed to copy to clipboard');
    }
}

// Handle logout
async function handleLogout() {
    const token = getSessionToken();

    if (!token) {
        clearSession();
        window.location.href = '/company-admin/employee-portal-login.html';
        return;
    }

    showLoading(true);

    try {
        // Call logout endpoint
        await fetch(`${API_BASE}/auth/logout`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-session-token': token
            }
        });
    } catch (error) {
        console.error('Logout error:', error);
        // Continue with logout even if API call fails
    } finally {
        // Clear session and redirect
        clearSession();
        window.location.href = '/company-admin/employee-portal-login.html?message=logged_out';
    }
}

// View credentials (placeholder)
function viewCredentials() {
    showError('Credentials view coming soon! This feature will display all your verifiable credentials.');
}

// Load and display available documents
async function loadDocuments(profile) {
    if (!profile || !profile.employeeRoleVC) {
        console.log('[Documents] No EmployeeRole VC found');
        return;
    }

    // Extract issuerDID from EmployeeRole VC
    // The EmployeeRole VC should have issuerDID in credentialSubject
    const issuerDID = profile.employeeRoleVC.credentialSubject?.issuerDID;

    if (!issuerDID) {
        console.error('[Documents] issuerDID not found in EmployeeRole VC');
        showDocumentsError('Unable to load documents: missing company identifier');
        return;
    }

    console.log(`[Documents] Querying documents for issuerDID: ${issuerDID}`);

    try {
        // Pass session token to enable clearance-based filtering
        const sessionToken = getSessionToken();
        const response = await fetch(`/company-admin/api/documents/discover?issuerDID=${encodeURIComponent(issuerDID)}`, {
            headers: {
                'x-session-id': sessionToken || ''
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        console.log(`[Documents] API response:`, data.success, `documents count:`, data.documents?.length);

        if (data.success) {
            displayDocuments(data.documents || []);
        } else {
            throw new Error(data.message || 'Failed to load documents');
        }
    } catch (error) {
        console.error('[Documents] Error loading documents:', error);
        showDocumentsError(`Failed to load documents: ${error.message}`);
    }
}

function displayDocuments(documents) {
    const loadingEl = document.getElementById('documentsLoading');
    const listEl = document.getElementById('documentsList');
    const emptyEl = document.getElementById('documentsEmpty');

    // Hide loading
    if (loadingEl) loadingEl.classList.add('hidden');

    if (documents.length === 0) {
        if (emptyEl) emptyEl.classList.remove('hidden');
        return;
    }

    // Show documents list
    if (listEl) {
        listEl.classList.remove('hidden');
        listEl.innerHTML = documents.map(doc => {
            // Check if this is a classified document
            // Use SSI flow for: documents with sections, "classified" in DID, or non-INTERNAL
            const hasClassifiedSections = doc.sectionSummary?.totalSections > 0;
            const isClassifiedDoc = hasClassifiedSections ||
                doc.documentDID?.includes('classified') ||
                (doc.classificationLevel && doc.classificationLevel !== 'INTERNAL');
            const isDocx = doc.metadata?.sourceFormat === 'docx';
            const sectionInfo = hasClassifiedSections
                ? `<span title="${doc.sectionSummary.visibleCount} visible, ${doc.sectionSummary.redactedCount} redacted">📑 ${doc.sectionSummary.totalSections} sections</span>`
                : '';
            const formatBadge = isDocx ? '<span style="background:#4299e1;color:white;padding:2px 6px;border-radius:4px;font-size:10px;">DOCX</span>' : '';

            // For classified documents, use SSI-compliant wallet viewing
            // This creates ephemeral DID and issues DocumentCopy VC via DIDComm
            const viewAction = isClassifiedDoc
                ? `viewClassifiedDocument('${escapeHtml(doc.documentDID)}', '${escapeHtml(doc.title)}')`
                : `viewDocument('${escapeHtml(doc.documentDID)}')`;

            return `
            <div class="document-item">
                <div class="document-info">
                    <div class="document-title">${escapeHtml(doc.title)} ${formatBadge}</div>
                    <div class="document-meta">
                        <span class="classification-badge ${doc.classificationLevel}">
                            ${doc.classificationLevel}
                        </span>
                        ${doc.metadata?.category ? `<span>📁 ${escapeHtml(doc.metadata.category)}</span>` : ''}
                        ${doc.metadata?.version ? `<span>🔖 ${escapeHtml(doc.metadata.version)}</span>` : ''}
                        ${sectionInfo}
                    </div>
                </div>
                <div style="display: flex; gap: 8px;">
                    <button class="view-document-btn" onclick="${viewAction}">
                        ${isClassifiedDoc ? '📱 View in Wallet' : 'View'}
                    </button>
                </div>
            </div>
        `}).join('');
    }

    console.log(`[Documents] Displayed ${documents.length} document(s)`);
}

function showDocumentsError(message) {
    const loadingEl = document.getElementById('documentsLoading');
    const errorEl = document.getElementById('documentsError');

    if (loadingEl) loadingEl.classList.add('hidden');
    if (errorEl) {
        errorEl.textContent = message;
        errorEl.classList.remove('hidden');
    }
}

// ============================================================================
// PDF Viewer Modal Functions (In-Browser Viewing - No Download)
// ============================================================================

let currentBlobUrl = null;

// ============================================================================
// PDF.js Secure Viewer - No downloads allowed
// ============================================================================

let pdfDoc = null;
let pdfCurrentPage = 1;
let pdfTotalPages = 0;
let pdfScale = 1.5;

/**
 * Opens the PDF viewer modal with the given blob URL using PDF.js
 * @param {string} blobUrl - The blob URL of the PDF
 * @param {string} filename - The filename to display in the title
 */
async function openPdfViewer(blobUrl, filename) {
    const modal = document.getElementById('pdfViewerModal');
    const canvas = document.getElementById('pdfCanvas');
    const title = document.getElementById('pdfViewerTitle');

    if (!modal || !canvas || !title) {
        console.error('[PDF Viewer] Modal elements not found');
        alert('PDF viewer not available');
        return;
    }

    // Store for cleanup
    currentBlobUrl = blobUrl;

    // Set title
    title.textContent = filename || 'Document Viewer';

    // Show modal immediately with loading state
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    // Disable right-click on modal
    modal.addEventListener('contextmenu', preventContextMenu);

    // Disable keyboard shortcuts (Ctrl+S, Ctrl+P)
    document.addEventListener('keydown', preventSaveShortcuts);

    // Disable text selection on canvas
    canvas.style.userSelect = 'none';
    canvas.style.webkitUserSelect = 'none';

    console.log('[PDF Viewer] Loading PDF with PDF.js...');

    try {
        // Configure PDF.js worker
        if (typeof pdfjsLib !== 'undefined') {
            pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        } else {
            throw new Error('PDF.js library not loaded');
        }

        // Load the PDF document
        const loadingTask = pdfjsLib.getDocument(blobUrl);
        pdfDoc = await loadingTask.promise;
        pdfTotalPages = pdfDoc.numPages;
        pdfCurrentPage = 1;

        console.log(`[PDF Viewer] PDF loaded: ${pdfTotalPages} pages`);

        // Update page counter
        document.getElementById('totalPages').textContent = pdfTotalPages;
        document.getElementById('currentPage').textContent = pdfCurrentPage;

        // Render the first page
        await renderPdfPage(pdfCurrentPage);

    } catch (error) {
        console.error('[PDF Viewer] Error loading PDF:', error);
        alert('Failed to load PDF: ' + error.message);
        closePdfViewer();
    }
}

/**
 * Renders a specific page of the PDF
 * @param {number} pageNum - Page number to render
 */
async function renderPdfPage(pageNum) {
    if (!pdfDoc) {
        console.error('[PDF Viewer] No PDF document loaded');
        return;
    }

    const canvas = document.getElementById('pdfCanvas');
    const ctx = canvas.getContext('2d');

    try {
        const page = await pdfDoc.getPage(pageNum);

        // Calculate scale to fit container width while maintaining aspect ratio
        const container = document.querySelector('.pdf-viewer-container');
        const containerWidth = container.clientWidth - 40; // Account for padding
        const viewport = page.getViewport({ scale: 1 });

        // Scale to fit width, but cap at 1.5x for readability
        const fitScale = Math.min(containerWidth / viewport.width, 1.5);
        const scaledViewport = page.getViewport({ scale: fitScale });

        canvas.height = scaledViewport.height;
        canvas.width = scaledViewport.width;

        const renderContext = {
            canvasContext: ctx,
            viewport: scaledViewport
        };

        await page.render(renderContext).promise;

        // Update page counter
        document.getElementById('currentPage').textContent = pageNum;

        console.log(`[PDF Viewer] Rendered page ${pageNum}/${pdfTotalPages}`);

    } catch (error) {
        console.error('[PDF Viewer] Error rendering page:', error);
    }
}

/**
 * Navigate to previous page
 */
function pdfPrevPage() {
    if (pdfCurrentPage <= 1) return;
    pdfCurrentPage--;
    renderPdfPage(pdfCurrentPage);
}

/**
 * Navigate to next page
 */
function pdfNextPage() {
    if (pdfCurrentPage >= pdfTotalPages) return;
    pdfCurrentPage++;
    renderPdfPage(pdfCurrentPage);
}

/**
 * Closes the PDF viewer modal and cleans up resources
 */
function closePdfViewer() {
    const modal = document.getElementById('pdfViewerModal');
    const canvas = document.getElementById('pdfCanvas');

    if (!modal) {
        console.error('[PDF Viewer] Modal element not found');
        return;
    }

    // Clear canvas
    if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    // Reset PDF state
    pdfDoc = null;
    pdfCurrentPage = 1;
    pdfTotalPages = 0;

    // Hide modal
    modal.style.display = 'none';

    // Cleanup blob URL to free memory
    if (currentBlobUrl) {
        URL.revokeObjectURL(currentBlobUrl);
        console.log('[PDF Viewer] Blob URL revoked');
        currentBlobUrl = null;
    }

    // Remove event listeners
    modal.removeEventListener('contextmenu', preventContextMenu);
    document.removeEventListener('keydown', preventSaveShortcuts);

    // Restore body scroll
    document.body.style.overflow = '';

    console.log('[PDF Viewer] Modal closed');
}

/**
 * Prevents right-click context menu
 */
function preventContextMenu(e) {
    e.preventDefault();
    return false;
}

/**
 * Prevents save/print keyboard shortcuts
 */
function preventSaveShortcuts(e) {
    // Prevent Ctrl+S (save), Ctrl+P (print), Ctrl+Shift+S (save as)
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S' || e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        console.log('[PDF Viewer] Blocked save/print shortcut');
        return false;
    }
}

// Export functions for global access (onclick handlers in HTML)
window.closePdfViewer = closePdfViewer;
window.pdfPrevPage = pdfPrevPage;
window.pdfNextPage = pdfNextPage;

/**
 * Opens HTML document in a secure viewer modal
 * Renders HTML in a sandboxed iframe with security restrictions
 * @param {string} blobUrl - Blob URL of the HTML document
 * @param {string} filename - Filename for the title
 */
async function openHtmlViewer(blobUrl, filename) {
    const modal = document.getElementById('pdfViewerModal');
    const canvas = document.getElementById('pdfCanvas');
    const title = document.getElementById('pdfViewerTitle');
    const pageNav = document.querySelector('.pdf-page-nav');

    if (!modal || !canvas || !title) {
        console.error('[HTML Viewer] Modal elements not found');
        alert('HTML viewer not available');
        return;
    }

    // Store for cleanup
    currentBlobUrl = blobUrl;

    // Set title
    title.textContent = filename || 'Document Viewer (HTML)';

    // Hide canvas and page navigation (not needed for HTML)
    canvas.style.display = 'none';
    if (pageNav) pageNav.style.display = 'none';

    // Create iframe for HTML rendering
    let iframe = document.getElementById('htmlViewerIframe');
    if (!iframe) {
        iframe = document.createElement('iframe');
        iframe.id = 'htmlViewerIframe';
        iframe.style.cssText = `
            width: 100%;
            height: 80vh;
            border: none;
            background: white;
            border-radius: 4px;
        `;
        // Sandbox to restrict capabilities (no scripts, no forms, no downloads)
        iframe.sandbox = 'allow-same-origin';
        // Insert after canvas
        canvas.parentNode.insertBefore(iframe, canvas.nextSibling);
    }
    iframe.style.display = 'block';
    iframe.src = blobUrl;

    // Show modal
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    // Disable right-click on modal
    modal.addEventListener('contextmenu', preventContextMenu);

    // Disable keyboard shortcuts (Ctrl+S, Ctrl+P)
    document.addEventListener('keydown', preventSaveShortcuts);

    console.log('[HTML Viewer] HTML document displayed in iframe');
}

/**
 * Closes the HTML viewer (extends closePdfViewer)
 * Called automatically by closePdfViewer
 */
function closeHtmlViewerElements() {
    const iframe = document.getElementById('htmlViewerIframe');
    const canvas = document.getElementById('pdfCanvas');
    const pageNav = document.querySelector('.pdf-page-nav');

    // Hide iframe if present
    if (iframe) {
        iframe.src = 'about:blank';
        iframe.style.display = 'none';
    }

    // Restore canvas and page navigation visibility for next PDF
    if (canvas) canvas.style.display = 'block';
    if (pageNav) pageNav.style.display = 'flex';
}

// Extend closePdfViewer to handle HTML cleanup
const originalClosePdfViewer = closePdfViewer;
closePdfViewer = function() {
    closeHtmlViewerElements();
    originalClosePdfViewer();
};

// Re-export the extended function
window.closePdfViewer = closePdfViewer;
window.openHtmlViewer = openHtmlViewer;

/**
 * Opens DOCX document in a secure viewer modal using docx-preview library
 * @param {Blob} blob - Blob containing the DOCX document
 * @param {string} filename - Filename for the title
 */
async function openDocxViewer(blob, filename) {
    const modal = document.getElementById('pdfViewerModal');
    const canvas = document.getElementById('pdfCanvas');
    const docxContainer = document.getElementById('docxViewerContainer');
    const title = document.getElementById('pdfViewerTitle');
    const pageNav = document.querySelector('.pdf-page-nav');
    const pageInfo = document.getElementById('pdfPageInfo');

    if (!modal || !docxContainer || !title) {
        console.error('[DOCX Viewer] Modal elements not found');
        alert('DOCX viewer not available');
        return;
    }

    // Set title
    title.textContent = filename || 'Document Viewer (DOCX)';

    // Hide PDF elements
    if (canvas) canvas.style.display = 'none';
    if (pageNav) pageNav.style.display = 'none';
    if (pageInfo) pageInfo.style.display = 'none';

    // Show DOCX container
    docxContainer.style.display = 'block';
    docxContainer.innerHTML = '<div style="text-align: center; padding: 40px; color: #666;">Loading document...</div>';

    // Show modal
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    // Disable right-click on modal
    modal.addEventListener('contextmenu', preventContextMenu);

    // Disable keyboard shortcuts (Ctrl+S, Ctrl+P)
    document.addEventListener('keydown', preventSaveShortcuts);

    console.log('[DOCX Viewer] Rendering DOCX document...');

    try {
        // Check if docx-preview is available
        if (typeof docx === 'undefined' || typeof docx.renderAsync !== 'function') {
            throw new Error('docx-preview library not loaded');
        }

        // Clear container
        docxContainer.innerHTML = '';

        // Render DOCX using docx-preview
        await docx.renderAsync(blob, docxContainer, null, {
            className: 'docx-viewer-content',
            inWrapper: true,
            ignoreWidth: false,
            ignoreHeight: false,
            ignoreFonts: false,
            breakPages: true,
            ignoreLastRenderedPageBreak: true,
            experimental: false,
            trimXmlDeclaration: true,
            useBase64URL: true,
            renderHeaders: true,
            renderFooters: true,
            renderFootnotes: true,
            renderEndnotes: true
        });

        console.log('[DOCX Viewer] DOCX document rendered successfully');

        // Add some styling to make it look better
        const style = document.createElement('style');
        style.textContent = `
            .docx-viewer-content {
                font-family: 'Calibri', 'Arial', sans-serif;
                line-height: 1.5;
            }
            .docx-viewer-content p {
                margin: 0 0 10px 0;
            }
            .docx-viewer-content table {
                border-collapse: collapse;
                width: 100%;
            }
            .docx-viewer-content table td,
            .docx-viewer-content table th {
                border: 1px solid #ddd;
                padding: 8px;
            }
            #docxViewerContainer {
                user-select: none;
                -webkit-user-select: none;
            }
        `;
        docxContainer.appendChild(style);

    } catch (error) {
        console.error('[DOCX Viewer] Error rendering DOCX:', error);
        docxContainer.innerHTML = `
            <div style="text-align: center; padding: 40px; color: #e53e3e;">
                <h3>Failed to render document</h3>
                <p>${error.message}</p>
                <p style="margin-top: 20px; color: #666;">
                    The document format may not be supported or the file may be corrupted.
                </p>
            </div>
        `;
    }
}

/**
 * Cleanup DOCX viewer elements when closing modal
 */
function closeDocxViewerElements() {
    const docxContainer = document.getElementById('docxViewerContainer');
    const canvas = document.getElementById('pdfCanvas');
    const pageInfo = document.getElementById('pdfPageInfo');

    // Clear and hide DOCX container
    if (docxContainer) {
        docxContainer.innerHTML = '';
        docxContainer.style.display = 'none';
    }

    // Restore PDF elements visibility for next view
    if (canvas) canvas.style.display = 'block';
    if (pageInfo) pageInfo.style.display = 'block';
}

// Extend closePdfViewer to also handle DOCX cleanup
const originalClosePdfViewerForDocx = closePdfViewer;
closePdfViewer = function() {
    closeDocxViewerElements();
    originalClosePdfViewerForDocx();
};

// Export DOCX viewer function
window.closePdfViewer = closePdfViewer;
window.openDocxViewer = openDocxViewer;

// ============================================================================

/**
 * View/Download a document using the wallet postMessage bridge
 *
 * This function uses ephemeral DID document access control:
 * 1. Opens/focuses the Alice Wallet window
 * 2. Sends DOCUMENT_ACCESS_REQUEST via postMessage
 * 3. Wallet generates ephemeral X25519 keypair (perfect forward secrecy)
 * 4. Wallet signs request with Ed25519 key (non-repudiation)
 * 5. Wallet fetches & decrypts document from Company Admin Portal
 * 6. Wallet sends decrypted document back via DOCUMENT_ACCESS_RESPONSE
 * 7. Display PDF via blob URL
 *
 * @param {string} documentDID - The PRISM DID of the document
 */
async function viewDocument(documentDID) {
    console.log(`[Documents] View document via wallet bridge: ${documentDID}`);

    // NOTE: Clearance level is now handled server-side from the VP-verified session
    // The client no longer sends clearance level - this is a security improvement

    try {
        // Show loading state
        showLoading(true);

        // Ensure wallet is open
        await ensureWalletOpen();

        // Request document access via wallet (clearance verified server-side)
        console.log(`[Documents] Requesting document access (clearance verified server-side)`);
        const { documentBlob, filename, mimeType } = await requestDocumentAccess(documentDID);

        // Create blob URL and display document
        console.log(`[Documents] Received document: ${filename}, mimeType: ${mimeType}, size: ${documentBlob.byteLength || documentBlob.length} bytes`);

        // Convert ArrayBuffer/Array to Blob if needed
        // IMPORTANT: documentBlob from postMessage is a plain array of numbers (from Array.from(Uint8Array))
        // The Blob constructor needs Uint8Array to treat it as binary, not convert array to string
        const blob = documentBlob instanceof Blob
            ? documentBlob
            : new Blob([new Uint8Array(documentBlob)], { type: mimeType || 'application/octet-stream' });

        // Handle different content types
        const DOCX_MIMETYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

        if (mimeType === 'text/html' || mimeType === 'text/htm') {
            // Open HTML documents in an iframe within the modal
            const blobUrl = URL.createObjectURL(blob);
            openHtmlViewer(blobUrl, filename);
            console.log('[Documents] HTML document displayed in modal viewer');
        } else if (mimeType === 'application/pdf') {
            // Open PDF documents in PDF.js viewer
            const blobUrl = URL.createObjectURL(blob);
            openPdfViewer(blobUrl, filename);
            console.log('[Documents] PDF document displayed in modal viewer');
        } else if (mimeType === DOCX_MIMETYPE || mimeType === 'application/msword' || filename?.toLowerCase().endsWith('.docx') || filename?.toLowerCase().endsWith('.doc')) {
            // Open DOCX documents using docx-preview library
            // Note: docx-preview needs the Blob, not the blob URL
            console.log('[Documents] Opening DOCX document with docx-preview');
            await openDocxViewer(blob, filename);
            console.log('[Documents] DOCX document displayed in modal viewer');
        } else {
            // For other document types, try PDF viewer first (may work for images)
            // If it fails, show download option
            console.log(`[Documents] Unknown mimeType ${mimeType}, attempting PDF viewer`);
            const blobUrl = URL.createObjectURL(blob);
            openPdfViewer(blobUrl, filename);
        }

    } catch (error) {
        console.error('[Documents] Error viewing document:', error);

        // Check for already-accessed error (view-once restriction)
        if (error.message && error.message.includes('already been viewed')) {
            showError('This document has already been viewed. Contact your administrator to request re-access.');
        } else {
            showError(`Failed to view document: ${error.message}`);
        }
    } finally {
        showLoading(false);
    }
}

/**
 * DEPRECATED: Map clearance level string to numeric value
 *
 * NOTE: This function is no longer used. Clearance level mapping is now handled
 * server-side using ReEncryptionService.getLevelNumber() which uses correct 1-indexed values:
 *   INTERNAL: 1, CONFIDENTIAL: 2, RESTRICTED: 3, TOP-SECRET: 4
 *
 * The client no longer sends clearance level - the server extracts it from the
 * VP-verified session to prevent clearance level spoofing attacks.
 *
 * @deprecated Use server-side session clearance instead
 */
function mapClearanceToNumeric(level) {
    console.warn('[DEPRECATED] mapClearanceToNumeric() is no longer used. Clearance is verified server-side.');
    const levelMap = {
        'INTERNAL': 1,
        'CONFIDENTIAL': 2,
        'RESTRICTED': 3,
        'TOP-SECRET': 4
    };
    return levelMap[level] || 1;
}

/**
 * LEGACY: View document via direct proxy (fallback method)
 * Use viewDocument() instead - this is kept for backwards compatibility
 */
async function viewDocumentViaProxy(documentDID) {
    console.log(`[Documents] LEGACY: View document via proxy: ${documentDID}`);

    try {
        // Use server-side proxy endpoint to download document
        // The proxy extracts file info from the PRISM DID and makes proper POST request to Iagon
        const proxyUrl = `/company-admin/api/documents/download-by-did/${encodeURIComponent(documentDID)}`;

        console.log(`[Documents] Using proxy endpoint: ${proxyUrl}`);

        // Open the document in a new tab via the proxy
        window.open(proxyUrl, '_blank');

        console.log('[Documents] Document download initiated via proxy');

    } catch (error) {
        console.error('[Documents] Error viewing document:', error);
        showError(`Failed to view document: ${error.message}`);
    }
}

/**
 * Extract Iagon download URL from a long-form PRISM DID
 *
 * The DID contains base64url-encoded protobuf state which includes service endpoints.
 * We look for the "iagon-storage" service to get the download URL.
 *
 * @param {string} prismDID - The long-form PRISM DID
 * @returns {string|null} The Iagon download URL or null if not found
 */
function extractIagonUrlFromPrismDID(prismDID) {
    try {
        // Split the DID into its parts
        // Format: did:prism:[stateHash]:[encodedState]
        const parts = prismDID.split(':');

        if (parts.length < 4) {
            console.log('[Documents] Short-form DID, no embedded state');
            return null;
        }

        // The last part is the base64url-encoded state
        const encodedState = parts[parts.length - 1];
        console.log('[Documents] Encoded state length:', encodedState.length);

        // Base64url decode
        const base64 = encodedState
            .replace(/-/g, '+')
            .replace(/_/g, '/');

        // Add padding if needed
        const padding = base64.length % 4;
        const paddedBase64 = padding > 0
            ? base64 + '='.repeat(4 - padding)
            : base64;

        // Decode to binary
        const binaryStr = atob(paddedBase64);

        // Look for Iagon URL patterns in the decoded data
        // The URL is embedded as a JSON array string in the service endpoint
        // Pattern: ["https://gw.iagon.com/api/v2/download?..."]

        // Search for the Iagon URL pattern
        const iagonPattern = /https:\/\/gw\.iagon\.com\/api\/v2\/download\?[^"\]]+/g;
        const matches = binaryStr.match(iagonPattern);

        if (matches && matches.length > 0) {
            console.log('[Documents] Found Iagon URL in DID state:', matches[0]);
            return matches[0];
        }

        // Alternative pattern: look for gw.v2.iagon.com
        const iagonV2Pattern = /https:\/\/gw\.v2\.iagon\.com\/api\/v2\/storage\/download[^"\]]+/g;
        const v2Matches = binaryStr.match(iagonV2Pattern);

        if (v2Matches && v2Matches.length > 0) {
            console.log('[Documents] Found Iagon v2 URL in DID state:', v2Matches[0]);
            return v2Matches[0];
        }

        console.log('[Documents] No Iagon URL pattern found in DID state');
        console.log('[Documents] Decoded state preview:', binaryStr.substring(0, 200));

        return null;

    } catch (error) {
        console.error('[Documents] Error parsing PRISM DID:', error);
        return null;
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// File upload helper functions
function updateFileDisplay(input) {
    const file = input.files[0];
    const selectedFileInfo = document.getElementById('selectedFileInfo');
    const fileDisplayText = document.getElementById('fileDisplayText');
    const selectedFileName = document.getElementById('selectedFileName');
    const selectedFileSize = document.getElementById('selectedFileSize');

    if (file) {
        // Validate file size (max 40MB)
        const maxSize = 40 * 1024 * 1024; // 40MB in bytes
        if (file.size > maxSize) {
            showError('File size exceeds maximum limit of 40MB');
            input.value = '';
            return;
        }

        // Show file info
        selectedFileName.textContent = file.name;
        selectedFileSize.textContent = formatFileSize(file.size);
        selectedFileInfo.style.display = 'block';
        fileDisplayText.textContent = 'File selected';
    } else {
        clearFileSelection();
    }
}

function clearFileSelection() {
    const input = document.getElementById('documentFile');
    const selectedFileInfo = document.getElementById('selectedFileInfo');
    const fileDisplayText = document.getElementById('fileDisplayText');

    if (input) input.value = '';
    if (selectedFileInfo) selectedFileInfo.style.display = 'none';
    if (fileDisplayText) fileDisplayText.textContent = 'Click to select file or drag and drop';
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Handle document creation form submission (with optional file upload)
async function handleCreateDocument(event) {
    event.preventDefault();

    const token = getSessionToken();
    if (!token) {
        showError('Session expired. Please log in again.');
        return;
    }

    // Get form data
    const form = event.target;
    const title = form.title.value.trim();
    const description = form.description ? form.description.value.trim() : '';
    const classificationLevel = form.classificationLevel.value;
    const documentType = form.documentType ? form.documentType.value : '';

    // Get file input (optional)
    const fileInput = form.querySelector('input[type="file"]');
    const file = fileInput && fileInput.files.length > 0 ? fileInput.files[0] : null;

    // Get selected releasability checkboxes
    const releasableToCheckboxes = form.querySelectorAll('input[name="releasableTo"]:checked');
    const releasableTo = Array.from(releasableToCheckboxes).map(cb => cb.value);

    // Validation
    if (!title) {
        showError('Document title is required');
        return;
    }

    if (!classificationLevel) {
        showError('Classification level is required');
        return;
    }

    if (!documentType) {
        showError('Document type is required');
        return;
    }

    if (releasableTo.length === 0) {
        showError('Please select at least one company for releasability');
        return;
    }

    // File size validation (max 40MB for Iagon)
    if (file && file.size > 40 * 1024 * 1024) {
        showError('File size exceeds maximum limit of 40MB');
        return;
    }

    // Hide any previous messages
    const successDiv = document.getElementById('documentCreationSuccess');
    const errorDiv = document.getElementById('documentCreationError');
    if (successDiv) successDiv.classList.add('hidden');
    if (errorDiv) errorDiv.classList.add('hidden');

    // Disable submit button and show loading state
    const submitBtn = document.getElementById('createDocumentBtn');
    const originalBtnText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = file ? 'Uploading to Iagon...' : 'Creating Document DID...';

    try {
        console.log('[Documents] Creating document:', { title, documentType, classificationLevel, releasableTo, hasFile: !!file });

        let response;
        let data;

        if (file) {
            // Use file upload endpoint with FormData
            const formData = new FormData();
            formData.append('file', file);
            formData.append('title', title);
            formData.append('description', description);
            formData.append('classificationLevel', classificationLevel);
            formData.append('documentType', documentType);
            formData.append('releasableTo', JSON.stringify(releasableTo));

            response = await fetch(`${API_BASE}/documents/upload`, {
                method: 'POST',
                headers: {
                    'x-session-token': token
                    // Don't set Content-Type - browser will set multipart/form-data with boundary
                },
                body: formData
            });
        } else {
            // Use original JSON endpoint (no file)
            response = await fetch(`${API_BASE}/documents/create`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-session-token': token
                },
                body: JSON.stringify({
                    title,
                    description,
                    classificationLevel,
                    documentType,
                    releasableTo
                })
            });
        }

        data = await response.json();

        if (!response.ok) {
            throw new Error(data.message || `HTTP ${response.status}: ${response.statusText}`);
        }

        if (data.success) {
            // Build success message
            let successMessage = `Document DID created successfully: ${data.documentDID.substring(0, 30)}...`;
            if (data.iagonStorage) {
                successMessage += ` (Stored on Iagon)`;
            }

            // Show success message
            const successMessageEl = document.getElementById('successMessage');
            if (successMessageEl) {
                successMessageEl.textContent = successMessage;
            }
            if (successDiv) successDiv.classList.remove('hidden');

            // Reset form
            form.reset();

            // Reload documents list to show new document
            const cachedProfile = localStorage.getItem('employee_profile');
            if (cachedProfile) {
                const profile = JSON.parse(cachedProfile);
                await loadDocuments(profile);
            }

            console.log('[Documents] Document created successfully:', data.documentDID);
            if (data.iagonStorage) {
                console.log('[Documents] Iagon storage:', data.iagonStorage.url);
            }
        } else {
            throw new Error(data.message || 'Failed to create document');
        }

    } catch (error) {
        console.error('[Documents] Error creating document:', error);

        // Show error message
        const errorMessageEl = document.getElementById('errorMessage');
        if (errorMessageEl) {
            errorMessageEl.textContent = error.message || 'An unexpected error occurred';
        }
        if (errorDiv) errorDiv.classList.remove('hidden');

    } finally {
        // Re-enable submit button
        submitBtn.disabled = false;
        submitBtn.textContent = originalBtnText;
    }
}

// Initialize dashboard
async function initializeDashboard() {
    // Check authentication
    if (!checkAuthentication()) {
        return;
    }

    showLoading(true);

    try {
        // Load profile from API
        const profile = await loadProfile();

        if (!profile) {
            throw new Error('Failed to load profile');
        }

        // Display profile and training status
        displayProfile(profile);
        displayTrainingStatus(profile);

        // Load and display available documents
        await loadDocuments(profile);

    } catch (error) {
        console.error('Dashboard initialization error:', error);
        showError('Failed to initialize dashboard. Please refresh the page.');
    } finally {
        showLoading(false);
    }
}

// Check for session expiry message
function checkSessionExpiry() {
    const urlParams = new URLSearchParams(window.location.search);
    const error = urlParams.get('error');

    if (error === 'session_expired') {
        showError('Your session has expired. Please log in again.');
    }
}

// Auto-refresh profile periodically (every 5 minutes)
function startAutoRefresh() {
    setInterval(async () => {
        const token = getSessionToken();
        if (token) {
            console.log('Auto-refreshing profile...');
            const profile = await loadProfile();
            if (profile) {
                displayProfile(profile);
                displayTrainingStatus(profile);
            }
        }
    }, 5 * 60 * 1000); // 5 minutes
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    checkSessionExpiry();
    initializeDashboard();
    startAutoRefresh();
    updateWalletSelectorUI();  // Initialize wallet selector
});

// Handle browser back/forward buttons
window.addEventListener('popstate', () => {
    if (!checkAuthentication()) {
        return;
    }
    initializeDashboard();
});

// ============================================================================
// WALLET BRIDGE COMMUNICATION (Ephemeral DID Document Access)
// ============================================================================

// Wallet window reference for postMessage communication
let walletWindow = null;
let walletReady = false;
let pendingDocumentRequests = new Map(); // requestId -> { resolve, reject, timeout }

// Wallet configuration (stored in localStorage)
const DEFAULT_WALLET_PATH = '/wallet';  // IDL wallet as default

function getCurrentWalletPath() {
    return localStorage.getItem('selectedWalletPath') || DEFAULT_WALLET_PATH;
}

function getWalletUrl() {
    const path = getCurrentWalletPath();
    return window.location.hostname === 'localhost'
        ? `http://localhost:3001${path}`
        : `https://identuslabel.cz${path}`;
}

function getWalletOrigin() {
    return window.location.hostname === 'localhost'
        ? 'http://localhost:3001'
        : 'https://identuslabel.cz';
}

function setWalletPath(path) {
    localStorage.setItem('selectedWalletPath', path);
    // Close existing wallet window if open
    if (walletWindow && !walletWindow.closed) {
        walletWindow.close();
    }
    walletWindow = null;
    walletReady = false;
    updateWalletSelectorUI();
}

function updateWalletSelectorUI() {
    const currentPath = getCurrentWalletPath();
    document.querySelectorAll('.wallet-option').forEach(el => {
        el.classList.toggle('active', el.dataset.path === currentPath);
    });
    const customInput = document.getElementById('customWalletPath');
    if (customInput) {
        customInput.value = currentPath;
    }
    const display = document.getElementById('currentWalletDisplay');
    if (display) {
        display.textContent = getWalletUrl();
    }
}

// Listen for messages from wallet
window.addEventListener('message', (event) => {
    // Validate origin
    if (event.origin !== getWalletOrigin()) {
        console.log('[WalletBridge] Ignoring message from unknown origin:', event.origin);
        return;
    }

    const data = event.data;

    // Ignore messages without a type (browser extensions, etc.)
    if (!data || !data.type) {
        return;
    }

    console.log('[WalletBridge] Received message:', data.type);

    switch (data.type) {
        case 'WALLET_READY':
            console.log('[WalletBridge] Wallet is ready');
            walletReady = true;
            break;

        case 'PONG':
            console.log('[WalletBridge] Wallet responded to ping');
            walletReady = true;
            break;

        case 'DOCUMENT_ACCESS_RESPONSE':
            handleDocumentAccessResponse(data);
            break;

        default:
            // Ignore other message types
            break;
    }
});

/**
 * Handle document access response from wallet
 */
function handleDocumentAccessResponse(data) {
    const { requestId, success, documentBlob, filename, mimeType, error, message } = data;

    const pending = pendingDocumentRequests.get(requestId);
    if (!pending) {
        console.warn('[WalletBridge] Received response for unknown request:', requestId);
        return;
    }

    // Clear timeout
    if (pending.timeout) {
        clearTimeout(pending.timeout);
    }

    // Remove from pending
    pendingDocumentRequests.delete(requestId);

    // Check for documentBlob existence (wallet may not send 'success' field)
    if (documentBlob && documentBlob.length > 0) {
        console.log('[WalletBridge] Document access granted:', filename, 'mimeType:', mimeType);
        pending.resolve({ documentBlob, filename, mimeType: mimeType || 'application/octet-stream' });
    } else {
        console.error('[WalletBridge] Document access denied:', error || 'No document data', message || '');
        pending.reject(new Error(message || error || 'Document access denied'));
    }
}

/**
 * Wait for wallet window to be ready
 */
async function waitForWalletReady(timeout = 30000) {
    return new Promise((resolve, reject) => {
        if (walletReady) {
            resolve();
            return;
        }

        const startTime = Date.now();

        const checkInterval = setInterval(() => {
            if (walletReady) {
                clearInterval(checkInterval);
                resolve();
                return;
            }

            // Try pinging the wallet
            if (walletWindow && !walletWindow.closed) {
                walletWindow.postMessage({
                    type: 'PING',
                    source: 'employee-portal',
                    timestamp: Date.now()
                }, getWalletOrigin());
            }

            // Check timeout
            if (Date.now() - startTime > timeout) {
                clearInterval(checkInterval);
                reject(new Error('Wallet did not respond in time. Please ensure your wallet is open and logged in.'));
            }
        }, 1000);
    });
}

/**
 * Open wallet window if not already open
 */
async function ensureWalletOpen() {
    // Check if wallet window exists and is open
    if (walletWindow && !walletWindow.closed) {
        // Window exists, focus it
        walletWindow.focus();
        return;
    }

    // Open new wallet window
    console.log('[WalletBridge] Opening wallet window:', getWalletUrl());
    walletWindow = window.open(getWalletUrl(), 'alice-wallet', 'width=1200,height=800');
    walletReady = false;

    if (!walletWindow) {
        throw new Error('Could not open wallet window. Please check your popup blocker settings.');
    }

    // Wait for wallet to be ready
    await waitForWalletReady();
}

/**
 * Request document access via wallet postMessage bridge
 * This uses ephemeral keys for perfect forward secrecy
 *
 * NOTE: clearanceLevel is no longer sent - server uses VP-verified session clearance
 * This is a security improvement to prevent clients from spoofing clearance levels
 */
async function requestDocumentAccess(documentDID) {
    const requestId = crypto.randomUUID();

    return new Promise((resolve, reject) => {
        // Set timeout for request (60 seconds)
        const timeout = setTimeout(() => {
            pendingDocumentRequests.delete(requestId);
            reject(new Error('Document access request timed out'));
        }, 60000);

        // Store pending request
        pendingDocumentRequests.set(requestId, { resolve, reject, timeout });

        // Send request to wallet (clearance verified server-side from session)
        // Include sessionToken so wallet can authenticate with server
        const sessionToken = getSessionToken();
        console.log('[WalletBridge] Sending document access request:', requestId, 'with session:', sessionToken ? 'present' : 'missing');
        walletWindow.postMessage({
            type: 'DOCUMENT_ACCESS_REQUEST',
            requestId,
            documentDID,
            sessionToken,  // Pass session token for server authentication
            // NOTE: clearanceLevel removed - server uses session-verified clearance
            timestamp: Date.now()
        }, getWalletOrigin());
    });
}

// ============================================================================
// Classified Document Viewing via Wallet (Ephemeral DID with TTL)
// ============================================================================

/**
 * View a classified document via the wallet (SSI-compliant)
 *
 * Flow (Dec 13, 2025 - Server creates ephemeral DID):
 * 1. Open wallet and send SSI_DOCUMENT_DOWNLOAD_REQUEST
 * 2. Wallet calls prepare-download → server creates ephemeral DID
 * 3. Wallet generates X25519 keypair and calls complete-download
 * 4. Server encrypts document and issues DocumentCopy VC via DIDComm
 * 5. Document is ready for viewing in wallet
 *
 * @param {string} documentDID - Document's DID
 * @param {string} title - Document title for display
 */
async function viewClassifiedDocument(documentDID, title) {
    console.log('[ViewClassified] Starting SSI-compliant view flow:', documentDID);

    // Show loading modal
    showViewingProgress('Connecting to wallet...', 10);

    try {
        const sessionToken = getSessionToken();
        if (!sessionToken) {
            throw new Error('Not authenticated. Please log in again.');
        }

        // Ensure wallet window is open
        await ensureWalletOpen();

        // Wait for wallet to be ready
        showViewingProgress('Waiting for wallet...', 20);
        await waitForWalletReady();

        // Use SSI flow via wallet - server creates ephemeral DID and issues VC
        showViewingProgress('Preparing SSI document delivery...', 30);

        const result = await requestWalletDocumentDownload({
            documentDID,
            title,
            sessionId: sessionToken,
            serverBaseUrl: window.location.origin + '/company-admin'
        });

        console.log('[ViewClassified] SSI flow completed:', {
            ephemeralDID: result.ephemeralDID,
            expiresAt: result.expiresAt,
            credentialOfferId: result.credentialOfferId
        });

        showViewingProgress('DocumentCopy VC issued!', 100);

        // Show success notification
        setTimeout(() => {
            hideViewingProgress();
            // Show info about VC delivery
            alert(`✅ Document ready!\n\nEphemeral DID: ${result.ephemeralDID?.substring(0, 40)}...\nExpires: ${new Date(result.expiresAt).toLocaleString()}\n\n${result.message}`);
        }, 1000);

    } catch (error) {
        console.error('[ViewClassified] Error:', error);
        hideViewingProgress();
        showError(`Failed to view document: ${error.message}`);
    }
}

/**
 * Show viewing progress modal
 */
function showViewingProgress(message, percent) {
    let modal = document.getElementById('viewingProgressModal');
    if (!modal) {
        // Create modal if it doesn't exist
        modal = document.createElement('div');
        modal.id = 'viewingProgressModal';
        modal.style.cssText = `
            position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.7); display: flex; align-items: center;
            justify-content: center; z-index: 10000;
        `;
        modal.innerHTML = `
            <div style="background: white; padding: 30px 50px; border-radius: 12px; text-align: center; min-width: 300px;">
                <div style="font-size: 40px; margin-bottom: 15px;">📄</div>
                <div id="viewingProgressMessage" style="font-size: 16px; font-weight: 500; margin-bottom: 15px;"></div>
                <div style="background: #e2e8f0; border-radius: 10px; height: 8px; overflow: hidden;">
                    <div id="viewingProgressBar" style="background: linear-gradient(90deg, #667eea, #764ba2); height: 100%; transition: width 0.3s;"></div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }

    document.getElementById('viewingProgressMessage').textContent = message;
    document.getElementById('viewingProgressBar').style.width = `${percent}%`;
    modal.style.display = 'flex';
}

/**
 * Hide viewing progress modal
 */
function hideViewingProgress() {
    const modal = document.getElementById('viewingProgressModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

/**
 * Request wallet to open and display a document
 * @param {string} ephemeralDID - The ephemeral DID of the document copy
 * @param {string} title - Document title
 * @param {object} sourceInfo - Document source info (format, contentType)
 */
async function openDocumentInWallet(ephemeralDID, title, sourceInfo) {
    return new Promise((resolve, reject) => {
        const requestId = crypto.randomUUID();

        // Set timeout (30 seconds)
        const timeout = setTimeout(() => {
            reject(new Error('Wallet did not respond'));
        }, 30000);

        // Listen for response
        const handler = (event) => {
            if (event.origin !== getWalletOrigin()) return;
            if (event.data?.type === 'DOCUMENT_VIEWER_OPENED' && event.data?.requestId === requestId) {
                clearTimeout(timeout);
                window.removeEventListener('message', handler);
                resolve(true);
            }
        };
        window.addEventListener('message', handler);

        // Send open document request to wallet
        if (walletWindow && !walletWindow.closed) {
            walletWindow.postMessage({
                type: 'OPEN_DOCUMENT',
                requestId,
                ephemeralDID,
                title,
                sourceInfo,
                timestamp: Date.now()
            }, getWalletOrigin());

            // Focus wallet window
            walletWindow.focus();
        } else {
            // Open wallet with document parameter
            const walletUrl = `${getWalletOrigin()}/my-documents?open=${encodeURIComponent(ephemeralDID)}`;
            walletWindow = window.open(walletUrl, 'alice-wallet');

            if (walletWindow) {
                // Consider it success if window opened
                clearTimeout(timeout);
                window.removeEventListener('message', handler);
                resolve(true);
            } else {
                clearTimeout(timeout);
                window.removeEventListener('message', handler);
                reject(new Error('Could not open wallet. Please check popup blocker settings.'));
            }
        }
    });
}

// Export for global access
window.viewClassifiedDocument = viewClassifiedDocument;

// ============================================================================
// Download to Wallet - Classified Documents with Redaction
// ============================================================================

/**
 * Download a classified document to the user's wallet (SSI-compliant)
 *
 * Uses two-step process where wallet creates ephemeral DID:
 * 1. Dashboard requests download via wallet
 * 2. Wallet creates ephemeral DID via Employee CA (8300)
 * 3. Wallet completes download with server
 * 4. Server issues DocumentCopy VC via DIDComm
 *
 * @param {string} documentDID - Document's DID
 * @param {string} title - Document title for display
 */
async function downloadToWallet(documentDID, title) {
    console.log('[DownloadToWallet] Starting SSI-compliant download:', documentDID);

    // Show loading state
    const btn = event.target;
    const originalText = btn.innerHTML;
    btn.innerHTML = '⏳ Preparing...';
    btn.disabled = true;

    try {
        const sessionToken = getSessionToken();
        if (!sessionToken) {
            throw new Error('Not authenticated. Please log in again.');
        }

        // Ensure wallet window is open
        if (!walletWindow || walletWindow.closed) {
            walletWindow = window.open(
                `${getWalletOrigin()}/my-documents`,
                'identus-wallet',
                'width=600,height=800'
            );

            // Wait for wallet to initialize
            await new Promise(resolve => setTimeout(resolve, 3000));
        }

        btn.innerHTML = '⏳ Wallet creating DID...';

        // Request wallet to perform SSI-compliant document download
        // Wallet will:
        // 1. Call prepare-download endpoint
        // 2. Create ephemeral DID via Employee CA (8300)
        // 3. Call complete-download endpoint with ephemeral DID + public key
        // 4. Receive DocumentCopy VC via DIDComm
        const result = await requestWalletDocumentDownload({
            documentDID,
            title,
            sessionId: sessionToken,
            serverBaseUrl: window.location.origin + '/company-admin'
        });

        if (result.success) {
            // Success!
            btn.innerHTML = '✅ Sent to Wallet';
            btn.style.background = '#48bb78';

            // Show success message
            alert(`Document "${title}" download initiated.\n\n${result.message}\n\nThe DocumentCopy credential will be delivered to your wallet via DIDComm.\n\nOpen your wallet's "My Documents" page to view it.`);

            // Reset button after 3 seconds
            setTimeout(() => {
                btn.innerHTML = originalText;
                btn.style.background = '#9f7aea';
                btn.disabled = false;
            }, 3000);
        }

    } catch (error) {
        console.error('[DownloadToWallet] Error:', error);
        btn.innerHTML = '❌ Failed';
        btn.style.background = '#fc8181';
        alert(`Failed to download document: ${error.message}`);

        // Reset button after 2 seconds
        setTimeout(() => {
            btn.innerHTML = originalText;
            btn.style.background = '#9f7aea';
            btn.disabled = false;
        }, 2000);
    }
}

/**
 * Request wallet to perform SSI-compliant document download
 * The wallet creates the ephemeral DID and handles the two-step process
 *
 * @param {Object} params - Download parameters
 * @returns {Promise<Object>} Download result
 */
async function requestWalletDocumentDownload(params) {
    return new Promise((resolve, reject) => {
        const requestId = 'ssi-download-' + Date.now();
        const timeout = setTimeout(() => {
            window.removeEventListener('message', handler);
            reject(new Error('Wallet did not respond. Please ensure your wallet is open and has an Enterprise configuration.'));
        }, 60000); // 60 seconds timeout for SSI operations

        const handler = (event) => {
            // Check origin
            if (event.origin !== getWalletOrigin()) return;
            if (event.data?.requestId !== requestId) return;

            window.removeEventListener('message', handler);
            clearTimeout(timeout);

            if (event.data.type === 'SSI_DOCUMENT_DOWNLOAD_RESPONSE') {
                if (event.data.success) {
                    resolve({
                        success: true,
                        ephemeralDID: event.data.ephemeralDID,
                        credentialOfferId: event.data.credentialOfferId,
                        expiresAt: event.data.expiresAt,
                        message: event.data.message || 'DocumentCopy VC will be delivered via DIDComm'
                    });
                } else {
                    reject(new Error(event.data.error || 'Wallet failed to download document'));
                }
            }
        };

        window.addEventListener('message', handler);

        // Send request to wallet
        console.log('[DownloadToWallet] Sending SSI download request to wallet:', params.documentDID);
        walletWindow.postMessage({
            type: 'SSI_DOCUMENT_DOWNLOAD_REQUEST',
            requestId,
            documentDID: params.documentDID,
            title: params.title,
            sessionId: params.sessionId,
            serverBaseUrl: params.serverBaseUrl,
            timestamp: Date.now()
        }, getWalletOrigin());
    });
}

/**
 * Get user's X25519 public key from the wallet
 * Opens wallet popup if needed and requests the key
 */
async function getWalletPublicKey() {
    // For now, use localStorage or prompt for key
    // In production, this would use postMessage to communicate with wallet

    // Check if we have a stored key from a previous clearance verification
    const storedKey = localStorage.getItem('wallet-x25519-publicKey');
    if (storedKey) {
        console.log('[WalletKey] Using stored X25519 public key');
        return storedKey;
    }

    // Prompt user to provide their wallet's public key
    // This is a temporary solution - in production, use postMessage
    const key = prompt(
        'Enter your wallet\'s X25519 public key (Base64):\n\n' +
        'You can find this in your wallet\'s Security settings or Key Management page.\n\n' +
        '(This key is used to encrypt the document so only your wallet can decrypt it)'
    );

    if (key && key.trim()) {
        // Validate key format (should be 44 chars base64 for 32 bytes)
        const trimmedKey = key.trim();
        if (trimmedKey.length >= 40 && trimmedKey.length <= 50) {
            localStorage.setItem('wallet-x25519-publicKey', trimmedKey);
            return trimmedKey;
        }
    }

    return null;
}

/**
 * Send encrypted document to wallet for storage
 * Uses postMessage if wallet window is open, otherwise stores for pickup
 */
async function sendDocumentToWallet(documentData) {
    // Check if wallet window is open
    if (walletWindow && !walletWindow.closed) {
        return new Promise((resolve, reject) => {
            const requestId = 'doc-' + Date.now();

            const timeout = setTimeout(() => {
                reject(new Error('Wallet did not respond'));
            }, 30000);

            // Listen for response
            const handler = (event) => {
                if (event.origin !== getWalletOrigin()) return;
                if (event.data?.requestId !== requestId) return;

                window.removeEventListener('message', handler);
                clearTimeout(timeout);

                // Wallet sends DOCUMENT_STORAGE_RESPONSE on success
                if (event.data.type === 'DOCUMENT_STORAGE_RESPONSE' && event.data.success) {
                    resolve(true);
                } else {
                    reject(new Error(event.data.error || 'Failed to store document'));
                }
            };

            window.addEventListener('message', handler);

            // Send document to wallet using correct message type: DOCUMENT_STORAGE_REQUEST
            // Fields go directly on the message, not wrapped in 'document'
            walletWindow.postMessage({
                type: 'DOCUMENT_STORAGE_REQUEST',
                requestId,
                ephemeralDID: documentData.ephemeralDID,
                originalDocumentDID: documentData.originalDocumentDID,
                title: documentData.title,
                overallClassification: documentData.overallClassification,
                encryptedContent: documentData.encryptedContent,
                encryptionInfo: documentData.encryptionInfo,
                sectionSummary: documentData.sectionSummary,
                expiresAt: documentData.expiresAt,
                accessRights: documentData.accessRights,
                sourceInfo: documentData.sourceInfo,
                timestamp: Date.now()
            }, getWalletOrigin());
        });
    }

    // Wallet not open - store in localStorage for pickup
    console.log('[SendToWallet] Wallet not open, storing for pickup');
    const pendingDocs = JSON.parse(localStorage.getItem('pending-wallet-documents') || '[]');
    pendingDocs.push({
        ...documentData,
        pendingAt: Date.now()
    });
    localStorage.setItem('pending-wallet-documents', JSON.stringify(pendingDocs));

    // Optionally open wallet
    const openWallet = confirm('Document encrypted and ready!\n\nWould you like to open your wallet to receive it?\n\n(The document is stored securely and will be available when you open your wallet)');

    if (openWallet) {
        const walletUrl = 'https://identuslabel.cz/alice/my-documents';
        window.open(walletUrl, 'identus-wallet');
    }

    return true;
}

// ============================================================================
// Classified Document Upload - Section-Level Clearance
// ============================================================================

let selectedClassifiedFile = null;

/**
 * Handle classified file selection
 */
function handleClassifiedFileSelect(input) {
    const file = input.files[0];
    if (!file) return;

    const filename = file.name.toLowerCase();
    const isValid = filename.endsWith('.html') || filename.endsWith('.htm') || filename.endsWith('.docx');

    if (!isValid) {
        alert('Please select an HTML (.html, .htm) or Word (.docx) file.');
        input.value = '';
        return;
    }

    selectedClassifiedFile = file;

    // Show preview
    document.getElementById('classifiedFilePreview').classList.remove('hidden');
    document.getElementById('classifiedDropZone').style.display = 'none';
    document.getElementById('classifiedFileName').textContent = file.name;
    document.getElementById('classifiedFileSize').textContent = formatFileSize(file.size);

    // Set icon based on type
    const icon = filename.endsWith('.docx') ? '📝' : '📄';
    document.getElementById('classifiedFileIcon').textContent = icon;

    // If HTML, analyze sections client-side
    if (filename.endsWith('.html') || filename.endsWith('.htm')) {
        analyzeHtmlSections(file);
    } else {
        // For DOCX, we'll analyze server-side
        document.getElementById('sectionAnalysis').classList.add('hidden');
    }
}

/**
 * Analyze HTML file for clearance sections (client-side preview)
 */
async function analyzeHtmlSections(file) {
    try {
        const content = await file.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(content, 'text/html');

        // Count sections by clearance level
        const counts = {
            'INTERNAL': 0,
            'CONFIDENTIAL': 0,
            'RESTRICTED': 0,
            'TOP-SECRET': 0
        };

        const classifiedElements = doc.querySelectorAll('[data-clearance]');
        classifiedElements.forEach(el => {
            const clearance = el.getAttribute('data-clearance').toUpperCase();
            if (counts.hasOwnProperty(clearance)) {
                counts[clearance]++;
            }
        });

        // Count unmarked elements as INTERNAL
        // (simplified - actual parsing is more complex)
        const totalMarked = classifiedElements.length;
        if (totalMarked === 0) {
            counts['INTERNAL'] = 1; // Whole document is internal
        }

        // Update UI
        document.getElementById('internalCount').textContent = counts['INTERNAL'];
        document.getElementById('confidentialCount').textContent = counts['CONFIDENTIAL'];
        document.getElementById('restrictedCount').textContent = counts['RESTRICTED'];
        document.getElementById('topSecretCount').textContent = counts['TOP-SECRET'];

        // Determine overall classification (lowest in doc for discovery purposes)
        let overall = 'INTERNAL';
        if (counts['CONFIDENTIAL'] > 0) overall = 'CONFIDENTIAL';
        if (counts['RESTRICTED'] > 0) overall = 'RESTRICTED';
        if (counts['TOP-SECRET'] > 0) overall = 'TOP-SECRET';

        document.getElementById('overallClassification').textContent = overall;
        document.getElementById('sectionAnalysis').classList.remove('hidden');

    } catch (error) {
        console.error('[SectionAnalysis] Error:', error);
        document.getElementById('sectionAnalysis').classList.add('hidden');
    }
}

/**
 * Clear selected classified file
 */
function clearClassifiedFile() {
    selectedClassifiedFile = null;
    document.getElementById('classifiedDocFile').value = '';
    document.getElementById('classifiedFilePreview').classList.add('hidden');
    document.getElementById('classifiedDropZone').style.display = 'block';
    document.getElementById('sectionAnalysis').classList.add('hidden');
}

/**
 * Handle classified document upload
 */
async function handleCreateClassifiedDocument(event) {
    event.preventDefault();

    if (!selectedClassifiedFile) {
        alert('Please select a file to upload.');
        return;
    }

    const sessionToken = getSessionToken();
    if (!sessionToken) {
        alert('Session expired. Please log in again.');
        window.location.href = '/company-admin/employee-portal-login.html';
        return;
    }

    const form = event.target;
    const btn = document.getElementById('createClassifiedDocBtn');
    const originalText = btn.innerHTML;

    // Disable button and show loading
    btn.disabled = true;
    btn.innerHTML = '⏳ Uploading...';

    // Hide messages
    document.getElementById('classifiedDocSuccess').classList.add('hidden');
    document.getElementById('classifiedDocError').classList.add('hidden');

    try {
        const formData = new FormData();
        formData.append('file', selectedClassifiedFile);

        const title = document.getElementById('classifiedDocTitle').value.trim();
        if (title) {
            formData.append('title', title);
        }

        // Get releasableTo
        const releasableCheckboxes = document.querySelectorAll('input[name="classifiedReleasableTo"]:checked');
        const releasableTo = Array.from(releasableCheckboxes).map(cb => cb.value);
        formData.append('releasableTo', JSON.stringify(releasableTo));

        const response = await fetch('/company-admin/api/classified-documents/upload', {
            method: 'POST',
            headers: {
                'X-Session-ID': sessionToken
            },
            body: formData
        });

        const result = await response.json();

        if (result.success) {
            // Show success message
            document.getElementById('classifiedSuccessMessage').textContent =
                `Document "${result.title}" uploaded successfully! ` +
                `${result.sectionCount} sections encrypted. ` +
                `Overall classification: ${result.overallClassification}`;
            document.getElementById('classifiedDocSuccess').classList.remove('hidden');

            // Reset form
            form.reset();
            clearClassifiedFile();

            // Refresh document list
            const profile = await loadProfile();
            if (profile) {
                await loadDocuments(profile);
            }

        } else {
            throw new Error(result.message || 'Upload failed');
        }

    } catch (error) {
        console.error('[ClassifiedUpload] Error:', error);
        document.getElementById('classifiedErrorMessage').textContent = error.message;
        document.getElementById('classifiedDocError').classList.remove('hidden');
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
    }
}

/**
 * Format file size for display
 */
function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' bytes';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// Export functions for inline onclick handlers
window.copyToClipboard = copyToClipboard;
window.handleLogout = handleLogout;
window.viewCredentials = viewCredentials;
window.viewDocument = viewDocument;
window.handleCreateDocument = handleCreateDocument;
window.openClearanceModal = openClearanceModal;
window.initiateClearanceVerification = initiateClearanceVerification;
window.submitClearanceVerification = submitClearanceVerification;
window.closeClearanceModal = closeClearanceModal;
window.downloadToWallet = downloadToWallet;
window.handleClassifiedFileSelect = handleClassifiedFileSelect;
window.clearClassifiedFile = clearClassifiedFile;
window.handleCreateClassifiedDocument = handleCreateClassifiedDocument;
