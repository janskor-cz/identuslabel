# Enterprise Wallet Connection Test Guide

## Prerequisites

1. ✅ Alice wallet running on http://localhost:3001/alice
2. ✅ Enterprise Cloud Agent running on http://91.99.4.54:8300
3. ✅ HR Department API Key: `2c1c82a0028bda281454b1a3d1b20aab0e3a0879954eb68c467a5d867d12283c`
4. ✅ IT Department API Key: `63ca7582205fff117077caef24978d157f1c34dc8dbfcd9a3f42769d9ce7af52`

## Test 1: Enterprise Invitation Creation

### Step 1: Create ServiceConfiguration VC

```bash
# Create a test ServiceConfiguration VC for HR Department
cat > /tmp/hr-service-config.json <<'EOF'
{
  "@context": ["https://www.w3.org/2018/credentials/v1"],
  "type": ["VerifiableCredential", "ServiceConfiguration"],
  "issuer": "did:example:test-issuer",
  "issuanceDate": "2025-11-14T00:00:00Z",
  "expirationDate": "2026-11-14T00:00:00Z",
  "credentialSubject": {
    "id": "did:example:test-employee",
    "credentialType": "ServiceConfiguration",
    "enterpriseAgentUrl": "http://91.99.4.54:8300",
    "enterpriseAgentName": "HR Department",
    "enterpriseAgentWalletId": "5fb8d42e-940d-4941-a772-4a0e6a8bf8c7",
    "enterpriseAgentApiKey": "2c1c82a0028bda281454b1a3d1b20aab0e3a0879954eb68c467a5d867d12283c"
  }
}
EOF
```

### Step 2: Test Direct API Call (Verify Backend Works)

```bash
# Test creating invitation via Enterprise Cloud Agent API directly
curl -X POST http://91.99.4.54:8300/connections \
  -H "Content-Type: application/json" \
  -H "apikey: 2c1c82a0028bda281454b1a3d1b20aab0e3a0879954eb68c467a5d867d12283c" \
  -d '{
    "label": "Test Enterprise Connection from HR",
    "goal": "Enterprise wallet connection test"
  }' | jq .
```

**Expected Output**:
```json
{
  "connectionId": "...",
  "state": "InvitationGenerated",
  "label": "Test Enterprise Connection from HR",
  "invitation": {
    "id": "...",
    "type": "...",
    "from": "did:peer:...",
    "invitationUrl": "https://identuslabel.cz/enterprise/didcomm?_oob=..."
  }
}
```

### Step 3: Test in Alice Wallet UI

1. Open http://localhost:3001/alice/connections in browser
2. **Configuration Tab**:
   - Import the ServiceConfiguration VC created in Step 1
   - Activate the configuration
3. **Connections Tab**:
   - You should see "Enterprise Wallet" button appear
   - Click "Enterprise Wallet" (should turn blue/active)
4. **🔗 OOB Tab**:
   - Enter alias: "Test Enterprise Connection"
   - Click "Create Invitation with Proof"
5. **Check Browser Console**:
   - Should see: `🏢 [ENTERPRISE] Creating invitation via Cloud Agent`
   - Should see: `✅ [ENTERPRISE] Invitation created successfully`
6. **Verify Invitation URL Generated**:
   - Should see invitation URL displayed
   - URL should start with `https://identuslabel.cz/enterprise/didcomm?_oob=`

## Test 2: Enterprise Invitation Acceptance

### Step 1: Create IT Department Configuration

```bash
cat > /tmp/it-service-config.json <<'EOF'
{
  "@context": ["https://www.w3.org/2018/credentials/v1"],
  "type": ["VerifiableCredential", "ServiceConfiguration"],
  "issuer": "did:example:test-issuer",
  "issuanceDate": "2025-11-14T00:00:00Z",
  "expirationDate": "2026-11-14T00:00:00Z",
  "credentialSubject": {
    "id": "did:example:test-employee-2",
    "credentialType": "ServiceConfiguration",
    "enterpriseAgentUrl": "http://91.99.4.54:8300",
    "enterpriseAgentName": "IT Department",
    "enterpriseAgentWalletId": "356a0ea1-883d-4985-a0d0-adc49c710fe0",
    "enterpriseAgentApiKey": "63ca7582205fff117077caef24978d157f1c34dc8dbfcd9a3f42769d9ce7af52"
  }
}
EOF
```

### Step 2: Test Direct API Call (Verify Backend Works)

```bash
# Test accepting invitation via Enterprise Cloud Agent API directly
# (Use invitation URL from Test 1 Step 2)

INVITATION_URL="<paste-invitation-url-here>"

curl -X POST http://91.99.4.54:8300/connection-invitations \
  -H "Content-Type: application/json" \
  -H "apikey: 63ca7582205fff117077caef24978d157f1c34dc8dbfcd9a3f42769d9ce7af52" \
  -d "{
    \"invitation\": \"${INVITATION_URL}\",
    \"label\": \"Test Enterprise Connection from IT\"
  }" | jq .
```

**Expected Output**:
```json
{
  "connectionId": "...",
  "state": "ConnectionRequestSent",
  "label": "Test Enterprise Connection from IT",
  "myDid": "did:peer:...",
  "theirDid": "did:peer:..."
}
```

### Step 3: Test in Alice Wallet UI

1. Open http://localhost:3001/alice/connections
2. **Configuration Tab**:
   - Import IT Department ServiceConfiguration
   - Activate IT configuration
3. **Connections Tab**:
   - Click "Enterprise Wallet" button
4. **🔗 OOB Tab**:
   - Paste invitation URL from Test 1 Step 3
   - Enter alias: "Connection from HR"
   - Click "Accept Connection"
5. **Check Browser Console**:
   - Should see: `🏢 [ENTERPRISE] Accepting invitation via Cloud Agent`
   - Should see: `✅ [ENTERPRISE] Invitation accepted successfully`
6. **Check Alert**:
   - Should see alert: "✅ Enterprise connection created successfully!"

## Test 3: Verify Connections in Cloud Agent

### Check HR Department Connections

```bash
curl -s http://91.99.4.54:8300/connections \
  -H "apikey: 2c1c82a0028bda281454b1a3d1b20aab0e3a0879954eb68c467a5d867d12283c" | \
  jq '.contents[] | {connectionId, label, state, role}'
```

**Expected**:
- Should show connection with label "Test Enterprise Connection from HR"
- State should be "ConnectionResponseReceived" or "Active"
- Role should be "Inviter"

### Check IT Department Connections

```bash
curl -s http://91.99.4.54:8300/connections \
  -H "apikey: 63ca7582205fff117077caef24978d157f1c34dc8dbfcd9a3f42769d9ce7af52" | \
  jq '.contents[] | {connectionId, label, state, role}'
```

**Expected**:
- Should show connection with label "Test Enterprise Connection from IT"
- State should be "ConnectionRequestSent" or "Active"
- Role should be "Invitee"

## Verification Checklist

- [ ] Enterprise Cloud Agent health check passes
- [ ] Direct API invitation creation works (Test 1 Step 2)
- [ ] Direct API invitation acceptance works (Test 2 Step 2)
- [ ] Alice wallet shows "Enterprise Wallet" button when config activated
- [ ] Alice wallet creates invitation via Cloud Agent (console logs confirm)
- [ ] Alice wallet accepts invitation via Cloud Agent (console logs confirm)
- [ ] HR Department shows connection in Cloud Agent
- [ ] IT Department shows connection in Cloud Agent
- [ ] Connection states are correct (InvitationGenerated → ConnectionRequestSent → Active)

## Troubleshooting

### Issue: "Enterprise Wallet" button not appearing

**Cause**: ServiceConfiguration not activated
**Solution**:
1. Go to Configuration tab
2. Verify VC imported correctly
3. Click "Activate" on the configuration

### Issue: Console shows "No API key available"

**Cause**: enterpriseConfig not passed to OOB component
**Solution**:
1. Check connections.tsx line 722-728 passes props
2. Verify OOB.tsx extracts props (line 60-73)
3. Hard refresh browser (Ctrl+Shift+R)

### Issue: "Failed to create enterprise invitation"

**Cause**: Cloud Agent not responding or API key invalid
**Solution**:
1. Check Cloud Agent health: `curl http://91.99.4.54:8300/_system/health`
2. Verify API key matches department wallet
3. Check browser console for detailed error

### Issue: API returns 401 Unauthorized

**Cause**: API key header incorrect
**Solution**: Verify using lowercase 'apikey' header (not 'apiKey' or 'x-api-key')

## Success Criteria

✅ **Test passes if**:
1. Direct API calls succeed (Tests 1 & 2 Step 2)
2. Wallet UI successfully creates invitation in enterprise mode
3. Wallet UI successfully accepts invitation in enterprise mode
4. Both departments show connections in Cloud Agent
5. Connection states progress correctly (InvitationGenerated → ConnectionRequestSent)

## Files Modified (For Reference)

1. `/root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/alice-wallet/src/utils/EnterpriseAgentClient.ts`
   - Added createInvitation() method (lines 252-275)
   - Added acceptInvitation() method (lines 277-299)

2. `/root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/alice-wallet/src/pages/connections.tsx`
   - Pass walletContext and enterpriseConfig to OOB (lines 722-728)

3. `/root/clean-identus-wallet/sdk-v6-test/sdk-ts/demos/alice-wallet/src/components/OOB.tsx`
   - Import EnterpriseAgentClient (line 25)
   - Accept walletContext and enterpriseConfig props (lines 60-73)
   - Enhanced createInvitationWithProof with enterprise check (lines 305-338)
   - Enhanced onConnectionHandleClick with enterprise check (lines 860-895)
