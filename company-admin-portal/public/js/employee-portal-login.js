/**
 * Employee Portal Login - Authentication Flow
 *
 * Implements wallet-based authentication using proof requests
 * and automatic redirection based on training status.
 */

const employeeLogin = {
    // Configuration
    config: {
        pollInterval: 2000,        // Poll every 2 seconds
        maxPollAttempts: 150,      // 5 minutes maximum (150 * 2s)
        apiBasePath: '/company-admin/api/employee-portal'
    },

    // State
    state: {
        presentationId: null,
        pollTimer: null,
        pollAttempts: 0,
        email: null
    },

    /**
     * Initialize the login page
     */
    init() {
        console.log('Employee Portal Login initialized');

        // Check if already authenticated
        const token = localStorage.getItem('employee_session_token');
        if (token) {
            this.verifyExistingSession(token);
        }
    },

    /**
     * Handle login form submission
     */
    async handleLoginSubmit(event) {
        event.preventDefault();

        let email = document.getElementById('employee-email').value.trim();

        if (!email) {
            this.showNotification('Please enter your email address', 'error');
            return;
        }

        // Use full email for database lookup
        console.log(`[Login] Using email for authentication: ${email}`);

        this.state.email = email;

        try {
            await this.initiateAuthentication(email);
        } catch (error) {
            console.error('Login error:', error);
            this.showError(error.message || 'Failed to initiate authentication');
        }
    },

    /**
     * Initiate authentication flow
     */
    async initiateAuthentication(email) {
        this.showWaitingScreen('Initializing authentication...');
        document.getElementById('auth-email').textContent = email;

        try {
            const response = await fetch(`${this.config.apiBasePath}/auth/initiate`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ identifier: email })
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.message || 'Failed to initiate authentication');
            }

            const data = await response.json();
            this.state.presentationId = data.presentationId;

            console.log('Authentication initiated:', {
                presentationId: data.presentationId,
                email: email
            });

            // Show waiting screen with instructions
            this.updateWaitingScreen(
                'Waiting for wallet response...',
                'Please approve the proof request in your Cloud Agent wallet. This may take a moment.'
            );

            // Start polling for status
            this.startPolling();

        } catch (error) {
            throw error;
        }
    },

    /**
     * Start polling for authentication status
     */
    startPolling() {
        this.state.pollAttempts = 0;

        this.state.pollTimer = setInterval(async () => {
            this.state.pollAttempts++;

            // Update status display
            document.getElementById('auth-status').textContent =
                `Waiting... (${this.state.pollAttempts}/${this.config.maxPollAttempts})`;

            // Check timeout
            if (this.state.pollAttempts >= this.config.maxPollAttempts) {
                this.stopPolling();
                this.showError('Authentication timed out. Please try again.');
                return;
            }

            try {
                await this.checkAuthStatus();
            } catch (error) {
                console.error('Polling error:', error);
                // Continue polling on error (might be temporary)
            }
        }, this.config.pollInterval);
    },

    /**
     * Check authentication status
     */
    async checkAuthStatus() {
        if (!this.state.presentationId) {
            return;
        }

        try {
            const response = await fetch(
                `${this.config.apiBasePath}/auth/status/${this.state.presentationId}`
            );

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.message || 'Failed to check status');
            }

            const data = await response.json();

            console.log('Auth status:', data);

            // Update status display
            document.getElementById('auth-status').textContent =
                this.formatStatus(data.status);

            // Check if authentication is complete
            if (data.status === 'verified') {
                this.stopPolling();
                await this.completeAuthentication();
            } else if (data.status === 'failed') {
                this.stopPolling();
                this.showError('Authentication failed. Please try again.');
            }

        } catch (error) {
            console.error('Status check error:', error);
            // Don't stop polling on network errors
        }
    },

    /**
     * Complete authentication and redirect
     */
    async completeAuthentication() {
        this.updateWaitingScreen(
            'Authentication successful!',
            'Verifying credentials and checking training status...'
        );

        try {
            const response = await fetch(`${this.config.apiBasePath}/auth/verify`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    presentationId: this.state.presentationId
                })
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.message || 'Verification failed');
            }

            const data = await response.json();

            console.log('Authentication complete:', data);
            console.log('Session token from server:', data.sessionToken);

            // CRITICAL FIX: Backend sends "sessionToken" not "token"
            if (!data.sessionToken) {
                console.error('❌ BUG: Backend response missing sessionToken field!');
                console.error('Response data:', data);
                throw new Error('Server did not return a session token');
            }

            // Store session token
            localStorage.setItem('employee_session_token', data.sessionToken);
            localStorage.setItem('employeeEmail', this.state.email);

            // Show success notification
            this.showNotification('Authentication successful! Redirecting...', 'success');

            // Redirect based on training status
            setTimeout(() => {
                if (!data.training.hasValidTraining) {
                    // Redirect to training page
                    window.location.href = '/company-admin/employee-training.html';
                } else {
                    // Redirect to dashboard
                    window.location.href = '/company-admin/employee-portal-dashboard.html';
                }
            }, 1500);

        } catch (error) {
            console.error('Verification error:', error);
            this.showError(error.message || 'Failed to complete authentication');
        }
    },

    /**
     * Verify existing session
     */
    async verifyExistingSession(token) {
        try {
            const response = await fetch(`${this.config.apiBasePath}/auth/session`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            if (response.ok) {
                const data = await response.json();

                // Session is valid, redirect to appropriate page
                if (!data.training.hasValidTraining) {
                    window.location.href = '/company-admin/employee-training.html';
                } else {
                    window.location.href = '/company-admin/employee-portal-dashboard.html';
                }
            } else {
                // Invalid session, clear token
                localStorage.removeItem('employee_session_token');
                localStorage.removeItem('employeeEmail');
            }
        } catch (error) {
            console.error('Session verification error:', error);
            // Continue to login page
        }
    },

    /**
     * Stop polling timer
     */
    stopPolling() {
        if (this.state.pollTimer) {
            clearInterval(this.state.pollTimer);
            this.state.pollTimer = null;
        }
    },

    /**
     * Cancel login and return to form
     */
    cancelLogin() {
        this.stopPolling();
        this.resetForm();
    },

    /**
     * Reset form to initial state
     */
    resetForm() {
        this.stopPolling();

        // Reset state
        this.state.presentationId = null;
        this.state.pollAttempts = 0;
        this.state.email = null;

        // Show login form
        document.getElementById('login-form-section').classList.remove('hidden');
        document.getElementById('waiting-section').classList.add('hidden');
        document.getElementById('error-section').classList.add('hidden');

        // Clear form
        document.getElementById('employee-login-form').reset();
    },

    /**
     * Show waiting screen
     */
    showWaitingScreen(title, message = null) {
        document.getElementById('login-form-section').classList.add('hidden');
        document.getElementById('error-section').classList.add('hidden');
        document.getElementById('waiting-section').classList.remove('hidden');

        if (title) {
            document.getElementById('waiting-title').textContent = title;
        }
        if (message) {
            document.getElementById('waiting-message').textContent = message;
        }
    },

    /**
     * Update waiting screen
     */
    updateWaitingScreen(title, message) {
        document.getElementById('waiting-title').textContent = title;
        document.getElementById('waiting-message').textContent = message;
    },

    /**
     * Show error screen
     */
    showError(message) {
        this.stopPolling();

        document.getElementById('login-form-section').classList.add('hidden');
        document.getElementById('waiting-section').classList.add('hidden');
        document.getElementById('error-section').classList.remove('hidden');

        document.getElementById('error-message').textContent = message;
    },

    /**
     * Format status for display
     */
    formatStatus(status) {
        const statusMap = {
            'pending': 'Waiting for wallet approval',
            'processing': 'Processing proof...',
            'verified': 'Verified ✓',
            'failed': 'Failed ✗',
            'timeout': 'Timed out ⏱'
        };

        return statusMap[status] || status;
    },

    /**
     * Validate email format
     */
    isValidEmail(email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    },

    /**
     * Show notification toast
     */
    showNotification(message, type = 'info') {
        const toast = document.getElementById('notification-toast');
        const messageEl = document.getElementById('notification-message');

        messageEl.textContent = message;
        toast.className = `notification-toast notification-${type}`;
        toast.classList.remove('hidden');

        setTimeout(() => {
            toast.classList.add('hidden');
        }, 5000);
    }
};

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    employeeLogin.init();
});

// Clean up on page unload
window.addEventListener('beforeunload', () => {
    employeeLogin.stopPolling();
});
