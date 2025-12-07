# Employee Portal Login Page

**Status**: ✅ **CREATED** - Wallet-based authentication flow with automatic training redirection

## Overview

A clean, professional login page for employees to authenticate using their Cloud Agent wallets. Implements a polling-based authentication flow that redirects users to training or dashboard based on their completion status.

## Files Created

### 1. `/root/company-admin-portal/public/employee-portal-login.html`

**Purpose**: Login page HTML with three states (login form, waiting, error)

**Key Features**:
- Clean, gradient-based design matching Company Admin Portal branding
- Email input field with validation
- "Login with Wallet" button
- Real-time status display during authentication
- Error handling with retry capability
- Mobile-responsive layout

**UI States**:
1. **Login Form** (default): Email input + login button
2. **Waiting Screen**: Loading spinner + status updates + cancel button
3. **Error Screen**: Error message + retry button

### 2. `/root/company-admin-portal/public/js/employee-portal-login.js`

**Purpose**: Authentication flow logic with polling and session management

**Key Features**:
- Email validation (format checking)
- Authentication initiation via API
- Status polling (2-second interval, 5-minute timeout)
- Session token management (localStorage)
- Automatic redirection based on training status
- Comprehensive error handling
- Existing session verification

## Authentication Flow

### Step-by-Step Process

```
1. Employee visits login page
   └─> Check for existing session token
       ├─> Valid → Redirect to appropriate page
       └─> Invalid → Show login form

2. Employee enters email + clicks "Login with Wallet"
   └─> POST /api/employee-portal/auth/initiate
       └─> Returns: { presentationId }

3. Show waiting screen + start polling
   └─> Poll GET /api/employee-portal/auth/status/:presentationId (every 2s)
       ├─> Status: 'pending' → Continue polling
       ├─> Status: 'processing' → Continue polling
       ├─> Status: 'verified' → Proceed to step 4
       ├─> Status: 'failed' → Show error
       └─> Status: 'timeout' → Show error

4. Authentication verified
   └─> POST /api/employee-portal/auth/verify
       └─> Returns: { token, training: { completed: boolean } }
           ├─> Store token in localStorage
           └─> Redirect based on training status:
               ├─> training.completed = false → /employee-training.html
               └─> training.completed = true → /employee-portal-dashboard.html
```

### Polling Behavior

**Configuration**:
- Poll Interval: 2 seconds
- Max Attempts: 150 (5 minutes total)
- Auto-timeout after 5 minutes

**Status Display**:
- Shows current attempt count: "Waiting... (14/150)"
- Updates status message based on backend response
- Displays user's email for confirmation

## API Integration

### Expected Backend Endpoints

#### 1. Initiate Authentication

```
POST /company-admin/api/employee-portal/auth/initiate
Content-Type: application/json

Request Body:
{
  "email": "alice@techcorp.com"
}

Response (200 OK):
{
  "success": true,
  "presentationId": "uuid-v4-here",
  "message": "Proof request created. Please approve in your wallet."
}

Response (400 Bad Request):
{
  "success": false,
  "message": "Invalid email format"
}

Response (404 Not Found):
{
  "success": false,
  "message": "Employee not found"
}
```

#### 2. Check Status

```
GET /company-admin/api/employee-portal/auth/status/:presentationId

Response (200 OK):
{
  "success": true,
  "status": "pending" | "processing" | "verified" | "failed" | "timeout",
  "email": "alice@techcorp.com"
}
```

#### 3. Verify and Complete

```
POST /company-admin/api/employee-portal/auth/verify
Content-Type: application/json

Request Body:
{
  "presentationId": "uuid-v4-here"
}

Response (200 OK):
{
  "success": true,
  "token": "jwt-token-here",
  "employee": {
    "email": "alice@techcorp.com",
    "name": "Alice Cooper",
    "department": "Engineering"
  },
  "training": {
    "completed": false,
    "lastAccessed": null
  }
}
```

#### 4. Session Verification (Optional)

```
GET /company-admin/api/employee-portal/auth/session
Authorization: Bearer <jwt-token>

Response (200 OK):
{
  "success": true,
  "valid": true,
  "employee": { ... },
  "training": { completed: true }
}

Response (401 Unauthorized):
{
  "success": false,
  "message": "Invalid or expired token"
}
```

## User Experience

### Success Flow

1. **Initial Load** (0s)
   - Clean login form with email input
   - Professional branding matching Company Admin Portal

2. **Login Initiated** (0.5s)
   - Waiting screen appears
   - Loading spinner animation
   - Status: "Initializing authentication..."

3. **Polling Active** (0.5s - 30s typical)
   - Status updates: "Waiting for wallet approval"
   - Email confirmation displayed
   - Attempt counter visible
   - Cancel button available

4. **Verification Complete** (30s)
   - Status: "Authentication successful!"
   - Message: "Checking training status..."
   - Success notification toast

5. **Redirection** (32s)
   - Training incomplete → `/employee-training.html`
   - Training complete → `/employee-portal-dashboard.html`

### Error Scenarios

**Timeout (5 minutes)**:
- Error message: "Authentication timed out. Please try again."
- Retry button returns to login form

**Network Error**:
- Error message: "Network error. Please check your connection."
- Continues polling on transient errors

**Invalid Email**:
- Immediate validation feedback
- Notification toast: "Please enter a valid email address"

**Employee Not Found**:
- Error message: "Employee not found. Contact your administrator."
- Retry button available

## Security Features

### Session Management

**Token Storage**:
- JWT token stored in `localStorage` as `employeeAuthToken`
- Email stored in `localStorage` as `employeeEmail`
- Tokens cleared on logout or invalid session

**Token Validation**:
- Backend validates JWT signature
- Token expiration enforced
- Automatic session verification on page load

### Input Validation

**Email Validation**:
- Client-side format validation (regex)
- Server-side validation required
- Prevents injection attacks

**CSRF Protection**:
- Same-origin policy enforced
- CORS headers properly configured
- Session cookies with SameSite=Lax

## Configuration

### JavaScript Configuration

Located in `employeeLogin.config`:

```javascript
config: {
    pollInterval: 2000,        // Poll every 2 seconds
    maxPollAttempts: 150,      // 5 minutes maximum
    apiBasePath: '/company-admin/api/employee-portal'
}
```

**Customization Options**:
- Adjust `pollInterval` for faster/slower polling
- Modify `maxPollAttempts` for longer/shorter timeout
- Change `apiBasePath` for different API routes

## URL Access

### Development
```
http://localhost:3010/employee-portal-login.html
```

### Production (via Caddy)
```
https://identuslabel.cz/company-admin/employee-portal-login.html
```

**Note**: Caddy reverse proxy strips `/company-admin` prefix before forwarding to Express server on port 3010.

## Styling

Uses existing Company Admin Portal styles from `/public/styles.css`:

**Key Classes**:
- `.login-screen` - Full-screen container with gradient background
- `.login-container` - White card with rounded corners and shadow
- `.login-header` - Title and subtitle section
- `.form-group` - Form input styling
- `.btn-primary` - Primary action button (gradient)
- `.btn-secondary` - Secondary action button (gray)
- `.loading-spinner` - Animated loading indicator
- `.notification-toast` - Success/error notifications

**Design Principles**:
- Gradient background: `linear-gradient(135deg, #667eea 0%, #764ba2 100%)`
- White content cards with box shadows
- Consistent button styling and hover effects
- Mobile-responsive with flexbox/grid layouts

## Testing Checklist

### Manual Testing

- [ ] Page loads correctly via HTTPS domain
- [ ] Email validation works (invalid format rejected)
- [ ] Login button triggers authentication
- [ ] Waiting screen displays correctly
- [ ] Status updates during polling
- [ ] Timeout after 5 minutes works
- [ ] Cancel button returns to login form
- [ ] Error screen displays on failure
- [ ] Retry button resets form
- [ ] Notification toasts appear
- [ ] Redirection works after success
- [ ] Session persistence works (refresh page)
- [ ] Mobile responsive layout

### Integration Testing

- [ ] `/auth/initiate` endpoint responds correctly
- [ ] `/auth/status/:id` returns proper status
- [ ] `/auth/verify` completes authentication
- [ ] JWT token stored in localStorage
- [ ] Token used for subsequent requests
- [ ] Training status correctly determines redirect
- [ ] Invalid token handled gracefully

### Security Testing

- [ ] Email input sanitized
- [ ] JWT token validated server-side
- [ ] Token expiration enforced
- [ ] Session invalidation works
- [ ] CORS headers configured properly
- [ ] XSS protection in place
- [ ] CSRF protection enabled

## Future Enhancements

### Potential Improvements

1. **Remember Me**: Optional persistent login checkbox
2. **Loading Progress**: Visual progress bar during polling
3. **QR Code Login**: Alternative login via QR code scan
4. **Multi-Factor**: Additional verification step for sensitive roles
5. **Login History**: Display last login time and location
6. **Logout Notification**: Alert user if logged out elsewhere
7. **Accessibility**: ARIA labels and keyboard navigation
8. **Internationalization**: Multi-language support

### Performance Optimizations

1. **Adaptive Polling**: Increase interval after first minute
2. **WebSocket**: Real-time updates instead of polling
3. **Service Worker**: Offline login preparation
4. **Lazy Loading**: Load CSS/JS only when needed

## Troubleshooting

### Common Issues

**Issue**: Page shows 404 error
- **Cause**: Caddy not running or misconfigured
- **Fix**: Check Caddy logs, restart Caddy: `pkill caddy && /usr/local/bin/caddy run --config /root/Caddyfile &`

**Issue**: Polling never completes
- **Cause**: Backend not creating presentation or wallet not responding
- **Fix**: Check backend logs, verify Cloud Agent connectivity

**Issue**: Token not persisting
- **Cause**: localStorage disabled or browser in private mode
- **Fix**: Enable localStorage, use normal browsing mode

**Issue**: Redirect not working
- **Cause**: Training dashboard pages don't exist yet
- **Fix**: Create placeholder pages or modify redirect URLs

### Debug Commands

```bash
# Check if login page is accessible
curl -I http://localhost:3010/employee-portal-login.html

# Check if login page is accessible via Caddy
curl -I https://identuslabel.cz/company-admin/employee-portal-login.html

# Check Company Admin Portal logs
tail -f /tmp/company-admin.log

# Check browser console for JavaScript errors
# Open browser DevTools → Console tab

# Check localStorage for tokens
# Browser DevTools → Application → Local Storage
```

## Dependencies

### Frontend Dependencies

- **QRCode.js** (already loaded in base page): Not used in login page but available
- **Native Fetch API**: For HTTP requests (no jQuery/Axios needed)
- **localStorage API**: For session token storage

### Backend Dependencies

All backend dependencies are handled by the Company Admin Portal server (see `server.js`).

## Maintenance

### Regular Updates

- Review JWT token expiration policy (currently 24 hours in session config)
- Monitor polling timeout duration (adjust if users need more time)
- Update error messages based on user feedback
- Optimize polling interval based on backend performance

### Monitoring

- Track authentication success rate
- Monitor average authentication time
- Log failed authentication attempts
- Alert on high timeout rates

---

**Document Version**: 1.0
**Last Updated**: 2025-11-20
**Status**: Implementation Complete
**Maintained By**: Hyperledger Identus SSI Infrastructure Team
