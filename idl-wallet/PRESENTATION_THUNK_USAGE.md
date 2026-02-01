# Presentation Request Thunk Usage Guide

This document shows how to integrate the `sendVerifiablePresentation` and `declinePresentation` thunks into the UI component.

## Overview

Two Redux async thunks have been implemented for handling presentation requests:

1. **`sendVerifiablePresentation`** - Sends a selected credential as a verifiable presentation
2. **`declinePresentation`** - Declines a presentation request without sending any response

## File Locations

**Alice Wallet**: `/root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/alice-wallet/src/actions/index.ts` (lines 1592-1712)
**Bob Wallet**: `/root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/bob-wallet/src/actions/index.ts` (lines 1598-1718)

## Function Signatures

```typescript
// Send presentation
export const sendVerifiablePresentation = createAsyncThunk<
    void,
    { requestId: string; credentialId: string },
    { state: { app: RootState } }
>(
    'app/sendVerifiablePresentation',
    async ({ requestId, credentialId }, { getState, dispatch }) => {
        // Implementation...
    }
);

// Decline presentation
export const declinePresentation = createAsyncThunk<
    void,
    { requestId: string },
    { state: { app: RootState } }
>(
    'app/declinePresentation',
    async ({ requestId }, { getState, dispatch }) => {
        // Implementation...
    }
);
```

## Redux State Structure

The presentation requests are stored in Redux state:

```typescript
// From reducers/app.ts
export type PresentationRequestStatus = 'pending' | 'sent' | 'declined';

export type PresentationRequest = {
    id: string;                                  // Request message ID
    from: string;                                // Sender DID
    requestMessage: SDK.Domain.Message;          // Full RequestPresentation message
    timestamp: string;                           // ISO timestamp
    status: PresentationRequestStatus;
};

export type RootState = {
    // ... other state
    presentationRequests: PresentationRequest[];
    credentials: SDK.Domain.Credential[];
};
```

## Usage in UI Component

### Basic Integration Example

```typescript
import React, { useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { sendVerifiablePresentation, declinePresentation } from '@/actions';
import { RootState } from '@/reducers/app';

const PresentationRequestModal: React.FC = () => {
    const dispatch = useDispatch();

    // Get pending presentation requests from Redux
    const presentationRequests = useSelector((state: { app: RootState }) =>
        state.app.presentationRequests.filter(req => req.status === 'pending')
    );

    // Get available credentials
    const credentials = useSelector((state: { app: RootState }) =>
        state.app.credentials
    );

    // Local state for selected credential
    const [selectedCredentialId, setSelectedCredentialId] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Get current request (first pending request)
    const currentRequest = presentationRequests[0];

    // Handle send button click
    const handleSend = async () => {
        if (!selectedCredentialId) {
            setError('Please select a credential');
            return;
        }

        if (!currentRequest) {
            setError('No active presentation request');
            return;
        }

        setIsSubmitting(true);
        setError(null);

        try {
            // Send the verifiable presentation
            await dispatch(sendVerifiablePresentation({
                requestId: currentRequest.id,
                credentialId: selectedCredentialId
            })).unwrap();

            // Success - modal will auto-close as request is no longer pending
            console.log('✅ Presentation sent successfully');
            setSelectedCredentialId(null);

        } catch (error: any) {
            setError(`Failed to send presentation: ${error.message}`);
            console.error('❌ Presentation send failed:', error);
        } finally {
            setIsSubmitting(false);
        }
    };

    // Handle decline button click
    const handleDecline = async () => {
        if (!currentRequest) {
            setError('No active presentation request');
            return;
        }

        setIsSubmitting(true);
        setError(null);

        try {
            await dispatch(declinePresentation({
                requestId: currentRequest.id
            })).unwrap();

            console.log('✅ Presentation declined');
            setSelectedCredentialId(null);

        } catch (error: any) {
            setError(`Failed to decline: ${error.message}`);
            console.error('❌ Decline failed:', error);
        } finally {
            setIsSubmitting(false);
        }
    };

    // Don't render if no pending requests
    if (presentationRequests.length === 0) {
        return null;
    }

    return (
        <div className="modal">
            <h2>Presentation Request</h2>
            <p>From: {currentRequest.from.substring(0, 50)}...</p>
            <p>Received: {new Date(currentRequest.timestamp).toLocaleString()}</p>

            {error && <div className="error">{error}</div>}

            <div className="credential-selection">
                <h3>Select Credential to Share:</h3>
                {credentials.map(credential => (
                    <div key={credential.id} className="credential-option">
                        <input
                            type="radio"
                            id={credential.id}
                            name="credential"
                            value={credential.id}
                            checked={selectedCredentialId === credential.id}
                            onChange={() => setSelectedCredentialId(credential.id)}
                            disabled={isSubmitting}
                        />
                        <label htmlFor={credential.id}>
                            {/* Display credential details */}
                            <div className="credential-type">
                                {credential.credentialType || 'Unknown Type'}
                            </div>
                            <div className="credential-id">
                                {credential.id.substring(0, 30)}...
                            </div>
                        </label>
                    </div>
                ))}
            </div>

            <div className="button-group">
                <button
                    onClick={handleSend}
                    disabled={!selectedCredentialId || isSubmitting}
                    className="btn-primary"
                >
                    {isSubmitting ? 'Sending...' : 'Send Selected'}
                </button>
                <button
                    onClick={handleDecline}
                    disabled={isSubmitting}
                    className="btn-secondary"
                >
                    Decline
                </button>
            </div>
        </div>
    );
};

export default PresentationRequestModal;
```

## Error Handling

Both thunks use comprehensive error handling:

### Success Console Output

```
📤 [PRESENTATION] Starting presentation send process
📤 [PRESENTATION] Request ID: abc123...
📤 [PRESENTATION] Credential ID: cred456...
✅ [PRESENTATION] Found presentation request
📋 [PRESENTATION] Request from: did:peer:2.Ez6LSghw...
📋 [PRESENTATION] Request status: pending
✅ [PRESENTATION] Found credential to present
📋 [PRESENTATION] Credential type: JWT
🔧 [PRESENTATION] Preparing presentation using SDK...
✅ [PRESENTATION] Presentation prepared successfully
📤 [PRESENTATION] Sending presentation message...
✅ [PRESENTATION] Presentation sent successfully
📬 [PRESENTATION] Message ID: msg789...
🔄 [PRESENTATION] Updating Redux state...
✅ [PRESENTATION] Complete - presentation workflow finished
```

### Error Console Output

```
❌ [PRESENTATION] Error during presentation send: Agent not initialized
❌ [PRESENTATION] Error type: Error
❌ [PRESENTATION] Error message: Agent not initialized
❌ [PRESENTATION] Error stack: Error: Agent not initialized at...
```

### Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `Agent not initialized` | Wallet not started | Ensure agent.start() called |
| `Presentation request {id} not found` | Invalid request ID | Check request exists in state |
| `Credential {id} not found` | Invalid credential ID | Verify credential in wallet |
| SDK presentation errors | Invalid credential format | Check credential compatibility |

## Redux State Updates

### State Changes on Send

```typescript
// Before
state.presentationRequests = [
    { id: 'req123', status: 'pending', ... }
];

// After dispatch(sendVerifiablePresentation({ requestId: 'req123', credentialId: 'cred456' }))
state.presentationRequests = [
    { id: 'req123', status: 'sent', ... }  // Status updated to 'sent'
];
```

### State Changes on Decline

```typescript
// Before
state.presentationRequests = [
    { id: 'req123', status: 'pending', ... }
];

// After dispatch(declinePresentation({ requestId: 'req123' }))
state.presentationRequests = [
    { id: 'req123', status: 'declined', ... }  // Status updated to 'declined'
];
```

## Integration with Existing Code

These thunks integrate with the existing Redux actions:

```typescript
// From actions/index.ts - already implemented
export const acceptPresentationRequest = createAsyncThunk(...);  // Legacy - kept for backward compatibility
export const rejectPresentationRequest = createAsyncThunk(...);  // Legacy - kept for backward compatibility

// NEW - Phase 5 implementation
export const sendVerifiablePresentation = createAsyncThunk(...);  // Modern replacement for acceptPresentationRequest
export const declinePresentation = createAsyncThunk(...);         // Modern replacement for rejectPresentationRequest
```

## Advanced Usage: Multiple Pending Requests

```typescript
const PresentationRequestQueue: React.FC = () => {
    const dispatch = useDispatch();
    const pendingRequests = useSelector((state: { app: RootState }) =>
        state.app.presentationRequests.filter(req => req.status === 'pending')
    );

    const [currentIndex, setCurrentIndex] = useState(0);
    const [selectedCredentials, setSelectedCredentials] = useState<Record<string, string>>({});

    const currentRequest = pendingRequests[currentIndex];

    const handleSendCurrent = async () => {
        const credentialId = selectedCredentials[currentRequest.id];
        if (!credentialId) return;

        try {
            await dispatch(sendVerifiablePresentation({
                requestId: currentRequest.id,
                credentialId
            })).unwrap();

            // Move to next request
            setCurrentIndex(prev => Math.min(prev + 1, pendingRequests.length - 1));
        } catch (error) {
            console.error('Failed to send:', error);
        }
    };

    const handleDeclineCurrent = async () => {
        try {
            await dispatch(declinePresentation({
                requestId: currentRequest.id
            })).unwrap();

            // Move to next request
            setCurrentIndex(prev => Math.min(prev + 1, pendingRequests.length - 1));
        } catch (error) {
            console.error('Failed to decline:', error);
        }
    };

    if (pendingRequests.length === 0) {
        return <div>No pending presentation requests</div>;
    }

    return (
        <div>
            <h2>Presentation Requests ({currentIndex + 1}/{pendingRequests.length})</h2>
            {/* Render current request UI */}
        </div>
    );
};
```

## Testing Checklist

- [ ] Agent initialized before calling thunks
- [ ] Request exists in `state.presentationRequests`
- [ ] Credential exists in `state.credentials`
- [ ] Request ID matches a pending request
- [ ] Credential ID matches user's credential
- [ ] UI disables buttons during submission
- [ ] Error messages displayed to user
- [ ] Success clears modal/form
- [ ] Redux state updates correctly
- [ ] Console logs show detailed progress

## Migration from Legacy Actions

If you're using the old `acceptPresentationRequest` action:

```typescript
// OLD WAY (acceptPresentationRequest - direct parameters)
await dispatch(acceptPresentationRequest({
    agent,
    message: requestMessage,
    credential: selectedCredential
}));

// NEW WAY (sendVerifiablePresentation - uses Redux state)
await dispatch(sendVerifiablePresentation({
    requestId: request.id,
    credentialId: selectedCredential.id
}));
```

**Benefits of new approach**:
- Cleaner separation of concerns (Redux manages state)
- No need to pass agent instance from UI
- Automatic state updates via Redux reducers
- Better error handling and logging
- Consistent with Phase 2-4 architecture

## Related Files

- **Actions**: `/root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/{alice,bob}-wallet/src/actions/index.ts`
- **Reducers**: `/root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/{alice,bob}-wallet/src/reducers/app.ts`
- **Types**: `/root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/{alice,bob}-wallet/src/reducers/app.ts` (lines 166-175)
- **Message Handler**: `/root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/{alice,bob}-wallet/src/actions/index.ts` (lines 230-254 - dispatches `presentationRequestReceived`)

## Next Steps

After implementing these thunks, the Phase 4 UI component can:
1. Import `sendVerifiablePresentation` and `declinePresentation`
2. Use `useSelector` to access `presentationRequests` and `credentials` from Redux
3. Call thunks with `dispatch()` when user clicks buttons
4. Handle success/error with `.unwrap()` for TypeScript type safety

The modal will automatically close when a request's status changes from 'pending' to 'sent' or 'declined'.
