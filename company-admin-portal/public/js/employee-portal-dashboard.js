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
        case 'TOP_SECRET':
            return '#9f7aea'; // Purple
        case 'SECRET':
            return '#e53e3e'; // Red
        case 'CONFIDENTIAL':
            return '#ed8936'; // Orange
        case 'UNCLASSIFIED':
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
        listEl.innerHTML = documents.map(doc => `
            <div class="document-item">
                <div class="document-info">
                    <div class="document-title">${escapeHtml(doc.title)}</div>
                    <div class="document-meta">
                        <span class="classification-badge ${doc.classificationLevel}">
                            ${doc.classificationLevel}
                        </span>
                        ${doc.metadata?.category ? `<span>📁 ${escapeHtml(doc.metadata.category)}</span>` : ''}
                        ${doc.metadata?.version ? `<span>🔖 ${escapeHtml(doc.metadata.version)}</span>` : ''}
                    </div>
                </div>
                <button class="view-document-btn" onclick="viewDocument('${escapeHtml(doc.documentDID)}')">
                    View
                </button>
            </div>
        `).join('');
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

function viewDocument(documentDID) {
    console.log(`[Documents] View document: ${documentDID}`);
    showError('Document viewing feature coming soon!');
    // TODO: Implement document viewing/download functionality
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
});

// Handle browser back/forward buttons
window.addEventListener('popstate', () => {
    if (!checkAuthentication()) {
        return;
    }
    initializeDashboard();
});

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
