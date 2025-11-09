# Wallet Portability Architecture
## Complete Guide to Cross-Browser/Device Wallet Access

## Overview

This document outlines 4 approaches to enable wallet portability, allowing users to access their identity (DIDs, credentials, connections) across multiple browsers and devices.

---

## Approach 1: Backup/Restore (Manual Export/Import)

### ✅ **Pros**
- Simple to implement
- User has full control
- No server-side storage
- Works offline
- No ongoing costs

### ❌ **Cons**
- Manual process (not seamless)
- User must remember to backup
- Risk of backup file loss
- No automatic sync

### Architecture

```
Browser A                                 Browser B
┌────────────────────┐                   ┌────────────────────┐
│  User Wallet       │                   │  User Wallet       │
│  ┌──────────────┐  │                   │  ┌──────────────┐  │
│  │   Export     │  │──────────┐        │  │   Import     │  │
│  │   Button     │  │          │        │  │   Button     │  │
│  └──────────────┘  │          │        │  └──────────────┘  │
└────────────────────┘          │        └────────────────────┘
                                │               ▲
                                ▼               │
                        wallet-backup.json ─────┘
                        (Downloaded to disk)
```

### Implementation Files
- **Component**: `/mnt/user-data/outputs/WalletBackupRestore.tsx`
- **Integration**: Add to wallet Settings page

### Usage Flow
1. User clicks "Export Wallet" in Browser A
2. Optionally enters password for encryption
3. Downloads `wallet-backup.json` file
4. Transfers file to Browser B (USB, email, cloud storage)
5. Opens wallet in Browser B
6. Clicks "Import Wallet" and selects backup file
7. Enters password if encrypted
8. Wallet restored with same DID, credentials, connections

### Security Considerations
- Backup file contains private keys (encrypted if password provided)
- Recommend strong password encryption
- Warn user to store backup securely
- Support AES-256-GCM encryption

---

## Approach 2: Seed Phrase / Mnemonic (BIP-39)

### ✅ **Pros**
- Industry standard (used by MetaMask, Ledger, etc.)
- Easy for users to write down
- No file management needed
- Deterministic key generation
- Can recover even if wallet software lost

### ❌ **Cons**
- Requires cryptographic implementation
- Keys derived deterministically (less flexible)
- User must securely store 12/24 words
- More complex to implement

### Architecture

```
Browser A                           Browser B
┌──────────────────────┐           ┌──────────────────────┐
│  User Wallet         │           │  User Wallet         │
│  ┌────────────────┐  │           │  ┌────────────────┐  │
│  │ Show Seed      │  │           │  │ Import Seed    │  │
│  │ Phrase         │  │           │  │ Phrase         │  │
│  └────────────────┘  │           │  └────────────────┘  │
│        ↓             │           │        ↓             │
│  abandon ability ... │           │  abandon ability ... │
│  (12 words)          │           │  (12 words)          │
└──────────────────────┘           └──────────────────────┘
         │                                  │
         └──────────────────────────────────┘
              Derive same keys from seed
```

### Implementation

#### Generate Seed Phrase

```typescript
import * as bip39 from 'bip39';
import { HDKey } from '@scure/bip32';

/**
 * Generate new wallet with seed phrase
 */
export const generateWalletFromSeed = async () => {
  // 1. Generate 128-bit entropy (12 words) or 256-bit (24 words)
  const mnemonic = bip39.generateMnemonic();
  // Example: "abandon ability able about above absent absorb abstract absurd abuse access accident"

  // 2. Convert mnemonic to seed
  const seed = await bip39.mnemonicToSeed(mnemonic);

  // 3. Derive master key
  const masterKey = HDKey.fromMasterSeed(seed);

  // 4. Derive DID key (Ed25519) at path m/44'/0'/0'/0/0
  const didKey = masterKey.derive("m/44'/0'/0'/0/0");

  // 5. Derive X25519 encryption key at path m/44'/0'/1'/0/0
  const encryptionKey = masterKey.derive("m/44'/0'/1'/0/0");

  return {
    mnemonic,
    seed,
    didPrivateKey: didKey.privateKey,
    encryptionPrivateKey: encryptionKey.privateKey
  };
};

/**
 * Restore wallet from seed phrase
 */
export const restoreWalletFromSeed = async (mnemonic: string) => {
  // 1. Validate mnemonic
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error('Invalid seed phrase');
  }

  // 2. Convert to seed and derive keys (same as generation)
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const masterKey = HDKey.fromMasterSeed(seed);
  
  // 3. Derive same keys using same paths
  const didKey = masterKey.derive("m/44'/0'/0'/0/0");
  const encryptionKey = masterKey.derive("m/44'/0'/1'/0/0");

  // 4. Recreate DID from private key
  const did = await createDIDFromPrivateKey(didKey.privateKey);

  return {
    did,
    didPrivateKey: didKey.privateKey,
    encryptionPrivateKey: encryptionKey.privateKey
  };
};
```

#### UI Component

```typescript
export const SeedPhraseBackup: React.FC = () => {
  const [seedPhrase, setSeedPhrase] = useState<string[]>([]);
  const [showSeed, setShowSeed] = useState(false);

  const generateSeed = async () => {
    const { mnemonic } = await generateWalletFromSeed();
    setSeedPhrase(mnemonic.split(' '));
  };

  const restoreSeed = async (words: string[]) => {
    const mnemonic = words.join(' ');
    await restoreWalletFromSeed(mnemonic);
    alert('Wallet restored from seed phrase!');
  };

  return (
    <div>
      <h3>🔑 Seed Phrase Backup</h3>
      
      {/* Show existing seed phrase */}
      <button onClick={() => setShowSeed(!showSeed)}>
        {showSeed ? 'Hide' : 'Show'} My Seed Phrase
      </button>
      
      {showSeed && (
        <div className="seed-display">
          <p className="warning">
            ⚠️ Never share your seed phrase! Write it down and store securely.
          </p>
          <div className="seed-words">
            {seedPhrase.map((word, index) => (
              <div key={index} className="seed-word">
                <span className="word-number">{index + 1}.</span>
                <span className="word">{word}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Import seed phrase */}
      <div className="import-section">
        <h4>Restore from Seed Phrase</h4>
        <textarea
          placeholder="Enter your 12 or 24 word seed phrase..."
          rows={4}
        />
        <button onClick={() => {/* restore logic */}}>
          Restore Wallet
        </button>
      </div>
    </div>
  );
};
```

### Derivation Paths

```
Seed Phrase
    ↓
Master Key (BIP-32 HD Key)
    ↓
├─ m/44'/0'/0'/0/0  → DID Ed25519 Private Key
├─ m/44'/0'/1'/0/0  → Encryption X25519 Private Key
├─ m/44'/0'/2'/0/0  → Signature Private Key (future)
└─ m/44'/0'/3'/0/0  → Additional keys...
```

### Security Best Practices
- Display seed phrase only once during wallet creation
- Require user to confirm they've written it down
- Test recovery before user receives credentials
- Encrypt seed in localStorage with device PIN
- Support hardware wallets (Ledger, Trezor) that store seed

---

## Approach 3: Cloud Sync (Server-Side Encrypted Storage)

### ✅ **Pros**
- Seamless user experience
- Automatic sync across devices
- No manual backup needed
- Can access from any device
- Supports credential revocation sync

### ❌ **Cons**
- Requires server infrastructure
- User must trust server (even if encrypted)
- Requires authentication
- Ongoing hosting costs
- Privacy concerns

### Architecture

```
Browser A                  Cloud Storage                Browser B
┌────────────┐            ┌──────────────┐            ┌────────────┐
│ User       │            │   Encrypted  │            │ User       │
│ Wallet     │────────────│   Wallet     │────────────│ Wallet     │
│            │   Upload   │   Backup     │  Download  │            │
└────────────┘            └──────────────┘            └────────────┘
     │                           │                          │
     │                           │                          │
     └───────────────────────────┴──────────────────────────┘
         Same encryption key (derived from user password)
```

### Implementation

#### Backend API

```typescript
// POST /api/wallet/backup
export const uploadWalletBackup = async (req, res) => {
  const { userId, encryptedData, timestamp } = req.body;

  // Store encrypted wallet backup
  await db.query(
    `INSERT INTO wallet_backups (user_id, encrypted_data, created_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE
     SET encrypted_data = $2, updated_at = $3`,
    [userId, encryptedData, timestamp]
  );

  res.json({ success: true });
};

// GET /api/wallet/backup
export const downloadWalletBackup = async (req, res) => {
  const { userId } = req.user;

  const result = await db.query(
    `SELECT encrypted_data, updated_at FROM wallet_backups WHERE user_id = $1`,
    [userId]
  );

  if (!result.rows[0]) {
    return res.status(404).json({ error: 'No backup found' });
  }

  res.json({
    encryptedData: result.rows[0].encrypted_data,
    lastUpdated: result.rows[0].updated_at
  });
};
```

#### Frontend Auto-Sync

```typescript
export const WalletCloudSync: React.FC = () => {
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [lastSync, setLastSync] = useState<Date | null>(null);

  /**
   * Enable cloud sync
   */
  const enableSync = async (password: string) => {
    // 1. Export current wallet
    const backupData = await exportWalletData();

    // 2. Encrypt with user password
    const encryptedData = await encryptWithPassword(
      JSON.stringify(backupData),
      password
    );

    // 3. Upload to server
    await fetch('/api/wallet/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: currentUser.id,
        encryptedData,
        timestamp: new Date()
      })
    });

    setSyncEnabled(true);
    setLastSync(new Date());

    // 4. Start periodic sync (every 5 minutes)
    startPeriodicSync(password);
  };

  /**
   * Download and restore from cloud
   */
  const downloadFromCloud = async (password: string) => {
    // 1. Fetch from server
    const response = await fetch('/api/wallet/backup');
    const { encryptedData } = await response.json();

    // 2. Decrypt with user password
    const decryptedData = await decryptWithPassword(encryptedData, password);
    const backupData = JSON.parse(decryptedData);

    // 3. Restore wallet
    await restoreWalletData(backupData);
    
    alert('✅ Wallet synced from cloud!');
  };

  /**
   * Auto-sync changes
   */
  const startPeriodicSync = (password: string) => {
    setInterval(async () => {
      const backupData = await exportWalletData();
      const encryptedData = await encryptWithPassword(
        JSON.stringify(backupData),
        password
      );

      await fetch('/api/wallet/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: currentUser.id,
          encryptedData,
          timestamp: new Date()
        })
      });

      setLastSync(new Date());
    }, 5 * 60 * 1000); // Every 5 minutes
  };

  return (
    <div>
      <h3>☁️ Cloud Sync</h3>
      
      {!syncEnabled ? (
        <div>
          <p>Enable automatic cloud backup and sync across devices.</p>
          <button onClick={() => {/* enable sync */}}>
            Enable Cloud Sync
          </button>
        </div>
      ) : (
        <div>
          <p>✅ Cloud Sync Enabled</p>
          <p>Last synced: {lastSync?.toLocaleString()}</p>
          <button onClick={() => {/* manual sync */}}>
            Sync Now
          </button>
        </div>
      )}
    </div>
  );
};
```

### Database Schema

```sql
CREATE TABLE wallet_backups (
    user_id VARCHAR(100) PRIMARY KEY,
    encrypted_data TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_wallet_backups_updated ON wallet_backups(updated_at);
```

### Security Model

**Zero-Knowledge Encryption**:
```
User Password
    ↓
PBKDF2 (100,000 iterations)
    ↓
AES-256 Encryption Key
    ↓
Encrypt(Wallet Data)
    ↓
Upload to Server
```

Server never sees:
- User password
- Encryption key
- Plaintext wallet data

Server only stores:
- User ID
- Encrypted blob
- Timestamp

---

## Approach 4: DIDComm-Based Wallet Sync (P2P or via Mediator)

### ✅ **Pros**
- Fully decentralized
- No central server needed
- Uses existing DIDComm infrastructure
- Privacy-preserving
- Standards-based

### ❌ **Cons**
- Most complex to implement
- Requires both devices online simultaneously (for P2P)
- OR requires mediator for async
- Limited browser support for P2P

### Architecture

```
Browser A                 Mediator                Browser B
┌────────────┐           ┌─────────┐            ┌────────────┐
│ Wallet A   │           │ Message │            │ Wallet B   │
│ DID-A      │──────────▶│ Queue   │───────────▶│ DID-B      │
│            │           │         │            │            │
│ "Sync"     │           │ Stores  │            │ Receives   │
│ Message    │           │ Until   │            │ & Applies  │
└────────────┘           │ Fetched │            └────────────┘
                         └─────────┘

Both wallets belong to same user (proven via authentication)
```

### Implementation

#### Sync Protocol

```typescript
/**
 * Wallet Sync via DIDComm Message
 */
interface WalletSyncMessage {
  type: 'https://didcomm.org/wallet-sync/1.0/full-sync';
  from: string; // DID of sending wallet
  to: string;   // DID of receiving wallet
  body: {
    walletData: {
      dids: any[];
      credentials: any[];
      connections: any[];
    };
    timestamp: string;
    signature: string; // Signed by sending wallet's DID
  };
}

/**
 * Request sync from another device
 */
export const requestWalletSync = async (fromDID: string, toDID: string) => {
  const message: WalletSyncMessage = {
    type: 'https://didcomm.org/wallet-sync/1.0/request',
    from: fromDID,
    to: toDID,
    body: {
      requestId: crypto.randomUUID(),
      timestamp: new Date().toISOString()
    }
  };

  // Send via DIDComm
  await agent.sendDIDCommMessage(message);
};

/**
 * Handle incoming sync request
 */
export const handleSyncRequest = async (message: any) => {
  // 1. Verify sender is authenticated as same user
  const isAuthenticated = await verifySameUserOwnership(message.from);
  
  if (!isAuthenticated) {
    throw new Error('Unauthorized sync request');
  }

  // 2. Export wallet data
  const walletData = await exportWalletData();

  // 3. Sign data
  const signature = await signData(walletData, myDID);

  // 4. Send sync response
  const response: WalletSyncMessage = {
    type: 'https://didcomm.org/wallet-sync/1.0/full-sync',
    from: myDID,
    to: message.from,
    body: {
      walletData,
      timestamp: new Date().toISOString(),
      signature
    }
  };

  await agent.sendDIDCommMessage(response);
};

/**
 * Apply received sync data
 */
export const applySyncData = async (message: WalletSyncMessage) => {
  // 1. Verify signature
  const isValid = await verifySignature(
    message.body.walletData,
    message.body.signature,
    message.from
  );

  if (!isValid) {
    throw new Error('Invalid sync signature');
  }

  // 2. Merge wallet data (handle conflicts)
  await mergeWalletData(message.body.walletData);

  console.log('✅ Wallet synced via DIDComm');
};
```

#### Multi-Device Authentication

```
User's Master Identity (Enterprise Account)
    ↓
├─ Device A: DID-A (Ed25519 key A)
├─ Device B: DID-B (Ed25519 key B)
└─ Device C: DID-C (Ed25519 key C)

All devices linked to same master identity via CA-issued credential:
{
  "@context": "https://www.w3.org/2018/credentials/v1",
  "type": ["VerifiableCredential", "DeviceOwnershipCredential"],
  "issuer": "did:prism:ca-authority",
  "credentialSubject": {
    "id": "did:peer:device-A",
    "masterIdentity": "user@enterprise.com",
    "deviceName": "Work Laptop",
    "authorizedForSync": true
  }
}
```

---

## Comparison Matrix

| Feature | Backup/Restore | Seed Phrase | Cloud Sync | DIDComm Sync |
|---------|---------------|-------------|------------|--------------|
| **Ease of Use** | ⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐ |
| **Security** | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| **Privacy** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| **Auto-Sync** | ❌ | ❌ | ✅ | ✅ |
| **Offline** | ✅ | ✅ | ❌ | ❌ |
| **Complexity** | Low | Medium | Medium | High |
| **Cost** | Free | Free | Server costs | Free |
| **Recovery** | Need file | Need phrase | Need password | Need device |

---

## Recommended Approach

### For Your Enterprise System: **Hybrid Approach**

Combine multiple methods for best user experience:

```
Primary: Seed Phrase (BIP-39)
├─ Initial wallet creation generates seed
├─ User writes down 12 words
└─ Can recover on any device

Secondary: Cloud Sync (Optional)
├─ Enterprise employees can enable
├─ Encrypted with enterprise master key
└─ Automatic sync across work devices

Fallback: Manual Backup
├─ Export button always available
└─ For advanced users or air-gapped scenarios
```

### Implementation Priority

1. **Phase 1** (MVP): Manual Backup/Restore
   - Quick to implement
   - Works immediately
   - No infrastructure needed

2. **Phase 2** (Enhanced UX): Seed Phrase
   - Industry standard
   - Better user experience
   - Enables hardware wallet support

3. **Phase 3** (Enterprise): Cloud Sync
   - Seamless for employees
   - IT admin can manage backups
   - Supports device loss scenarios

4. **Phase 4** (Advanced): DIDComm Sync
   - Full decentralization
   - Maximum privacy
   - Future-proof

---

## Security Recommendations

### Critical Security Principles

1. **Never Store Private Keys Unencrypted**
   - Always encrypt with user password/PIN
   - Use strong KDF (PBKDF2 100k+ iterations)
   - Consider hardware security modules

2. **Backup Encryption**
   - AES-256-GCM minimum
   - Authenticated encryption
   - Include integrity checks

3. **Seed Phrase Protection**
   - Display only once
   - Require user confirmation
   - Test recovery before going live
   - Consider social recovery (Shamir's Secret Sharing)

4. **Cloud Sync Zero-Knowledge**
   - Server never sees plaintext
   - Encryption happens client-side
   - Use end-to-end encryption

5. **Audit Trail**
   - Log all backup/restore events
   - Track device authorizations
   - Monitor unusual sync patterns

---

## User Experience Flow

### First-Time Setup

```
1. User creates wallet
2. System generates seed phrase
3. Display: "Write down these 12 words"
4. User confirms by entering 3 random words
5. Wallet created ✅

Optional: Enable cloud sync for convenience
```

### Recovery on New Device

```
1. User opens wallet on new device
2. Clicks "Restore Wallet"
3. Enters 12-word seed phrase
4. Wallet restored with same DID ✅
5. Optional: Sync latest credentials from cloud
```

---

## Next Steps

1. **Implement WalletBackupRestore component** (already created)
2. **Add to wallet Settings page**
3. **Test backup/restore flow**
4. **Add seed phrase support (Phase 2)**
5. **Consider cloud sync (Phase 3)**

[View WalletBackupRestore Component](computer:///mnt/user-data/outputs/WalletBackupRestore.tsx)
