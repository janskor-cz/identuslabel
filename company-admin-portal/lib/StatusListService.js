/**
 * StatusList Service
 * Queries Cloud Agent's StatusList2021 to check credential revocation status
 * Used to verify that requestor's Security Clearance VC is still valid
 */

const axios = require('axios');

// Cloud Agent configuration
const CLOUD_AGENT_BASE_URL = process.env.CLOUD_AGENT_URL || 'https://identuslabel.cz/cloud-agent';
const CLOUD_AGENT_API_KEY = process.env.CLOUD_AGENT_API_KEY || '';

class StatusListService {
    /**
     * Check if a credential is revoked using StatusList2021
     * @param {string} holderDID - The holder's PRISM DID
     * @param {string} issuerDID - The issuer's PRISM DID
     * @param {string} credentialId - Optional credential record ID for direct lookup
     * @returns {Promise<{isRevoked: boolean, status: string, checkedAt: Date, details?: object}>}
     */
    static async isRevoked(holderDID, issuerDID, credentialId = null) {
        try {
            // If we have a credential ID, try direct lookup first
            if (credentialId) {
                const directResult = await this.checkCredentialById(credentialId);
                if (directResult) {
                    return directResult;
                }
            }

            // Otherwise, search by holder and issuer DIDs
            const searchResult = await this.searchCredentialStatus(holderDID, issuerDID);
            return searchResult;

        } catch (error) {
            console.error('[StatusListService] Error checking revocation:', error.message);
            return {
                isRevoked: false, // Fail open - allow access if check fails
                status: 'CHECK_FAILED',
                checkedAt: new Date(),
                error: error.message
            };
        }
    }

    /**
     * Check a specific credential by its record ID
     * @param {string} credentialId - The credential record ID
     * @returns {Promise<object|null>}
     */
    static async checkCredentialById(credentialId) {
        try {
            const response = await axios.get(
                `${CLOUD_AGENT_BASE_URL}/credential-status/${credentialId}`,
                {
                    headers: this.getHeaders(),
                    timeout: 10000
                }
            );

            if (response.data) {
                const status = response.data.statusListEntry || response.data;
                return this.parseStatusResponse(status);
            }

            return null;

        } catch (error) {
            if (error.response && error.response.status === 404) {
                return null; // Credential not found, try alternative method
            }
            throw error;
        }
    }

    /**
     * Search for credential status by holder and issuer DIDs
     * This queries the Cloud Agent's credential records
     * @param {string} holderDID - The holder's PRISM DID
     * @param {string} issuerDID - The issuer's PRISM DID
     * @returns {Promise<object>}
     */
    static async searchCredentialStatus(holderDID, issuerDID) {
        try {
            // Query issued credentials filtering by holder DID
            // Cloud Agent v2.1 endpoint for credential records
            const response = await axios.get(
                `${CLOUD_AGENT_BASE_URL}/issue-credentials/records`,
                {
                    headers: this.getHeaders(),
                    params: {
                        thid: undefined, // Don't filter by thread ID
                        limit: 100
                    },
                    timeout: 15000
                }
            );

            if (!response.data || !response.data.contents) {
                return {
                    isRevoked: false,
                    status: 'NOT_FOUND',
                    checkedAt: new Date(),
                    details: { reason: 'No credential records found' }
                };
            }

            // Find credentials matching holder DID and issuer DID
            // Check for Security Clearance VCs specifically
            const matchingCredentials = response.data.contents.filter(record => {
                // Check if this is a Security Clearance credential
                const isSecurityClearance = record.schemaId &&
                    (record.schemaId.includes('SecurityClearance') ||
                     record.schemaId.includes('security-clearance'));

                // Check if holder matches
                const holderMatches = record.subjectId === holderDID ||
                    (record.claims && record.claims.id === holderDID);

                // Check if issuer matches
                const issuerMatches = record.issuingDID === issuerDID ||
                    (record.issuer && record.issuer === issuerDID);

                return isSecurityClearance && holderMatches && issuerMatches;
            });

            if (matchingCredentials.length === 0) {
                return {
                    isRevoked: false,
                    status: 'NOT_FOUND',
                    checkedAt: new Date(),
                    details: {
                        reason: 'No matching Security Clearance VC found',
                        holderDID: holderDID,
                        issuerDID: issuerDID
                    }
                };
            }

            // Check the most recent matching credential
            const latestCredential = matchingCredentials.sort((a, b) =>
                new Date(b.createdAt) - new Date(a.createdAt)
            )[0];

            // Check if it has been revoked
            if (latestCredential.credentialStatusInfo) {
                const statusInfo = latestCredential.credentialStatusInfo;
                return {
                    isRevoked: statusInfo.isRevoked === true,
                    status: statusInfo.isRevoked ? 'REVOKED' : 'VALID',
                    checkedAt: new Date(),
                    details: {
                        credentialId: latestCredential.recordId,
                        statusListIndex: statusInfo.statusListIndex,
                        statusListCredential: statusInfo.statusListCredential
                    }
                };
            }

            // If no status info, assume valid
            return {
                isRevoked: false,
                status: 'VALID',
                checkedAt: new Date(),
                details: {
                    credentialId: latestCredential.recordId,
                    note: 'No StatusList2021 entry (credential not revocable)'
                }
            };

        } catch (error) {
            console.error('[StatusListService] Search error:', error.message);
            throw error;
        }
    }

    /**
     * Parse status response from Cloud Agent
     * @param {object} status - Status response object
     * @returns {object}
     */
    static parseStatusResponse(status) {
        // StatusList2021 format
        if (status.statusPurpose === 'revocation') {
            return {
                isRevoked: status.status === true || status.revoked === true,
                status: status.status === true || status.revoked === true ? 'REVOKED' : 'VALID',
                checkedAt: new Date(),
                details: {
                    statusListIndex: status.statusListIndex,
                    statusListCredential: status.statusListCredential,
                    statusPurpose: status.statusPurpose
                }
            };
        }

        // Generic format
        return {
            isRevoked: status.revoked === true,
            status: status.revoked === true ? 'REVOKED' : 'VALID',
            checkedAt: new Date(),
            details: status
        };
    }

    /**
     * Check revocation status directly from a StatusList2021 credential URL
     * @param {string} statusListCredentialUrl - URL to the status list credential
     * @param {number} statusListIndex - Index in the status list
     * @returns {Promise<{isRevoked: boolean, status: string}>}
     */
    static async checkStatusListCredential(statusListCredentialUrl, statusListIndex) {
        try {
            // Fetch the status list credential
            const response = await axios.get(statusListCredentialUrl, {
                timeout: 10000
            });

            const statusListCredential = response.data;

            // Decode the encodedList (base64-encoded, gzip-compressed bitstring)
            if (statusListCredential.credentialSubject &&
                statusListCredential.credentialSubject.encodedList) {

                const encodedList = statusListCredential.credentialSubject.encodedList;
                const isRevoked = this.checkBitAtIndex(encodedList, statusListIndex);

                return {
                    isRevoked: isRevoked,
                    status: isRevoked ? 'REVOKED' : 'VALID',
                    checkedAt: new Date(),
                    details: {
                        statusListIndex: statusListIndex,
                        statusListCredential: statusListCredentialUrl
                    }
                };
            }

            return {
                isRevoked: false,
                status: 'INVALID_STATUS_LIST',
                checkedAt: new Date(),
                error: 'Status list credential has invalid format'
            };

        } catch (error) {
            console.error('[StatusListService] StatusList check error:', error.message);
            return {
                isRevoked: false,
                status: 'CHECK_FAILED',
                checkedAt: new Date(),
                error: error.message
            };
        }
    }

    /**
     * Check if a specific bit is set in a base64+gzip encoded bitstring
     * @param {string} encodedList - Base64-encoded, gzip-compressed bitstring
     * @param {number} index - Bit index to check
     * @returns {boolean}
     */
    static checkBitAtIndex(encodedList, index) {
        try {
            const zlib = require('zlib');

            // Decode base64
            const compressed = Buffer.from(encodedList, 'base64');

            // Decompress gzip
            const decompressed = zlib.gunzipSync(compressed);

            // Find the byte and bit position
            const byteIndex = Math.floor(index / 8);
            const bitIndex = index % 8;

            if (byteIndex >= decompressed.length) {
                return false; // Index out of bounds
            }

            // Check the bit (big-endian)
            const byte = decompressed[byteIndex];
            const bit = (byte >> (7 - bitIndex)) & 1;

            return bit === 1;

        } catch (error) {
            console.error('[StatusListService] Bitstring decode error:', error.message);
            return false; // Fail open
        }
    }

    /**
     * Get HTTP headers for Cloud Agent requests
     * @returns {object}
     */
    static getHeaders() {
        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        };

        if (CLOUD_AGENT_API_KEY) {
            headers['apikey'] = CLOUD_AGENT_API_KEY;
        }

        return headers;
    }

    /**
     * Health check - verify Cloud Agent connectivity
     * @returns {Promise<{healthy: boolean, latency: number}>}
     */
    static async healthCheck() {
        const start = Date.now();
        try {
            await axios.get(`${CLOUD_AGENT_BASE_URL}/_system/health`, {
                timeout: 5000
            });
            return {
                healthy: true,
                latency: Date.now() - start
            };
        } catch (error) {
            return {
                healthy: false,
                latency: Date.now() - start,
                error: error.message
            };
        }
    }
}

module.exports = StatusListService;
