/**
 * ReEncryption Service - Pure SSI Architecture
 *
 * NO DATABASE REQUIRED - Uses DID resolution + Iagon storage
 *
 * Data sources:
 * - Document DID → Resolved to get Iagon serviceEndpoint
 * - DocumentRegistry → In-memory registry with existing documents
 * - Iagon → Decentralized file storage
 * - StatusList2021 → On-chain revocation checking
 *
 * Access flow:
 * 1. Verify Ed25519 signature
 * 2. Check releasability (issuer DID in document's releasableTo)
 * 3. Check clearance level hierarchy
 * 4. Check StatusList2021 revocation (on-chain)
 * 5. Download from Iagon
 * 6. Decrypt (if encrypted)
 * 7. Re-encrypt for ephemeral X25519 key
 * 8. Return to client
 *
 * Audit logging: Console + optional file (VCs for audit trail in future)
 */

const crypto = require('crypto');
const nacl = require('tweetnacl');
const fs = require('fs').promises;
const path = require('path');

// Import existing modules
const DocumentRegistry = require('./DocumentRegistry');
const StatusListService = require('./StatusListService');
const { IagonStorageClient } = require('./IagonStorageClient');

// Nonce cache for replay attack prevention (in production, use Redis)
const nonceCache = new Map();
const NONCE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

// Track accessed documents for view-once enforcement: Map<compositeKey, accessRecord>
// compositeKey = `${documentDID}:${requestorDID}`
// Now with file persistence - survives server restart
const documentAccessTracker = new Map();

// Access log file (optional persistence without database)
const ACCESS_LOG_PATH = path.join(__dirname, '..', 'data', 'ephemeral-access.log');

// View-once tracker persistence file
const VIEW_ONCE_TRACKER_PATH = path.join(__dirname, '..', 'data', 'view-once-tracker.json');

// Load view-once tracker from disk on startup
(async function loadViewOnceTracker() {
    try {
        const content = await fs.readFile(VIEW_ONCE_TRACKER_PATH, 'utf8');
        const data = JSON.parse(content);
        for (const [key, value] of Object.entries(data)) {
            documentAccessTracker.set(key, value);
        }
        console.log(`[ReEncryptionService] ✅ Loaded ${documentAccessTracker.size} view-once records from persistent storage`);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('[ReEncryptionService] No view-once tracker file found - starting fresh');
        } else {
            console.warn('[ReEncryptionService] Error loading view-once tracker:', error.message);
        }
    }
})();

// Save view-once tracker to disk (called after each new access record)
async function saveViewOnceTracker() {
    try {
        const data = Object.fromEntries(documentAccessTracker);
        await fs.writeFile(VIEW_ONCE_TRACKER_PATH, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
        console.error('[ReEncryptionService] Error saving view-once tracker:', error.message);
    }
}

// Iagon client
const iagonClient = new IagonStorageClient({
    accessToken: process.env.IAGON_ACCESS_TOKEN,
    nodeId: process.env.IAGON_NODE_ID
});

class ReEncryptionService {
    /**
     * Process an access request for a document using pure SSI architecture
     * @param {Object} request - Access request parameters
     * @returns {Promise<Object>} Access result
     */
    static async processAccessRequest(request) {
        const startTime = Date.now();
        const {
            documentDID,        // Document DID (not UUID)
            requestorDID,
            issuerDID,
            clearanceLevel,
            ephemeralDID,
            ephemeralPublicKey,
            signature,
            timestamp,
            nonce,
            clientIp,
            userAgent
        } = request;

        const accessLogEntry = {
            timestamp: new Date().toISOString(),
            documentDID,
            requestorDID,
            issuerDID,
            clearanceLevel,
            ephemeralDID,
            clientIp,
            userAgent,
            accessGranted: false,
            denialReason: null,
            copyId: null,
            processingTimeMs: 0
        };

        try {
            // Step 0: View-once restriction DISABLED
            // Documents are now displayed in view-only modal window with PDF.js
            // The user can view the document multiple times within the session
            // View-once was designed for download prevention, not modal viewing
            const accessKey = `${documentDID}:${requestorDID}`;
            // NOTE: Tracking still happens for audit purposes (see Step 8.5)
            // but we no longer deny access based on prior views

            // Step 1: Verify Ed25519 signature
            const signatureValid = await this.verifySignature({
                documentDID,
                ephemeralDID,
                timestamp,
                nonce,
                signature,
                requestorDID
            });

            if (!signatureValid) {
                accessLogEntry.denialReason = 'INVALID_SIGNATURE';
                await this.logAccess(accessLogEntry);
                return {
                    success: false,
                    error: 'INVALID_SIGNATURE',
                    message: 'Access request signature verification failed'
                };
            }

            // Step 2: Check for replay attack (nonce must be unique)
            const replayDetected = this.checkReplay(nonce);
            if (replayDetected) {
                accessLogEntry.denialReason = 'REPLAY_DETECTED';
                await this.logAccess(accessLogEntry);
                return {
                    success: false,
                    error: 'REPLAY_DETECTED',
                    message: 'Request nonce has already been used'
                };
            }

            // Step 3: Get document from DocumentRegistry (in-memory, no database)
            const document = DocumentRegistry.documents.get(documentDID);
            if (!document) {
                accessLogEntry.denialReason = 'DOCUMENT_NOT_FOUND';
                await this.logAccess(accessLogEntry);
                return {
                    success: false,
                    error: 'DOCUMENT_NOT_FOUND',
                    message: 'Document not found in registry'
                };
            }

            // Step 4: Check releasability (issuer DID must be in allowed list)
            const releasabilityMatched = document.releasableTo &&
                document.releasableTo.includes(issuerDID);

            if (!releasabilityMatched) {
                accessLogEntry.denialReason = 'RELEASABILITY_DENIED';
                await this.logAccess(accessLogEntry);
                return {
                    success: false,
                    error: 'RELEASABILITY_DENIED',
                    message: 'Your credential issuer is not authorized for this document'
                };
            }

            // Step 5: Check clearance level hierarchy
            const documentLevel = this.getLevelNumber(document.classificationLevel);
            if (clearanceLevel < documentLevel) {
                accessLogEntry.denialReason = 'CLEARANCE_DENIED';
                await this.logAccess(accessLogEntry);
                return {
                    success: false,
                    error: 'CLEARANCE_DENIED',
                    message: `Document requires ${document.classificationLevel}, you have ${this.getLevelLabel(clearanceLevel)}`
                };
            }

            // Step 6: Check credential revocation (StatusList2021 - on-chain)
            let revocationChecked = false;
            try {
                const revocationStatus = await StatusListService.isRevoked(requestorDID, issuerDID);
                revocationChecked = true;

                if (revocationStatus.isRevoked) {
                    accessLogEntry.denialReason = 'CREDENTIAL_REVOKED';
                    await this.logAccess(accessLogEntry);
                    return {
                        success: false,
                        error: 'CREDENTIAL_REVOKED',
                        message: 'Your security clearance credential has been revoked'
                    };
                }
            } catch (revocationError) {
                // Log but don't fail - revocation check is best-effort
                console.warn('[ReEncryptionService] Revocation check failed:', revocationError.message);
            }

            // Step 7: Download document from Iagon
            if (!document.iagonStorage || !document.iagonStorage.fileId) {
                accessLogEntry.denialReason = 'NO_STORAGE_INFO';
                await this.logAccess(accessLogEntry);
                return {
                    success: false,
                    error: 'NO_STORAGE_INFO',
                    message: 'Document has no storage information'
                };
            }

            const encryptionInfo = document.iagonStorage.encryptionInfo || null;
            let content;

            try {
                // Download and optionally decrypt from Iagon
                content = await iagonClient.downloadFile(
                    document.iagonStorage.fileId,
                    encryptionInfo
                );
            } catch (downloadError) {
                console.error('[ReEncryptionService] Iagon download error:', downloadError);
                accessLogEntry.denialReason = 'STORAGE_ERROR';
                await this.logAccess(accessLogEntry);
                return {
                    success: false,
                    error: 'STORAGE_ERROR',
                    message: 'Failed to retrieve document from storage'
                };
            }

            // Step 8: Generate unique copy ID for accountability
            const copyId = crypto.randomUUID();
            const copyHash = crypto.createHash('sha256')
                .update(content)
                .update(copyId)
                .digest('hex');

            // Step 8.5: Record this access for view-once enforcement
            documentAccessTracker.set(accessKey, {
                documentDID,
                requestorDID,
                copyId,
                accessedAt: new Date().toISOString(),
                clientIp
            });
            console.log(`[ReEncryptionService] View-once recorded for ${accessKey.substring(0, 60)}...`);

            // Persist view-once tracker to disk (survives server restarts)
            await saveViewOnceTracker();

            // Step 9: Re-encrypt for ephemeral key (X25519 + XSalsa20-Poly1305)
            const ephemeralCiphertext = this.encryptForEphemeralKey(
                content,
                ephemeralPublicKey
            );

            // Step 10: Log successful access
            accessLogEntry.accessGranted = true;
            accessLogEntry.copyId = copyId;
            accessLogEntry.processingTimeMs = Date.now() - startTime;
            await this.logAccess(accessLogEntry);

            console.log(`[ReEncryptionService] Access GRANTED for ${documentDID.substring(0, 40)}... to ${requestorDID.substring(0, 40)}...`);
            console.log(`[ReEncryptionService] Copy ID: ${copyId}, Processing time: ${accessLogEntry.processingTimeMs}ms`);

            // Step 11: Return encrypted document to client
            return {
                success: true,
                documentDID,
                copyId,
                copyHash,
                filename: document.iagonStorage.filename || 'document',
                classificationLevel: document.classificationLevel,
                ciphertext: ephemeralCiphertext.ciphertext,
                nonce: ephemeralCiphertext.nonce,
                serverPublicKey: ephemeralCiphertext.serverPublicKey,
                accessedAt: new Date().toISOString()
            };

        } catch (error) {
            console.error('[ReEncryptionService] Error processing access request:', error);

            accessLogEntry.denialReason = 'INTERNAL_ERROR';
            accessLogEntry.processingTimeMs = Date.now() - startTime;
            await this.logAccess(accessLogEntry);

            return {
                success: false,
                error: 'INTERNAL_ERROR',
                message: 'An internal error occurred while processing your request'
            };
        }
    }

    /**
     * Verify Ed25519 signature over access request payload
     */
    static async verifySignature({ documentDID, ephemeralDID, timestamp, nonce, signature, requestorDID }) {
        try {
            // Construct the signed payload (must match client-side)
            const payload = JSON.stringify({
                documentDID,
                ephemeralDID,
                timestamp,
                nonce
            });

            const signatureBytes = Buffer.from(signature, 'base64');

            // Basic validation
            if (signatureBytes.length !== 64) {
                console.warn('[ReEncryptionService] Invalid signature length:', signatureBytes.length);
                return false;
            }

            // Verify timestamp is recent (within 5 minutes)
            const requestTime = new Date(timestamp).getTime();
            const now = Date.now();
            if (Math.abs(now - requestTime) > 5 * 60 * 1000) {
                console.warn('[ReEncryptionService] Timestamp too old or in future');
                return false;
            }

            // TODO: In production, resolve DID document and verify against authentication key
            // For MVP, accept if properly formatted
            return true;

        } catch (error) {
            console.error('[ReEncryptionService] Signature verification error:', error);
            return false;
        }
    }

    /**
     * Check for replay attack using nonce
     */
    static checkReplay(nonce) {
        // Clean expired nonces
        const now = Date.now();
        for (const [n, t] of nonceCache.entries()) {
            if (now - t > NONCE_EXPIRY_MS) {
                nonceCache.delete(n);
            }
        }

        // Check if nonce exists
        if (nonceCache.has(nonce)) {
            return true; // Replay detected
        }

        // Store nonce
        nonceCache.set(nonce, now);
        return false;
    }

    /**
     * Encrypt content for ephemeral X25519 key using XSalsa20-Poly1305
     */
    static encryptForEphemeralKey(content, ephemeralPublicKeyBase64) {
        try {
            // Decode client's ephemeral public key
            const clientPublicKey = Buffer.from(ephemeralPublicKeyBase64, 'base64');

            // Generate server's ephemeral X25519 keypair
            const serverKeyPair = nacl.box.keyPair();

            // Generate random nonce
            const nonce = nacl.randomBytes(nacl.box.nonceLength);

            // Encrypt using NaCl box (X25519 + XSalsa20-Poly1305)
            const ciphertext = nacl.box(
                new Uint8Array(content),
                nonce,
                new Uint8Array(clientPublicKey),
                serverKeyPair.secretKey
            );

            return {
                ciphertext: Buffer.from(ciphertext).toString('base64'),
                nonce: Buffer.from(nonce).toString('base64'),
                serverPublicKey: Buffer.from(serverKeyPair.publicKey).toString('base64')
            };

        } catch (error) {
            console.error('[ReEncryptionService] Ephemeral encryption error:', error);
            throw error;
        }
    }

    /**
     * Log access attempt (file-based, no database)
     * In future: Issue AccessLogVC as verifiable audit trail
     */
    static async logAccess(entry) {
        try {
            const logLine = JSON.stringify(entry) + '\n';
            await fs.appendFile(ACCESS_LOG_PATH, logLine, 'utf8');
        } catch (error) {
            // Don't fail if logging fails
            console.error('[ReEncryptionService] Failed to log access:', error.message);
        }
    }

    /**
     * List documents accessible to a requestor
     * Uses DocumentRegistry directly (no database)
     */
    static async listAccessibleDocuments(issuerDID, clearanceLevel) {
        const accessible = [];

        for (const [did, doc] of DocumentRegistry.documents.entries()) {
            // Check releasability
            if (!doc.releasableTo || !doc.releasableTo.includes(issuerDID)) {
                continue;
            }

            // Check clearance
            const docLevel = this.getLevelNumber(doc.classificationLevel);
            if (clearanceLevel < docLevel) {
                continue;
            }

            // Document is accessible
            accessible.push({
                documentDID: did,
                filename: doc.iagonStorage?.filename || 'document',
                classificationLevel: doc.classificationLevel,
                createdAt: doc.createdAt,
                hasIagonStorage: !!doc.iagonStorage?.fileId
            });
        }

        return accessible;
    }

    /**
     * Get classification level number from label
     */
    static getLevelNumber(label) {
        const levels = {
            'UNCLASSIFIED': 1,
            'CONFIDENTIAL': 2,
            'SECRET': 3,
            'TOP_SECRET': 4
        };
        return levels[label] || 1;
    }

    /**
     * Get classification level label from number
     */
    static getLevelLabel(level) {
        const labels = {
            1: 'UNCLASSIFIED',
            2: 'CONFIDENTIAL',
            3: 'SECRET',
            4: 'TOP_SECRET'
        };
        return labels[level] || 'UNKNOWN';
    }

    /**
     * Get document metadata by DID (no database - uses DocumentRegistry)
     */
    static getDocumentMetadata(documentDID) {
        const document = DocumentRegistry.documents.get(documentDID);
        if (!document) {
            return null;
        }

        return {
            documentDID,
            filename: document.iagonStorage?.filename || 'document',
            classificationLevel: document.classificationLevel,
            releasableTo: document.releasableTo || [],
            createdAt: document.createdAt,
            updatedAt: document.updatedAt,
            hasIagonStorage: !!document.iagonStorage?.fileId,
            iagonFileId: document.iagonStorage?.fileId || null
        };
    }

    /**
     * Get audit log for a specific document (from file, no database)
     */
    static async getDocumentAuditLog(documentDID, limit = 100, offset = 0) {
        const allEntries = await this.getAuditLog(documentDID, limit + offset);
        return allEntries.slice(offset, offset + limit);
    }

    /**
     * Get access audit log (from file, no database)
     */
    static async getAuditLog(documentDID = null, limit = 100) {
        try {
            const content = await fs.readFile(ACCESS_LOG_PATH, 'utf8');
            const lines = content.trim().split('\n').filter(l => l);

            let entries = lines.map(line => {
                try {
                    return JSON.parse(line);
                } catch {
                    return null;
                }
            }).filter(e => e !== null);

            // Filter by document if specified
            if (documentDID) {
                entries = entries.filter(e => e.documentDID === documentDID);
            }

            // Return most recent entries
            return entries.slice(-limit).reverse();

        } catch (error) {
            if (error.code === 'ENOENT') {
                return []; // No log file yet
            }
            console.error('[ReEncryptionService] Error reading audit log:', error);
            return [];
        }
    }
}

module.exports = ReEncryptionService;
