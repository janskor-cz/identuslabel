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
            return;
        }

        tbody.innerHTML = this.employees.map(employee => {
            const statusClass = this.getStatusClass(employee.state);
            const createdDate = new Date(employee.createdAt).toLocaleDateString();

            return `
                <tr>
                    <td>
                        <strong>${employee.label || 'Unnamed Employee'}</strong>
                    </td>
                    <td>
                        <code class="connection-id">${employee.connectionId.substring(0, 12)}...</code>
                    </td>
                    <td>
                        <span class="status-badge ${statusClass}">${employee.state}</span>
                    </td>
                    <td>${createdDate}</td>
                    <td class="actions">
                        <button class="btn btn-sm btn-secondary"
                                onclick="app.issueCredential('${employee.connectionId}', '${employee.label}')">
                            Issue Credential
                        </button>
                        <button class="btn btn-sm btn-danger"
                                onclick="app.removeEmployee('${employee.connectionId}', '${employee.label}')">
                            Remove
                        </button>
                    </td>
                </tr>
            `;
        }).join('');
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
        const employeeName = formData.get('employeeName');
        const role = formData.get('role');
        const department = formData.get('department');

        console.log('[INVITE] Creating invitation for:', employeeName);

        try {
            const response = await fetch('/company-admin/api/company/invite-employee', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ employeeName, role, department })
            });

            const data = await response.json();

            if (data.success) {
                // Show invitation result
                this.showInvitationResult(employeeName, data.invitation.invitationUrl);
                this.showNotification(`Invitation created for ${employeeName}`, 'success');
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
    async showInvitationResult(employeeName, invitationUrl) {
        // Hide form, show result
        document.getElementById('invite-form').classList.add('hidden');
        document.getElementById('invitation-result').classList.remove('hidden');

        // Update employee name
        document.getElementById('invited-employee-name').textContent = employeeName;

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
     * Issue Service Configuration credential to employee
     */
    async issueCredential(connectionId, employeeName) {
        console.log('[SERVICE-CONFIG] Issuing Service Configuration VC to:', connectionId);

        // Extract name, role, department from label
        // Format: "Name (Role) - Department" or "Name - Department" or just "Name"
        let name = employeeName;
        let role = '';
        let department = '';

        // Parse label: "Jan Novak (Accountant) - Finance"
        const roleMatch = employeeName.match(/^([^(]+)\(([^)]+)\)(.*)$/);
        if (roleMatch) {
            name = roleMatch[1].trim();
            role = roleMatch[2].trim();
            const remainder = roleMatch[3].trim();
            if (remainder.startsWith('- ')) {
                department = remainder.substring(2).trim();
            }
        } else {
            // Try "Name - Department" format
            const deptMatch = employeeName.match(/^([^-]+)-(.+)$/);
            if (deptMatch) {
                name = deptMatch[1].trim();
                department = deptMatch[2].trim();
            }
        }

        // Show modal to collect email and confirm details
        const modal = document.createElement('div');
        modal.className = 'modal fade show';
        modal.style.display = 'block';
        modal.style.backgroundColor = 'rgba(0,0,0,0.5)';
        modal.innerHTML = `
            <div class="modal-dialog">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">📋 Issue Service Configuration VC</h5>
                        <button type="button" class="close" onclick="this.closest('.modal').remove()">
                            <span>&times;</span>
                        </button>
                    </div>
                    <div class="modal-body">
                        <p><strong>Connection:</strong> ${connectionId}</p>
                        <hr>
                        <div class="form-group">
                            <label>Employee Name *</label>
                            <input type="text" class="form-control" id="employeeName" value="${name}" required>
                        </div>
                        <div class="form-group">
                            <label>Email Address *</label>
                            <input type="email" class="form-control" id="employeeEmail" placeholder="employee@techcorp.com" required>
                            <small class="form-text text-muted">Required for Enterprise Cloud Agent access</small>
                        </div>
                        <div class="form-group">
                            <label>Department *</label>
                            <select class="form-control" id="employeeDept" required>
                                <option value="">-- Select Department --</option>
                                <option value="HR" ${department === 'HR' ? 'selected' : ''}>HR</option>
                                <option value="IT" ${department === 'IT' ? 'selected' : ''}>IT</option>
                                <option value="Security" ${department === 'Security' ? 'selected' : ''}>Security</option>
                            </select>
                            <small class="form-text text-muted">Determines Enterprise Cloud Agent access level</small>
                        </div>
                        <div class="alert alert-info">
                            <strong>ℹ️ Service Configuration VC</strong><br>
                            This credential will grant the employee access to:
                            <ul class="mb-0 mt-2">
                                <li>Enterprise Cloud Agent (port 8300)</li>
                                <li>Department-specific API access</li>
                                <li>Internal company services</li>
                            </ul>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary" onclick="this.closest('.modal').remove()">Cancel</button>
                        <button type="button" class="btn btn-primary" id="confirmIssueBtn">Issue Credential</button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        // Handle confirm button
        document.getElementById('confirmIssueBtn').onclick = async () => {
            const employeeNameInput = document.getElementById('employeeName').value.trim();
            const employeeEmail = document.getElementById('employeeEmail').value.trim();
            const employeeDept = document.getElementById('employeeDept').value;

            if (!employeeNameInput || !employeeEmail || !employeeDept) {
                this.showNotification('Name, Email, and Department are required', 'error');
                return;
            }

            // Disable button and show loading
            const btn = document.getElementById('confirmIssueBtn');
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Issuing...';

            try {
                const response = await fetch(`/company-admin/api/company/connections/${connectionId}/auto-issue-config`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',  // Include session cookie
                    body: JSON.stringify({
                        name: employeeNameInput,
                        email: employeeEmail,
                        department: employeeDept
                    })
                });

                const data = await response.json();

                console.log('[SERVICE-CONFIG] Server response:', data);

                if (data.success) {
                    this.showNotification(`✅ Service Configuration VC issued to ${employeeNameInput}`, 'success');
                    console.log('[SERVICE-CONFIG] Credential issued:', data.data);
                    modal.remove();

                    // Reload employees to show updated state
                    await this.loadEmployees();
                } else {
                    console.error('[SERVICE-CONFIG] Error response:', data);
                    this.showNotification(data.error || 'Failed to issue credential', 'error');
                    btn.disabled = false;
                    btn.innerHTML = 'Issue Credential';
                }
            } catch (error) {
                console.error('[SERVICE-CONFIG] Error:', error);
                this.showNotification('Failed to issue credential: ' + error.message, 'error');
                btn.disabled = false;
                btn.innerHTML = 'Issue Credential';
            }
        };
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
