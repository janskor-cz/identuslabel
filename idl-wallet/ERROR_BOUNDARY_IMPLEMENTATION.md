# React Error Boundaries Implementation

## Overview

React Error Boundaries have been implemented in the Alice wallet to prevent full application crashes from uncaught component errors. This provides graceful error handling and improved user experience.

**Status**: ✅ IMPLEMENTED (November 7, 2025)

---

## What Are Error Boundaries?

Error boundaries are React components that:
- Catch JavaScript errors anywhere in their child component tree
- Log those errors to the console
- Display a fallback UI instead of crashing the entire component tree
- Prevent cascading failures that would force a full page reload

**Important**: Error boundaries do NOT catch:
- Errors in event handlers (use try-catch)
- Errors in asynchronous code (setTimeout, promises)
- Errors in server-side rendering
- Errors thrown in the error boundary itself

---

## Implementation Details

### 1. ErrorBoundary Component

**File**: `/src/components/ErrorBoundary.tsx`

**Features**:
- Catches and displays component errors gracefully
- Provides detailed console logging with component stack traces
- Supports custom fallback UI
- Includes "Try Again" button to reset error state
- Optional error callback for custom error handling
- Named component tracking for debugging

**Props**:
```typescript
interface Props {
  children: ReactNode;              // Child components to protect
  fallback?: ReactNode;              // Custom error UI (optional)
  onError?: (error, errorInfo) => void;  // Error callback (optional)
  componentName?: string;            // For debugging (optional)
}
```

**Default Fallback UI**:
```tsx
<div className="p-4 bg-red-50 border border-red-200 rounded-lg">
  <div className="flex items-center gap-2 mb-2">
    <span className="text-red-600 text-xl">⚠️</span>
    <h3 className="text-red-800 font-bold">Something went wrong</h3>
  </div>
  <p className="text-red-600 text-sm mb-3">
    {error.message}
  </p>
  <button onClick={resetError}>Try Again</button>
</div>
```

---

## Protected Components

### Credentials Page (`/pages/credentials.tsx`)

**Protected Sections**:
1. **Identity Credentials** - Each credential card wrapped individually
2. **Security Clearances** - Each clearance card wrapped individually
3. **Expired Credentials** - Each expired credential card wrapped individually

**Implementation**:
```tsx
{identityCredentials.map((credential, i) => (
  <ErrorBoundary
    key={`identity-${refreshKey}-${credential.id}-${i}`}
    componentName={`CredentialCard-Identity-${i}`}
  >
    <CredentialCard
      credential={credential}
      onDelete={handleDeleteCredential}
      status={credentialStatuses.get(credential.id)}
    />
  </ErrorBoundary>
))}
```

**Benefits**:
- ✅ Single credential error doesn't crash entire credentials page
- ✅ Other credentials remain visible and functional
- ✅ User can continue using wallet with remaining valid credentials
- ✅ Detailed error logging identifies problematic credential

---

### Connections Page (`/pages/connections.tsx`)

**Protected Sections**:
1. **Connection Requests** - Each request wrapped individually

**Implementation**:
```tsx
{persistentRequests.map((requestItem, i) => (
  <ErrorBoundary
    key={`persistent-request-${requestItem.id}-${i}`}
    componentName={`ConnectionRequest-${i}`}
  >
    <div className="relative">
      <ConnectionRequest
        message={reconstructedMessage}
        attachedCredential={requestItem.attachedCredential}
        onRequestHandled={handleRequestAction}
      />
    </div>
  </ErrorBoundary>
))}
```

**Benefits**:
- ✅ Single corrupted connection request doesn't break connections page
- ✅ Other pending requests remain accessible
- ✅ User can still manage established connections
- ✅ Error logging helps debug malformed DIDComm messages

---

### Messages Page (`/pages/messages.tsx`)

**Protected Sections**:
1. **Chat Component** - Entire chat interface wrapped
2. **Individual Messages** - Each message in "All Messages" tab wrapped

**Implementation**:
```tsx
{/* Chat Tab */}
{activeTab === 'chat' && (
  <ErrorBoundary componentName="Chat">
    <Chat
      messages={conversationMessages}
      connection={selectedConnection}
      onSendMessage={handleSendMessage}
    />
  </ErrorBoundary>
)}

{/* All Messages Tab */}
{conversationMessages.map((message, i) => (
  <ErrorBoundary
    key={`message-${message.id}_${i}`}
    componentName={`Message-${i}`}
  >
    <div className="...">
      <Message message={message} />
    </div>
  </ErrorBoundary>
))}
```

**Benefits**:
- ✅ Chat component errors don't crash messages page
- ✅ Single corrupted message doesn't break message list
- ✅ User can still view other messages and send new ones
- ✅ Decryption errors handled gracefully

---

## Error Scenarios Handled

### 1. Credential Status Verification Failures

**Scenario**: StatusList2021 endpoint unavailable or returns invalid data

**Without Error Boundary**:
```
❌ Entire credentials page crashes
❌ User sees blank screen
❌ All credentials become inaccessible
❌ Requires page reload
```

**With Error Boundary**:
```
✅ Only affected credential card shows error
✅ Other credentials display normally
✅ User can still delete problematic credential
✅ "Try Again" button allows retry
```

**Console Output**:
```
🚨 [ErrorBoundary] Caught error in CredentialCard-Identity-2:
Error: Failed to fetch StatusList from https://identuslabel.cz/cloud-agent/credential-status/abc123
🚨 [ErrorBoundary] Component stack:
    at CredentialCard (CredentialCard.tsx:156)
    at ErrorBoundary (ErrorBoundary.tsx:23)
    ...
```

---

### 2. Malformed DIDComm Messages

**Scenario**: Connection request with corrupted attachment data

**Without Error Boundary**:
```
❌ Connections page crashes completely
❌ Cannot accept any pending requests
❌ Cannot view established connections
❌ Requires page reload and lost state
```

**With Error Boundary**:
```
✅ Only corrupted request shows error
✅ Other requests remain functional
✅ Established connections still accessible
✅ User can reject problematic request
```

---

### 3. Encryption/Decryption Errors

**Scenario**: X25519 key mismatch or corrupted ciphertext

**Without Error Boundary**:
```
❌ Chat component crashes
❌ Cannot send or view any messages
❌ Connection becomes unusable
❌ Requires connection deletion and recreation
```

**With Error Boundary**:
```
✅ Only affected message shows error
✅ Can still send new messages
✅ Other messages display correctly
✅ Error details help diagnose key issues
```

---

## Console Logging

Error boundaries provide detailed console output for debugging:

**Error Caught**:
```javascript
🚨 [ErrorBoundary] Caught error in CredentialCard-Identity-0:
Error: Cannot read property 'credentialSubject' of undefined

🚨 [ErrorBoundary] Component stack:
    at CredentialCard (http://localhost:3001/credentials:156:23)
    at ErrorBoundary (http://localhost:3001/ErrorBoundary:23:5)
    at div
    at section
    at div
    ...
```

**Stack Trace Includes**:
- Component name (if provided via `componentName` prop)
- Error message and type
- Full component hierarchy
- File locations and line numbers
- Allows pinpointing exact failure location

---

## User Experience

### Visual Feedback

**Error State**:
- Red-bordered container with warning icon ⚠️
- Clear error message (non-technical where possible)
- "Try Again" button to retry operation
- Surrounding content remains functional

**Example**:
```
┌─────────────────────────────────────┐
│ ⚠️ Something went wrong            │
│                                     │
│ Failed to verify credential status  │
│                                     │
│ [ Try Again ]                       │
└─────────────────────────────────────┘
```

### Recovery Options

1. **Try Again Button**: Resets error state and re-renders component
2. **Delete Action**: User can delete problematic credential/connection
3. **Page Navigation**: Other pages remain functional
4. **Manual Refresh**: Hard refresh (Ctrl+Shift+R) as last resort

---

## Best Practices

### 1. Granular Error Boundaries

**✅ DO**: Wrap individual list items
```tsx
{credentials.map((credential, i) => (
  <ErrorBoundary key={i} componentName={`Credential-${i}`}>
    <CredentialCard credential={credential} />
  </ErrorBoundary>
))}
```

**❌ DON'T**: Wrap entire page in single boundary
```tsx
<ErrorBoundary componentName="CredentialsPage">
  {/* Entire page here - too broad! */}
</ErrorBoundary>
```

**Why**: Granular boundaries isolate failures to smallest possible scope.

---

### 2. Meaningful Component Names

**✅ DO**: Descriptive names for debugging
```tsx
<ErrorBoundary componentName={`CredentialCard-${credentialType}-${index}`}>
```

**❌ DON'T**: Generic or missing names
```tsx
<ErrorBoundary>  {/* No componentName prop */}
```

**Why**: Component names appear in logs and help identify failure location.

---

### 3. Custom Fallback UI

**✅ DO**: Provide context-specific fallbacks when needed
```tsx
<ErrorBoundary
  fallback={
    <div className="p-4 border border-red-300 rounded">
      <p>This credential cannot be displayed.</p>
      <button onClick={onDelete}>Delete Credential</button>
    </div>
  }
>
  <CredentialCard credential={credential} />
</ErrorBoundary>
```

**Why**: Context-aware error messages improve user understanding.

---

### 4. Error Callbacks

**✅ DO**: Use callbacks for custom error handling
```tsx
<ErrorBoundary
  componentName="CredentialCard"
  onError={(error, errorInfo) => {
    // Log to analytics/monitoring service
    analytics.logError({
      component: 'CredentialCard',
      error: error.message,
      stack: errorInfo.componentStack
    });
  }}
>
  <CredentialCard credential={credential} />
</ErrorBoundary>
```

**Why**: Enables error tracking and monitoring in production.

---

## Testing Error Boundaries

### Manual Testing

**Test 1: Trigger Credential Status Error**
```javascript
// In browser console
// Break StatusList verification temporarily
const originalFetch = window.fetch;
window.fetch = (url) => {
  if (url.includes('credential-status')) {
    return Promise.reject(new Error('StatusList endpoint unavailable'));
  }
  return originalFetch(url);
};

// Navigate to Credentials page
// Expected: Error boundary catches failure for affected credential
// Other credentials display normally
```

**Test 2: Corrupt Credential Data**
```javascript
// In browser console
// Find credential in IndexedDB and corrupt it
const db = await indexedDB.open('identus-wallet-alice');
// ... manipulate credential data to be invalid
// Expected: Error boundary shows fallback UI for corrupted credential
```

---

### Automated Testing (Future)

**With React Testing Library**:
```typescript
import { render, screen } from '@testing-library/react';
import { ErrorBoundary } from '@/components/ErrorBoundary';

const ThrowError = () => {
  throw new Error('Test error');
};

test('ErrorBoundary catches and displays error', () => {
  // Suppress console.error for test
  const spy = jest.spyOn(console, 'error').mockImplementation();

  render(
    <ErrorBoundary componentName="TestComponent">
      <ThrowError />
    </ErrorBoundary>
  );

  expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  expect(screen.getByText('Test error')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Try Again' })).toBeInTheDocument();

  spy.mockRestore();
});
```

---

## Known Limitations

### 1. Event Handlers Not Caught

Error boundaries do NOT catch errors in event handlers:

```tsx
// ❌ NOT caught by error boundary
<button onClick={() => {
  throw new Error('Button error');
}}>
  Click
</button>

// ✅ Wrap in try-catch instead
<button onClick={() => {
  try {
    riskyOperation();
  } catch (error) {
    console.error('Button error:', error);
    showErrorToast(error.message);
  }
}}>
  Click
</button>
```

---

### 2. Async Code Not Caught

Error boundaries do NOT catch errors in promises or async functions:

```tsx
// ❌ NOT caught by error boundary
useEffect(() => {
  async function fetchData() {
    throw new Error('Async error');
  }
  fetchData();
}, []);

// ✅ Use try-catch in async code
useEffect(() => {
  async function fetchData() {
    try {
      await riskyAsyncOperation();
    } catch (error) {
      console.error('Async error:', error);
      setErrorState(error.message);
    }
  }
  fetchData();
}, []);
```

---

### 3. Error Boundary Errors Not Caught

If the ErrorBoundary component itself has a bug, it won't catch its own errors. This is by design to prevent infinite loops.

**Solution**: Keep ErrorBoundary component simple and well-tested.

---

## Future Enhancements

### 1. Error Reporting Service Integration

```typescript
<ErrorBoundary
  componentName="CredentialCard"
  onError={(error, errorInfo) => {
    // Send to Sentry, Rollbar, etc.
    errorReportingService.captureError({
      error,
      componentStack: errorInfo.componentStack,
      walletId: app.walletId,
      userAgent: navigator.userAgent
    });
  }}
>
  <CredentialCard credential={credential} />
</ErrorBoundary>
```

---

### 2. User-Friendly Error Messages

Map technical errors to user-friendly messages:

```typescript
const ERROR_MESSAGES = {
  'StatusList endpoint unavailable': 'Cannot verify credential status right now. Please try again later.',
  'Invalid JWT token': 'This credential is corrupted and cannot be displayed.',
  'X25519 decryption failed': 'Cannot decrypt this message. The encryption keys may be invalid.'
};

function getUserFriendlyMessage(error: Error): string {
  for (const [pattern, message] of Object.entries(ERROR_MESSAGES)) {
    if (error.message.includes(pattern)) {
      return message;
    }
  }
  return 'An unexpected error occurred. Please try refreshing the page.';
}
```

---

### 3. Retry with Exponential Backoff

```typescript
<ErrorBoundary
  componentName="CredentialCard"
  fallback={
    <RetryableError
      error={error}
      onRetry={handleRetry}
      maxRetries={3}
      backoffMs={[1000, 3000, 10000]}
    />
  }
>
  <CredentialCard credential={credential} />
</ErrorBoundary>
```

---

## Troubleshooting

### Issue: Error Boundary Not Catching Error

**Symptom**: Component crashes but error boundary doesn't catch it

**Possible Causes**:
1. Error in event handler (use try-catch)
2. Error in async code (use try-catch)
3. Error in error boundary itself
4. Error during server-side rendering

**Solution**: Add console.log in ErrorBoundary.componentDidCatch to verify it's being called.

---

### Issue: Error Boundary Shows Blank Screen

**Symptom**: Error boundary catches error but displays nothing

**Possible Cause**: Custom fallback rendering error

**Solution**: Check fallback prop for errors, remove temporarily to use default fallback.

---

### Issue: "Try Again" Button Doesn't Work

**Symptom**: Clicking button doesn't reset error state

**Possible Cause**: Error persists on re-render (e.g., bad data still in state)

**Solution**: Ensure underlying issue is resolved before retry, or provide delete/skip option.

---

## Related Files

**Core Implementation**:
- `/src/components/ErrorBoundary.tsx` - Main error boundary component

**Integration**:
- `/src/pages/credentials.tsx` - Credential cards protected
- `/src/pages/connections.tsx` - Connection requests protected
- `/src/pages/messages.tsx` - Chat and messages protected

**Documentation**:
- `/ERROR_BOUNDARY_IMPLEMENTATION.md` - This file
- `/root/CLAUDE.md` - Infrastructure documentation
- `/root/clean-identus-wallet/CLAUDE.md` - Wallet-specific documentation

---

## References

**Official React Documentation**:
- Error Boundaries: https://react.dev/reference/react/Component#catching-rendering-errors-with-an-error-boundary
- componentDidCatch: https://react.dev/reference/react/Component#componentdidcatch
- getDerivedStateFromError: https://react.dev/reference/react/Component#static-getderivedstatefromerror

**Best Practices**:
- Kent C. Dodds - "Use React Error Boundaries to handle errors in React": https://kentcdodds.com/blog/use-react-error-boundary-to-handle-errors-in-react

---

**Document Version**: 1.0
**Implementation Date**: November 7, 2025
**Status**: ✅ Production-Ready
**Author**: Hyperledger Identus SSI Infrastructure Team
