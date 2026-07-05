/**
 * Company Admin Portal - Frontend Application
 *
 * Handles all UI interactions, API calls, and state management for the
 * company admin portal.
 */

const app = {
    currentCompany: null,
    employees: [],

    /**
     * Initialize application
     */
    async init() {
        console.log('[APP] Initializing Company Admin Portal...');

        // Check authentication status
        await this.checkAuth();
    },

    /**
     * Check if user is authenticated
     */
    async checkAuth() {
        try {
            const response = await fetch('/company-admin/api/auth/current');
            const data = await response.json();

            if (data.success && data.authenticated) {
                this.currentCompany = data.company;
                await this.showDashboard();
            } else {
                await this.showLogin();
            }
        } catch (error) {
            console.error('[AUTH] Error checking authentication:', error);
            await this.showLogin();
        }
    },

    /**
     * Show login screen
     */
    async showLogin() {
        console.log('[UI] Showing login screen');

        // Hide loading and dashboard
        document.getElementById('loading-screen').classList.add('hidden');
        document.getElementById('admin-dashboard').classList.add('hidden');

        // Load companies
        try {
            const response = await fetch('/company-admin/api/companies');
            const data = await response.json();

            if (data.success) {
                this.renderCompanyCards(data.companies);
            }
        } catch (error) {
            console.error('[LOGIN] Error loading companies:', error);
            this.showNotification('Failed to load companies', 'error');
        }

        // Show login screen
        document.getElementById('login-screen').classList.remove('hidden');
    },

    /**
     * Render company selection cards
     */
    renderCompanyCards(companies) {
        const container = document.getElementById('company-cards');
        container.innerHTML = '';

        companies.forEach(company => {
            const card = document.createElement('div');
            card.className = 'company-card';
            card.style.borderColor = company.color;
            card.innerHTML = `
                <div class="company-card-logo" style="background: ${company.color}">${company.logo}</div>
                <h3>${company.displayName}</h3>
                <p>${company.tagline}</p>
            `;
            card.onclick = () => this.login(company.id);
            container.appendChild(card);
        });
    },

    /**
     * Login as company
     */
    async login(companyId) {
        console.log(`[LOGIN] Logging in as ${companyId}`);

        try {
            const response = await fetch('/company-admin/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ companyId })
            });

            const data = await response.json();

            if (data.success) {
                this.currentCompany = data.company;
                this.showNotification(`Welcome, ${data.company.displayName}!`, 'success');
                await this.showDashboard();
            } else {
                this.showNotification(data.error || 'Login failed', 'error');
            }
        } catch (error) {
            console.error('[LOGIN] Error:', error);
            this.showNotification('Login failed', 'error');
        }
    },

    /**
     * Logout
     */
    async logout() {
        console.log('[LOGOUT] Logging out');

        try {
            await fetch('/company-admin/api/auth/logout', { method: 'POST' });
            this.currentCompany = null;
            this.employees = [];
            this.showNotification('Logged out successfully', 'success');
            await this.showLogin();
        } catch (error) {
            console.error('[LOGOUT] Error:', error);
            this.showNotification('Logout failed', 'error');
        }
    },

    /**
     * Show admin dashboard
     */
    async showDashboard() {
        console.log('[UI] Showing dashboard');

        // Hide loading and login
        document.getElementById('loading-screen').classList.add('hidden');
        document.getElementById('login-screen').classList.add('hidden');

        // Update header
        document.getElementById('header-logo').textContent = this.currentCompany.logo;
        document.getElementById('header-company-name').textContent = this.currentCompany.displayName;
        document.getElementById('header-tagline').textContent = this.currentCompany.tagline;

        // Show dashboard
        document.getElementById('admin-dashboard').classList.remove('hidden');

        // Load data
        await this.loadCompanyInfo();
        await this.loadEmployees();
        await loadCompanyCredentials(); // Load credentials after authentication
        this.loadAccessLogs();
        this.loadAdminChat();
    },

    /**
     * Load company information
     */
    async loadCompanyInfo() {
        console.log('[DATA] Loading company info');

        try {
            const response = await fetch('/company-admin/api/company/info');
            const data = await response.json();

            if (data.success) {
                const company = data.company;

                // Update DID
                document.getElementById('company-did').textContent = company.did;

                // Update website
                document.getElementById('company-website').textContent = company.website;

                // Update public keys
                const keysList = document.getElementById('public-keys-list');
                keysList.innerHTML = company.publicKeys.map(key =>
                    `<li><code>${key.id}</code> - ${key.purpose}</li>`
                ).join('');

                // Update services
                const servicesList = document.getElementById('services-list');
                servicesList.innerHTML = company.services.map(service =>
                    `<li><strong>${service.id}</strong>: ${service.endpoint}</li>`
                ).join('');
            }
        } catch (error) {
            console.error('[DATA] Error loading company info:', error);
            this.showNotification('Failed to load company information', 'error');
        }
    },

    /**
     * Load employees (connections)
     */
    async loadEmployees() {
        console.log('[DATA] Loading employees');

        try {
            const response = await fetch('/company-admin/api/company/connections');
            const data = await response.json();

            if (data.success) {
                this.employees = data.connections;
                this.renderEmployees();
                this.updateEmployeeStats();
            }
        } catch (error) {
            console.error('[DATA] Error loading employees:', error);
            this.showNotification('Failed to load employees', 'error');
        }
    },

    /**
     * Render employees table
     */
    renderEmployees() {
        const tbody = document.getElementById('employee-table-body');

        if (this.employees.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="5" class="empty-row">
                        No employees connected yet. Click "Invite New Employee" to get started.
                    </td>
                </tr>
            `;
            this._stopAutoRefresh();
            return;
        }

        let hasPending = false;

        tbody.innerHTML = this.employees.map(employee => {
            const statusClass = this.getStatusClass(employee.state);
            const createdDate = new Date(employee.createdAt).toLocaleDateString();

            // Show real name once proof is done; otherwise show role/dept hint
            let displayName, subtitle;
            if (employee.employeeName) {
                displayName = employee.employeeName;
                subtitle = employee.employeeEmail || '';
            } else {
                const parts = [employee.employeeRole, employee.employeeDept].filter(Boolean);
                displayName = parts.length ? parts.join(' — ') : (employee.theirLabel || 'Unknown Employee');
                subtitle = '';
            }

            const proofBadge = this._proofStateBadge(employee.proofState, employee.proofError, employee.state);
            const isConnectionActive = employee.state === 'ConnectionResponseSent' || employee.state === 'Active';
            if ((!employee.proofState && !isConnectionActive) || employee.proofState === 'sending' || employee.proofState === 'requested' || employee.proofState === 'issuing') hasPending = true;

            return `
                <tr>
                    <td>
                        <strong>${displayName}</strong>
                        ${subtitle ? `<br><small class="text-muted">${subtitle}</small>` : ''}
                    </td>
                    <td>
                        <code class="connection-id">${employee.connectionId.substring(0, 12)}...</code>
                    </td>
                    <td>
                        <span class="status-badge ${statusClass}">${this.getStatusLabel(employee.state)}</span>
                        ${proofBadge}
                    </td>
                    <td>${createdDate}</td>
                    <td class="actions">
                        <button class="btn btn-sm btn-danger"
                                onclick="app.removeEmployee('${employee.connectionId}', '${(employee.employeeName || displayName).replace(/'/g, "\\'")}')">
                            Remove
                        </button>
                    </td>
                </tr>
            `;
        }).join('');

        if (hasPending) {
            this._startAutoRefresh();
        } else {
            this._stopAutoRefresh();
        }
    },

    /**
     * Return HTML badge for proof flow state.
     */
    _proofStateBadge(proofState, proofError, connectionState) {
        if (!proofState) {
            const isActive = connectionState === 'ConnectionResponseSent' || connectionState === 'Active';
            if (isActive) return '';
            return '<br><small class="text-muted">Awaiting connection...</small>';
        }
        if (proofState === 'sending' || proofState === 'requested') {
            return '<br><small class="text-warning"><span class="spinner-border spinner-border-sm"></span> Awaiting identity proof...</small>';
        }
        if (proofState === 'issuing') {
            return '<br><small class="text-info"><span class="spinner-border spinner-border-sm"></span> Issuing credentials...</small>';
        }
        if (proofState === 'complete') {
            return '<br><small class="text-success">✅ Credentials issued</small>';
        }
        if (proofState === 'failed') {
            return `<br><small class="text-danger">❌ ${proofError || 'Proof failed'}</small>`;
        }
        return '';
    },

    /**
     * Auto-refresh connections while proof flows are in progress.
     */
    _startAutoRefresh() {
        if (this._autoRefreshTimer) return;
        this._autoRefreshTimer = setInterval(() => this.loadEmployees(), 4000);
    },

    _stopAutoRefresh() {
        if (this._autoRefreshTimer) {
            clearInterval(this._autoRefreshTimer);
            this._autoRefreshTimer = null;
        }
    },

    /**
     * Update employee statistics
     */
    updateEmployeeStats() {
        const total = this.employees.length;
        const active = this.employees.filter(e =>
            e.state === 'ConnectionResponseSent' || e.state === 'Active'
        ).length;
        const pending = this.employees.filter(e =>
            e.state === 'InvitationGenerated' || e.state === 'ConnectionRequested'
        ).length;

        document.getElementById('total-employees').textContent = total;
        document.getElementById('active-employees').textContent = active;
        document.getElementById('pending-employees').textContent = pending;
    },

    /**
     * Get status class for connection state
     */
    getStatusClass(state) {
        const stateMap = {
            'InvitationGenerated': 'status-pending',
            'ConnectionRequested': 'status-pending',
            'ConnectionResponseSent': 'status-active',
            'Active': 'status-active'
        };
        return stateMap[state] || 'status-default';
    },

    getStatusLabel(state) {
        const labelMap = {
            'InvitationGenerated': 'Invitation Sent',
            'ConnectionRequested': 'Connecting…',
            'ConnectionResponseSent': 'Connected',
            'Active': 'Connected'
        };
        return labelMap[state] || state;
    },

    /**
     * Show invite modal
     */
    showInviteModal() {
        document.getElementById('invite-modal').classList.remove('hidden');
        this.resetInviteForm();
    },

    /**
     * Close invite modal
     */
    closeInviteModal() {
        document.getElementById('invite-modal').classList.add('hidden');
    },

    /**
     * Reset invite form
     */
    resetInviteForm() {
        document.getElementById('invite-form').reset();
        document.getElementById('invite-form').classList.remove('hidden');
        document.getElementById('invitation-result').classList.add('hidden');
    },

    /**
     * Handle invite form submission
     */
    async handleInviteSubmit(event) {
        event.preventDefault();

        const formData = new FormData(event.target);
        const role = formData.get('role');
        const department = formData.get('department');

        console.log('[INVITE] Creating invitation, role:', role, 'dept:', department);

        try {
            const response = await fetch('/company-admin/api/company/invite-employee', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role, department })
            });

            const data = await response.json();

            if (data.success) {
                this.showInvitationResult(data.invitation.invitationUrl);
                this.showNotification('Invitation created', 'success');
            } else {
                this.showNotification(data.error || 'Failed to create invitation', 'error');
            }
        } catch (error) {
            console.error('[INVITE] Error:', error);
            this.showNotification('Failed to create invitation', 'error');
        }
    },

    /**
     * Show invitation result with QR code
     * Uses URL shortener for long DIDComm invitation URLs
     */
    async showInvitationResult(invitationUrl) {
        // Hide form, show result
        document.getElementById('invite-form').classList.add('hidden');
        document.getElementById('invitation-result').classList.remove('hidden');

        // Set invitation URL (full URL for copying)
        document.getElementById('invitation-url').value = invitationUrl;

        // Generate QR code
        const qrContainer = document.getElementById('invitation-qr');
        qrContainer.innerHTML = ''; // Clear previous QR code

        if (typeof QRCode === 'undefined') {
            console.error('[QR] QRCode library not loaded');
            qrContainer.innerHTML = `
                <div style="width: 256px; height: 256px; background: #f8f8f8;
                            display: flex; align-items: center; justify-content: center;
                            border: 2px dashed #ccc; border-radius: 8px; text-align: center;">
                    <div>
                        <div style="font-size: 48px; margin-bottom: 8px;">!</div>
                        <div style="color: #666;">QR code unavailable</div>
                        <div style="color: #999; font-size: 12px;">Use the URL below</div>
                    </div>
                </div>
            `;
            return;
        }

        console.log('[QR] Invitation URL length:', invitationUrl.length);

        // For long URLs, use the URL shortener service
        let qrUrl = invitationUrl;
        const MAX_QR_LENGTH = 2500;

        if (invitationUrl.length > MAX_QR_LENGTH) {
            console.log('[QR] URL too long, using shortener service...');

            // Show loading state
            qrContainer.innerHTML = `
                <div style="width: 256px; height: 256px; background: #f8f8f8;
                            display: flex; align-items: center; justify-content: center;
                            border: 2px dashed #ccc; border-radius: 8px; text-align: center;">
                    <div>
                        <div style="font-size: 36px; margin-bottom: 8px;">&#8987;</div>
                        <div style="color: #666;">Creating short URL...</div>
                    </div>
                </div>
            `;

            try {
                const response = await fetch('/company-admin/api/shorten', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: invitationUrl })
                });

                const data = await response.json();

                if (data.success) {
                    qrUrl = data.shortUrl;
                    console.log('[QR] Shortened URL:', qrUrl, '(' + qrUrl.length + ' chars)');
                } else {
                    throw new Error(data.error || 'Failed to shorten URL');
                }
            } catch (error) {
                console.error('[QR] URL shortener failed:', error);
                qrContainer.innerHTML = `
                    <div style="width: 256px; height: 256px; background: #fff3cd;
                                display: flex; align-items: center; justify-content: center;
                                border: 2px dashed #ffc107; border-radius: 8px; text-align: center; padding: 16px;">
                        <div>
                            <div style="font-size: 36px; margin-bottom: 8px;">&#128279;</div>
                            <div style="color: #856404; font-weight: 600;">QR unavailable</div>
                            <div style="color: #666; font-size: 12px; margin-top: 8px;">Copy & share the URL below</div>
                        </div>
                    </div>
                `;
                return;
            }
        }

        // Clear loading state and generate QR
        qrContainer.innerHTML = '';

        try {
            new QRCode(qrContainer, {
                text: qrUrl,
                width: 256,
                height: 256,
                colorDark: "#000000",
                colorLight: "#ffffff",
                correctLevel: QRCode.CorrectLevel.L
            });
            console.log('[QR] QR code generated successfully');
        } catch (error) {
            console.error('[QR] Error generating QR code:', error);
            qrContainer.innerHTML = `
                <div style="width: 256px; height: 256px; background: #fff5f5;
                            display: flex; align-items: center; justify-content: center;
                            border: 2px dashed #ff6b6b; border-radius: 8px; text-align: center; padding: 16px;">
                    <div>
                        <div style="font-size: 36px; margin-bottom: 8px;">&#10060;</div>
                        <div style="color: #c92a2a; font-weight: 600;">QR generation failed</div>
                        <div style="color: #999; font-size: 12px; margin-top: 8px;">Copy & share the URL below</div>
                    </div>
                </div>
            `;
        }
    },

    /**
     * Copy invitation URL to clipboard
     */
    copyInvitationUrl() {
        const input = document.getElementById('invitation-url');
        input.select();
        document.execCommand('copy');
        this.showNotification('Invitation URL copied to clipboard!', 'success');
    },

    /**
     * Copy text to clipboard
     */
    copyToClipboard(selector) {
        const element = document.querySelector(selector);
        const text = element.textContent;

        navigator.clipboard.writeText(text).then(() => {
            this.showNotification('Copied to clipboard!', 'success');
        }).catch(err => {
            console.error('[COPY] Error:', err);
            this.showNotification('Failed to copy', 'error');
        });
    },


    /**
     * Remove employee connection
     */
    async removeEmployee(connectionId, employeeName) {
        if (!confirm(`Remove ${employeeName} from employee connections?`)) {
            return;
        }

        console.log('[EMPLOYEE] Removing:', connectionId);

        try {
            const response = await fetch(`/company-admin/api/company/connections/${connectionId}`, {
                method: 'DELETE'
            });

            const data = await response.json();

            if (data.success) {
                console.log(`✅ [EMPLOYEE] Successfully deleted connection: ${connectionId}`);
                console.log(`📊 [EMPLOYEE] Employees before deletion: ${this.employees.length}`);

                // ✅ FIX: Direct array filtering instead of database refresh
                // This prevents the deleted connection from reappearing (state-database desync fix)
                this.employees = this.employees.filter(e => e.connectionId !== connectionId);

                console.log(`📊 [EMPLOYEE] Employees after deletion: ${this.employees.length}`);

                // Update UI directly from filtered array
                this.renderEmployees();
                this.updateEmployeeStats();

                this.showNotification(`Removed ${employeeName}`, 'success');
                console.log('✅ [EMPLOYEE] UI updated successfully with direct state mutation');
            } else {
                this.showNotification(data.error || 'Failed to remove employee', 'error');
            }
        } catch (error) {
            console.error('[EMPLOYEE] Error:', error);
            this.showNotification('Failed to remove employee', 'error');
        }
    },

    /**
     * Show notification toast
     */
    showNotification(message, type = 'info') {
        const toast = document.getElementById('notification-toast');
        const messageEl = document.getElementById('notification-message');

        toast.className = 'notification-toast';
        toast.classList.add(`notification-${type}`);

        messageEl.textContent = message;

        toast.classList.remove('hidden');

        setTimeout(() => {
            toast.classList.add('hidden');
        }, 3000);
    },

    /**
     * Sync enterprise SecurityClearanceGrant VCs against personal CA clearance status.
     * Revokes enterprise grants whose personal CA VCs have been revoked.
     */
    async syncClearance() {
        const btn = document.getElementById('sync-clearance-btn');
        const resultEl = document.getElementById('sync-clearance-result');
        if (btn) { btn.disabled = true; btn.textContent = '⏳ Syncing…'; }
        if (resultEl) resultEl.style.display = 'none';

        try {
            const res = await fetch('/company-admin/api/company/sync-clearance', { method: 'POST' });
            const data = await res.json();

            if (data.success) {
                const r = data.report;
                const color = r.revoked > 0 ? '#fff3cd' : '#d4edda';
                const border = r.revoked > 0 ? '#ffc107' : '#28a745';
                const msg = [
                    `Checked: <strong>${r.synced}</strong> active grants`,
                    `Revoked now: <strong>${r.revoked}</strong>`,
                    r.alreadyRevoked > 0 ? `Already revoked: ${r.alreadyRevoked}` : null,
                    r.personalNotFound > 0 ? `Personal VC not found: ${r.personalNotFound}` : null,
                    r.noStatusList > 0 ? `<strong>${r.noStatusList} old-format VC(s) need manual wallet deletion</strong>` : null,
                    r.errors.length > 0 ? `Errors: ${r.errors.length}` : null
                ].filter(Boolean).join(' &bull; ');

                if (resultEl) {
                    resultEl.style.cssText = `display:block; background:${color}; border:1px solid ${border}; padding:.75rem 1rem; border-radius:6px; margin:.5rem 1rem;`;
                    resultEl.innerHTML = `✅ Sync complete — ${msg}`;
                    if (r.noStatusList > 0) {
                        const details = r.noStatusListDetails.map(d =>
                            `${d.holderName || d.holderDID} (${d.credentialType} ${d.clearanceLevel})`
                        ).join(', ');
                        resultEl.innerHTML += `<br><small>⚠️ These old-format VCs have no revocation status list and cannot be server-revoked. Have the employee delete them from their wallet: ${details}</small>`;
                    }
                    if (r.errors.length > 0) {
                        resultEl.innerHTML += `<br><small>Errors: ${r.errors.map(e => e.error).join('; ')}</small>`;
                    }
                }

                if (r.revoked > 0) {
                    this.showNotification(`Revoked ${r.revoked} stale enterprise clearance grant(s)`, 'warning');
                } else {
                    this.showNotification('Clearance sync complete — no revocations needed', 'success');
                }
            } else {
                if (resultEl) {
                    resultEl.style.cssText = 'display:block; background:#f8d7da; border:1px solid #dc3545; padding:.75rem 1rem; border-radius:6px; margin:.5rem 1rem;';
                    resultEl.innerHTML = `❌ Sync failed: ${data.error}`;
                }
                this.showNotification('Clearance sync failed: ' + data.error, 'error');
            }
        } catch (err) {
            if (resultEl) {
                resultEl.style.cssText = 'display:block; background:#f8d7da; border:1px solid #dc3545; padding:.75rem 1rem; border-radius:6px; margin:.5rem 1rem;';
                resultEl.innerHTML = `❌ Network error: ${err.message}`;
            }
            this.showNotification('Sync error: ' + err.message, 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '🔄 Sync Clearance'; }
        }
    },

    async loadAccessLogs() {
        try {
            const res  = await fetch('/company-admin/api/admin/access-logs?limit=200');
            const data = await res.json();
            const tbody = document.getElementById('access-log-tbody');
            if (!data.success || !data.logs.length) {
                tbody.innerHTML = '<tr><td colspan="6">No access events recorded yet.</td></tr>';
                return;
            }
            tbody.innerHTML = data.logs.map(e => `
              <tr class="${e.accessGranted ? '' : 'denied-row'}">
                <td>${new Date(e.timestamp).toLocaleString()}</td>
                <td>${e.viewerName || '—'}</td>
                <td title="${e.documentDID}">${e.documentTitle || (e.documentDID?.substring(0, 20) + '…')}</td>
                <td>${e.clearanceLevel || '—'}</td>
                <td>${e.accessGranted ? '✅ Granted' : '❌ Denied'}</td>
                <td>${e.denialReason || '—'}</td>
              </tr>`).join('');
        } catch (err) {
            console.error('[AccessLogs] Failed to load:', err);
        }
    }
};

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    app.init();
});

// ============================================================================
// COMPANY CREDENTIALS FUNCTIONALITY
// ============================================================================

// Global wrapper for showNotification (credentials functions need this)
function showNotification(message, type = 'info') {
    if (typeof app !== 'undefined' && typeof app.showNotification === 'function') {
        app.showNotification(message, type);
    } else {
        console.log(`[${type.toUpperCase()}] ${message}`);
    }
}

// Global variables for credentials
let currentCredentialFilter = 'all';
let allCredentials = [];

/**
 * Load company credentials from API
 */
async function loadCompanyCredentials(filter = 'all') {
    try {
        const response = await fetch(`/company-admin/api/company/credentials?filter=${filter}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        if (data.success) {
            allCredentials = data.credentials;
            displayCompanyCredentials(data.credentials, data.stats);

            // Show the credentials section
            const credentialsSection = document.getElementById('company-credentials-section');
            if (credentialsSection) {
                credentialsSection.style.display = 'block';
            }
        } else {
            console.error('Failed to load credentials:', data.error);
            showNotification('Failed to load credentials', 'error');
        }
    } catch (error) {
        console.error('Error loading credentials:', error);
        showNotification('Error loading credentials: ' + error.message, 'error');
    }
}

/**
 * Display company credentials in table
 */
function displayCompanyCredentials(credentials, stats) {
    const tbody = document.getElementById('credentials-tbody');
    const emptyState = document.getElementById('credentials-empty-state');
    const tableContainer = document.getElementById('credentials-table-container');

    // Update filter counts
    if (stats) {
        document.getElementById('count-all').textContent = stats.total;
        document.getElementById('count-active').textContent = stats.active;
        document.getElementById('count-revoked').textContent = stats.revoked;
        document.getElementById('count-expired').textContent = stats.expired;
    }

    if (!credentials || credentials.length === 0) {
        // Show empty state
        if (emptyState) emptyState.style.display = 'block';
        if (tableContainer) tableContainer.style.display = 'none';
        return;
    }

    // Hide empty state, show table
    if (emptyState) emptyState.style.display = 'none';
    if (tableContainer) tableContainer.style.display = 'block';

    // Build table rows
    const rows = credentials.map(cred => {
        const statusBadge = getStatusBadgeHTML(cred.status);
        const shortCredId = cred.claims.credentialId || cred.recordId.substring(0, 8);

        return `
            <tr>
                <td><code>${escapeHtml(shortCredId)}</code></td>
                <td>${escapeHtml(cred.claims.companyName || 'N/A')}</td>
                <td>${escapeHtml(cred.claims.registrationNumber || 'N/A')}</td>
                <td>${formatDate(cred.issuedDate)}</td>
                <td>${formatDate(cred.expiryDate)}</td>
                <td>${statusBadge}</td>
                <td>
                    <button class="btn btn-sm btn-secondary" onclick="showCredentialDetails('${cred.recordId}')">
                        View Details
                    </button>
                    <button class="btn btn-sm btn-secondary" onclick="copyCredentialJWT('${cred.recordId}')">
                        Copy JWT
                    </button>
                </td>
            </tr>
        `;
    }).join('');

    tbody.innerHTML = rows;
}

/**
 * Filter credentials by status
 */
function filterCredentials(filter) {
    currentCredentialFilter = filter;

    // Update active filter button
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.getAttribute('data-filter') === filter) {
            btn.classList.add('active');
        }
    });

    // Reload with filter
    loadCompanyCredentials(filter);
}

/**
 * Show credential details in modal
 */
function showCredentialDetails(recordId) {
    const credential = allCredentials.find(c => c.recordId === recordId);

    if (!credential) {
        showNotification('Credential not found', 'error');
        return;
    }

    const modal = document.getElementById('credential-details-modal');
    const content = document.getElementById('credential-details-content');

    const detailsHTML = `
        <div class="credential-details">
            <div class="detail-section">
                <h4>Basic Information</h4>
                <div class="detail-grid">
                    <div class="detail-item">
                        <label>Credential ID</label>
                        <div class="detail-value"><code>${escapeHtml(credential.claims.credentialId || 'N/A')}</code></div>
                    </div>
                    <div class="detail-item">
                        <label>Record ID</label>
                        <div class="detail-value"><code>${escapeHtml(credential.recordId)}</code></div>
                    </div>
                    <div class="detail-item">
                        <label>Status</label>
                        <div class="detail-value">${getStatusBadgeHTML(credential.status)}</div>
                    </div>
                    <div class="detail-item">
                        <label>Protocol State</label>
                        <div class="detail-value"><code>${escapeHtml(credential.protocolState)}</code></div>
                    </div>
                </div>
            </div>

            <div class="detail-section">
                <h4>Company Information</h4>
                <div class="detail-grid">
                    <div class="detail-item">
                        <label>Company Name</label>
                        <div class="detail-value">${escapeHtml(credential.claims.companyName || 'N/A')}</div>
                    </div>
                    <div class="detail-item">
                        <label>Display Name</label>
                        <div class="detail-value">${escapeHtml(credential.claims.companyDisplayName || 'N/A')}</div>
                    </div>
                    <div class="detail-item">
                        <label>Registration Number</label>
                        <div class="detail-value">${escapeHtml(credential.claims.registrationNumber || 'N/A')}</div>
                    </div>
                    <div class="detail-item">
                        <label>Jurisdiction</label>
                        <div class="detail-value">${escapeHtml(credential.claims.jurisdiction || 'N/A')}</div>
                    </div>
                    <div class="detail-item">
                        <label>Industry</label>
                        <div class="detail-value">${escapeHtml(credential.claims.industry || 'N/A')}</div>
                    </div>
                    <div class="detail-item">
                        <label>Website</label>
                        <div class="detail-value">
                            ${credential.claims.website ? `<a href="${escapeHtml(credential.claims.website)}" target="_blank">${escapeHtml(credential.claims.website)}</a>` : 'N/A'}
                        </div>
                    </div>
                </div>
            </div>

            <div class="detail-section">
                <h4>Dates & Validity</h4>
                <div class="detail-grid">
                    <div class="detail-item">
                        <label>Issued Date</label>
                        <div class="detail-value">${formatDate(credential.issuedDate)}</div>
                    </div>
                    <div class="detail-item">
                        <label>Established Date</label>
                        <div class="detail-value">${formatDate(credential.claims.establishedDate)}</div>
                    </div>
                    <div class="detail-item">
                        <label>Expiry Date</label>
                        <div class="detail-value">${formatDate(credential.expiryDate)}</div>
                    </div>
                    <div class="detail-item">
                        <label>Authorized to Issue</label>
                        <div class="detail-value">${credential.claims.authorizedToIssueCredentials ? '✅ Yes' : '❌ No'}</div>
                    </div>
                </div>
            </div>

            <div class="detail-section">
                <h4>DID Information</h4>
                <div class="detail-grid">
                    <div class="detail-item full-width">
                        <label>Issuer DID</label>
                        <div class="detail-value"><code>${escapeHtml(credential.issuer || 'N/A')}</code></div>
                    </div>
                    <div class="detail-item full-width">
                        <label>Subject DID</label>
                        <div class="detail-value"><code>${escapeHtml(credential.subject || 'N/A')}</code></div>
                    </div>
                </div>
            </div>

            ${credential.credentialStatus ? `
            <div class="detail-section">
                <h4>Revocation Information</h4>
                <div class="detail-grid">
                    <div class="detail-item">
                        <label>Status Purpose</label>
                        <div class="detail-value">${escapeHtml(credential.credentialStatus.statusPurpose)}</div>
                    </div>
                    <div class="detail-item">
                        <label>Status List Index</label>
                        <div class="detail-value">${escapeHtml(credential.credentialStatus.statusListIndex)}</div>
                    </div>
                    <div class="detail-item full-width">
                        <label>Status List Credential</label>
                        <div class="detail-value"><code style="font-size: 0.9em;">${escapeHtml(credential.credentialStatus.statusListCredential)}</code></div>
                    </div>
                </div>
            </div>
            ` : ''}

            <div class="detail-section">
                <h4>JWT Credential</h4>
                <textarea id="jwt-credential-text" readonly style="width: 100%; height: 120px; font-family: monospace; font-size: 0.85em; padding: 8px;">${escapeHtml(credential.jwtCredential)}</textarea>
                <button class="btn btn-secondary" onclick="copyToClipboard('jwt-credential-text')">
                    Copy JWT to Clipboard
                </button>
            </div>
        </div>
    `;

    content.innerHTML = detailsHTML;
    modal.classList.remove('hidden');
}

/**
 * Close credential details modal
 */
function closeCredentialDetailsModal() {
    const modal = document.getElementById('credential-details-modal');
    modal.classList.add('hidden');
}

/**
 * Copy credential JWT to clipboard
 */
function copyCredentialJWT(recordId) {
    const credential = allCredentials.find(c => c.recordId === recordId);

    if (!credential || !credential.jwtCredential) {
        showNotification('Credential JWT not found', 'error');
        return;
    }

    copyToClipboardDirect(credential.jwtCredential);
    showNotification('JWT credential copied to clipboard', 'success');
}

/**
 * Copy text to clipboard (direct method)
 */
function copyToClipboardDirect(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
}

/**
 * Copy text from textarea to clipboard
 */
function copyToClipboard(elementId) {
    const element = document.getElementById(elementId);
    if (element) {
        element.select();
        document.execCommand('copy');
        showNotification('Copied to clipboard', 'success');
    }
}

// ─── Admin Chat ──────────────────────────────────────────────────────────────

Object.assign(app, {
    _adminChatSelectedConnectionId: null,
    _adminChatSelectedName: null,
    _adminChatLastSeen: {}, // connectionId → timestamp
    _adminChatPollTimer: null,
    _adminChatEmployees: [],

    async loadAdminChat() {
        try {
            const res = await fetch('/company-admin/api/admin/employee-index');
            const data = await res.json();
            if (!data.success) return;
            this._adminChatEmployees = data.employees || [];
            this._renderAdminChatSidebar();
        } catch (e) {
            console.warn('[AdminChat] loadAdminChat error:', e.message);
        }
    },

    _renderAdminChatSidebar() {
        const list = document.getElementById('admin-chat-employee-list');
        if (!list) return;
        if (this._adminChatEmployees.length === 0) {
            list.innerHTML = '<p style="color:#94a3b8; font-size:13px;">No active employee connections yet.</p>';
            return;
        }
        list.innerHTML = this._adminChatEmployees.map(emp => {
            const isSelected = this._adminChatSelectedConnectionId === emp.connectionId;
            const unread = emp.unreadCount || 0;
            return `<div onclick="app.selectAdminChatEmployee('${escapeHtml(emp.connectionId)}','${escapeHtml(emp.name || emp.label)}','${escapeHtml(emp.email||'')}') "
                style="padding:10px 12px; border-radius:8px; cursor:pointer; margin-bottom:4px;
                    background:${isSelected ? 'rgba(6,182,212,0.15)' : 'transparent'};
                    border-left:${isSelected ? '3px solid #06b6d4' : '3px solid transparent'};
                    transition:background 0.15s;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div>
                        <div style="font-weight:600; color:#e2e8f0; font-size:13px;">${escapeHtml(emp.name || emp.label || emp.connectionId.slice(0,8))}</div>
                        ${emp.email ? `<div style="font-size:11px; color:#64748b;">${escapeHtml(emp.email)}</div>` : ''}
                    </div>
                    ${unread > 0 ? `<span style="background:#0ea5e9; color:#fff; border-radius:99px; font-size:11px; padding:1px 7px;">${unread}</span>` : ''}
                </div>
            </div>`;
        }).join('');
    },

    selectAdminChatEmployee(connectionId, name, email) {
        this._adminChatSelectedConnectionId = connectionId;
        this._adminChatSelectedName = name;
        this._renderAdminChatSidebar();

        // Show header + input
        const header = document.getElementById('admin-chat-header');
        if (header) { header.style.display = 'block'; }
        document.getElementById('admin-chat-header-name').textContent = name || connectionId.slice(0,8);
        document.getElementById('admin-chat-header-email').textContent = email || '';
        const inputArea = document.getElementById('admin-chat-input-area');
        if (inputArea) inputArea.style.display = 'flex';

        // Clear messages
        const msgBox = document.getElementById('admin-chat-messages');
        if (msgBox) msgBox.innerHTML = '<p style="color:#64748b; text-align:center; margin:auto; font-size:13px;">Loading…</p>';

        // Load messages
        this._pollAdminChat();

        // Start poll timer
        if (this._adminChatPollTimer) clearInterval(this._adminChatPollTimer);
        this._adminChatPollTimer = setInterval(() => this._pollAdminChat(), 3000);
    },

    async _pollAdminChat() {
        const connId = this._adminChatSelectedConnectionId;
        if (!connId) return;
        const since = this._adminChatLastSeen[connId] || 0;
        try {
            const res = await fetch(`/company-admin/api/admin/messages/${encodeURIComponent(connId)}?since=${since}`);
            const data = await res.json();
            if (!data.success) return;
            const msgs = data.messages || [];
            if (msgs.length === 0 && since === 0) {
                document.getElementById('admin-chat-messages').innerHTML =
                    '<p style="color:#64748b; text-align:center; margin:auto; font-size:13px;">No messages yet. Send the first message!</p>';
                return;
            }
            if (msgs.length > 0) {
                this._adminChatLastSeen[connId] = Date.now();
                this._renderAdminChatMessages(connId, msgs, since === 0);
            }
        } catch (e) {
            console.warn('[AdminChat] poll error:', e.message);
        }
    },

    _renderAdminChatMessages(connId, msgs, replace) {
        const msgBox = document.getElementById('admin-chat-messages');
        if (!msgBox) return;
        const html = msgs.map(m => {
            const isAdmin = m.sentByAdmin;
            const time = new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            return `<div style="display:flex; flex-direction:column; align-items:${isAdmin ? 'flex-end' : 'flex-start'}; gap:2px;">
                <div style="max-width:70%; padding:8px 12px; border-radius:12px;
                    background:${isAdmin ? 'linear-gradient(135deg,#0ea5e9,#6366f1)' : '#1e293b'};
                    color:#e2e8f0; font-size:13px; line-height:1.5;">
                    ${escapeHtml(m.content)}
                </div>
                <div style="font-size:10px; color:#64748b;">${isAdmin ? 'You' : escapeHtml(m.fromLabel || m.from)} · ${time}</div>
            </div>`;
        }).join('');
        if (replace) {
            msgBox.innerHTML = html;
        } else {
            msgBox.insertAdjacentHTML('beforeend', html);
        }
        msgBox.scrollTop = msgBox.scrollHeight;
    },

    async sendAdminChatMessage() {
        const input = document.getElementById('admin-chat-input');
        const content = input?.value?.trim();
        if (!content || !this._adminChatSelectedConnectionId) return;
        input.value = '';
        try {
            const res = await fetch('/company-admin/api/admin/send-message', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ connectionId: this._adminChatSelectedConnectionId, content })
            });
            const data = await res.json();
            if (!data.success) { showNotification('Failed to send message: ' + (data.error || 'Unknown error'), 'error'); return; }
            // Optimistically add sent message
            this._renderAdminChatMessages(this._adminChatSelectedConnectionId, [{
                from: 'admin', fromLabel: 'Admin', content, timestamp: Date.now(), sentByAdmin: true
            }], false);
        } catch (e) {
            showNotification('Send failed: ' + e.message, 'error');
        }
    }
});

/**
 * Get status badge HTML
 */
function getStatusBadgeHTML(status) {
    const badges = {
        'active': '<span class="status-badge status-active">Active</span>',
        'revoked': '<span class="status-badge status-revoked">Revoked</span>',
        'expired': '<span class="status-badge status-expired">Expired</span>'
    };
    return badges[status] || `<span class="status-badge">${escapeHtml(status)}</span>`;
}

/**
 * Format date for display
 */
function formatDate(dateString) {
    if (!dateString) return 'N/A';
    try {
        const date = new Date(dateString);
        return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (e) {
        return dateString;
    }
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
