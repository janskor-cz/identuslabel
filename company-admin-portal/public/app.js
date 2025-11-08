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
            const response = await fetch('/api/auth/current');
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
            const response = await fetch('/api/companies');
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
            const response = await fetch('/api/auth/login', {
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
            await fetch('/api/auth/logout', { method: 'POST' });
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
    },

    /**
     * Load company information
     */
    async loadCompanyInfo() {
        console.log('[DATA] Loading company info');

        try {
            const response = await fetch('/api/company/info');
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
            const response = await fetch('/api/company/connections');
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
            const response = await fetch('/api/company/invite-employee', {
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
     */
    showInvitationResult(employeeName, invitationUrl) {
        // Hide form, show result
        document.getElementById('invite-form').classList.add('hidden');
        document.getElementById('invitation-result').classList.remove('hidden');

        // Update employee name
        document.getElementById('invited-employee-name').textContent = employeeName;

        // Set invitation URL
        document.getElementById('invitation-url').value = invitationUrl;

        // Generate QR code
        const canvas = document.getElementById('invitation-qr');
        QRCode.toCanvas(canvas, invitationUrl, {
            width: 256,
            margin: 2,
            color: {
                dark: '#000000',
                light: '#ffffff'
            }
        }, (error) => {
            if (error) {
                console.error('[QR] Error generating QR code:', error);
            } else {
                console.log('[QR] QR code generated successfully');
            }
        });
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
     * Issue credential to employee
     */
    async issueCredential(connectionId, employeeName) {
        if (!confirm(`Issue credential to ${employeeName}?`)) {
            return;
        }

        console.log('[CREDENTIAL] Issuing credential to:', connectionId);

        try {
            const response = await fetch('/api/company/issue-credential', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    connectionId,
                    credentialType: 'EmployeeCredential',
                    claims: {
                        organization: this.currentCompany.displayName,
                        credentialType: 'EmployeeCredential',
                        issuedAt: new Date().toISOString()
                    }
                })
            });

            const data = await response.json();

            if (data.success) {
                this.showNotification(`Credential issued to ${employeeName}`, 'success');
            } else {
                this.showNotification(data.error || 'Failed to issue credential', 'error');
            }
        } catch (error) {
            console.error('[CREDENTIAL] Error:', error);
            this.showNotification('Failed to issue credential', 'error');
        }
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
            const response = await fetch(`/api/company/connections/${connectionId}`, {
                method: 'DELETE'
            });

            const data = await response.json();

            if (data.success) {
                this.showNotification(`Removed ${employeeName}`, 'success');
                await this.loadEmployees();
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
