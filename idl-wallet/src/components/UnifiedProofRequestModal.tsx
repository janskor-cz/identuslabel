/**
 * UnifiedProofRequestModal Component
 *
 * Production-ready modal for handling proof requests from BOTH personal and enterprise agents.
 * Merges requests from both sources, automatically detects credential source, and routes
 * approve/reject actions to the correct agent.
 *
 * Features:
 * - Unified view of proof requests from personal + enterprise agents
 * - Merged credential pool from both sources with source badges
 * - Automatic credential source detection (personal IndexedDB vs enterprise Cloud Agent)
 * - Intelligent routing of approve/reject actions to correct agent
 * - FIFO queue for multiple pending requests
 * - Real-time revocation status checking
 * - Error handling with retry capability
 * - Loading states with detailed progress indicators
 * - Responsive Tailwind CSS design
 * - Comprehensive logging for debugging
 *
 * Architecture:
 * ```
 * Personal Agent (SDK)           Enterprise Agent (Cloud)
 *      ↓                                  ↓
 *  Proof Requests                  Proof Requests
 *      ↓                                  ↓
 *      └──────────────┬───────────────────┘
 *                     ↓
 *          Unified Request Queue
 *                     ↓
 *              User Selection
 *                     ↓
 *          Source Detection
 *                     ↓
 *      ┌──────────────┴────────────────┐
 *      ↓                                ↓
 * Personal Handler              Enterprise Handler
 * (sendVerifiable               (approveProofRequest)
 *  Presentation)
 * ```
 */

import React, { useState, useEffect, useMemo } from 'react';
import { useMountedApp, useAppSelector } from '@/reducers/store';
import SDK from '@hyperledger/identus-edge-agent-sdk';
import { sendVerifiablePresentation, declinePresentation } from '@/actions';
import { approveProofRequest, rejectProofRequest } from '@/actions/enterpriseAgentActions';
import { verifyCredentialStatus, CredentialStatus } from '@/utils/credentialStatus';
import { extractCredentialDisplayName } from '@/utils/credentialNaming';
import { getSchemaDisplayName, matchesSchema } from '@/utils/schemaMapping';
import { getCredentialType } from '@/utils/credentialTypeDetector';
import { filterCredentialsForProofRequest } from '@/utils/credentialFilterRules';
import { getConnectionNameWithFallback } from '@/utils/connectionNameResolver';

/**
 * Extract meaningful display name from enterprise credential
 * Uses role, training year, or clearance level based on credential type
 *
 * Enterprise credentials have claims directly in cred.claims (not cred.credential.credentialSubject)
 */
function extractEnterpriseCredentialDisplayName(cred: any): string {
  const claims = cred.claims || {};

  // CISTraining: "CIS Training 2026"
  if (claims.trainingYear) {
    return `CIS Training ${claims.trainingYear}`;
  }

  // EmployeeRole: "Senior Engineer"
  if (claims.role) {
    return claims.role;
  }

  // SecurityClearance: "CONFIDENTIAL"
  if (claims.clearanceLevel) {
    return claims.clearanceLevel;
  }

  // Fallback to credential format or record ID
  return `Enterprise Credential ${cred.recordId?.substring(0, 8) || 'Unknown'}`;
}

/**
 * Unified proof request structure
 * Represents requests from both personal and enterprise agents
 */
interface UnifiedProofRequest {
  id: string;
  source: 'personal' | 'enterprise';
  from: string; // Requester DID or connection ID
  schemaId?: string;
  requestMessage?: any; // Personal: SDK.Domain.Message, Enterprise: PresentationRecord
  timestamp: string;
  comment?: string;
  status: 'pending' | 'sent' | 'declined';
  presentationDefinition?: any;
}

/**
 * Unified credential structure with source tracking
 */
interface UnifiedCredential {
  id: string;
  source: 'personal' | 'enterprise';
  credential: any; // SDK.Domain.Credential or EnterpriseCredential
  displayName: string;
  issuer: string;
  type: string;
  recordId?: string; // Enterprise: used for proof submission
}

export const UnifiedProofRequestModal: React.FC = () => {
  const app = useMountedApp();

  // Get personal proof requests from Redux
  const personalRequests = app.presentationRequests?.filter(
    req => req.status === 'pending'
  ) || [];

  // Get enterprise proof requests from Redux
  const enterpriseRequests = useAppSelector(
    state => state.enterpriseAgent?.pendingProofRequests || []
  );

  // Get credentials from both sources
  const personalCredentials = app.credentials || [];
  const enterpriseCredentials = useAppSelector(
    state => state.enterpriseAgent?.credentials || []
  );

  // Get connections for name resolution
  const personalConnections = app.connections || [];
  const enterpriseConnections = useAppSelector(
    state => state.enterpriseAgent?.connections || []
  );

  // Get Enterprise Agent API key for VP creation
  const enterpriseAgentApiKey = useAppSelector(
    state => state.enterpriseAgent?.activeConfiguration?.enterpriseAgentApiKey
  );

  // Get Enterprise Agent URL for schema URL construction
  const enterpriseAgentUrl = useAppSelector(
    state => state.enterpriseAgent?.activeConfiguration?.enterpriseAgentUrl
  );

  // Component state
  const [selectedCredentialIds, setSelectedCredentialIds] = useState<string[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revocationWarning, setRevocationWarning] = useState<string>('');
  const [validCredentials, setValidCredentials] = useState<UnifiedCredential[]>([]);

  /**
   * Merge proof requests from both sources into unified queue
   * Sorted by timestamp (FIFO)
   */
  const unifiedRequests = useMemo<UnifiedProofRequest[]>(() => {
    const requests: UnifiedProofRequest[] = [];

    // Add personal requests
    personalRequests.forEach(req => {
      requests.push({
        id: req.id,
        source: 'personal',
        from: req.from,
        schemaId: req.schemaId,
        requestMessage: req.requestMessage,
        timestamp: req.timestamp,
        comment: req.requestMessage?.body?.comment,
        status: 'pending'
      });
    });

    // Add enterprise requests
    enterpriseRequests.forEach(req => {
      requests.push({
        id: req.presentationId,
        source: 'enterprise',
        from: req.connectionId || 'Unknown',
        schemaId: undefined, // Enterprise requests don't have schema IDs in same format
        requestMessage: req,
        timestamp: req.createdAt,
        status: 'pending',
        presentationDefinition: req.presentationDefinition // Preserve for filtering
      });
    });

    // Sort by timestamp (oldest first - FIFO)
    return requests.sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
  }, [personalRequests, enterpriseRequests]);

  /**
   * Merge credentials from both sources with source tracking
   */
  const unifiedCredentials = useMemo<UnifiedCredential[]>(() => {
    const credentials: UnifiedCredential[] = [];

    // Add personal credentials (SDK format)
    personalCredentials.forEach(cred => {
      credentials.push({
        id: cred.id,
        source: 'personal',
        credential: cred,
        displayName: extractCredentialDisplayName(cred),
        issuer: cred.issuer || 'Unknown',
        type: cred.credentialType || 'Unknown'
      });
    });

    // Add enterprise credentials (Cloud Agent format)
    // ✅ FIX: No state filter - Enterprise Cloud Agent credentials may have undefined state
    // Show all enterprise credentials regardless of state property
    enterpriseCredentials.forEach(cred => {
        // Extract display info from credential data
        const credData = cred.credential;
        const displayName = extractEnterpriseCredentialDisplayName(cred);

        credentials.push({
          id: cred.recordId,
          source: 'enterprise',
          credential: cred,
          displayName: displayName,
          issuer: credData?.issuer || 'Enterprise Issuer',
          type: credData?.type?.[1] || cred.credentialFormat || 'Unknown',
          recordId: cred.recordId
        });
      });

    return credentials;
  }, [personalCredentials, enterpriseCredentials]);

  /**
   * Format DID for display (truncate if too long)
   */
  const formatDID = (did: string): string => {
    if (!did || did.length <= 40) return did || 'Unknown';
    return `${did.substring(0, 20)}...${did.substring(did.length - 17)}`;
  };

  /**
   * Resolve connection name from DID/connection ID
   * Enhanced with multiple lookup strategies when connection.name is empty
   */
  const getConnectionName = (request: UnifiedProofRequest): string => {
    if (request.source === 'personal') {
      console.log('[ProofRequest] Looking up connection name for:', request.from);
      console.log('[ProofRequest] Available connections:', personalConnections.map(c => ({
        name: c.name,
        receiver: c.receiver.toString().substring(0, 30) + '...',
        host: c.host.toString().substring(0, 30) + '...'
      })));

      // Strategy 1: Find connection by exact DID match
      const connection = personalConnections.find(c =>
        c.receiver.toString() === request.from ||
        c.host.toString() === request.from
      );

      // If connection found with a name, use it
      if (connection?.name) {
        console.log('[ProofRequest] Found connection with name:', connection.name);
        return connection.name;
      }

      // Strategy 2: Try partial DID match (handles slight format differences)
      if (!connection) {
        const requestDIDPart = request.from.split(':').pop()?.substring(0, 20);
        const partialMatch = personalConnections.find(c => {
          const receiverPart = c.receiver.toString().split(':').pop()?.substring(0, 20);
          const hostPart = c.host.toString().split(':').pop()?.substring(0, 20);
          return receiverPart === requestDIDPart || hostPart === requestDIDPart;
        });
        if (partialMatch?.name) {
          console.log('[ProofRequest] Found connection via partial match:', partialMatch.name);
          return partialMatch.name;
        }
      }

      // Strategy 3: Try to find name from credentials using the resolver
      const resolvedName = getConnectionNameWithFallback(
        request.from,
        personalCredentials,
        connection?.name
      );

      if (resolvedName !== 'Unknown Connection') {
        console.log('[ProofRequest] Resolved name from credentials:', resolvedName);
        return resolvedName;
      }

      console.log('[ProofRequest] Could not resolve name, using formatted DID');
      return formatDID(request.from);
    } else {
      // Try enterprise connections
      const connection = enterpriseConnections.find(c =>
        c.connectionId === request.from
      );
      return connection?.label || formatDID(request.from);
    }
  };

  /**
   * Filter credentials by revocation status and schema matching
   */
  useEffect(() => {
    const filterCredentials = async () => {
      if (unifiedRequests.length === 0 || unifiedCredentials.length === 0) {
        setValidCredentials([]);
        return;
      }

      const currentRequest = unifiedRequests[0];

      // Check revocation status for personal credentials only
      // (Enterprise credentials are managed by Cloud Agent, trust its state)
      const statusChecks = await Promise.all(
        unifiedCredentials.map(async (unifiedCred) => {
          if (unifiedCred.source === 'personal') {
            try {
              const status = await verifyCredentialStatus(unifiedCred.credential);
              return { unifiedCred, status };
            } catch (error) {
              return {
                unifiedCred,
                status: { revoked: false, suspended: false, statusPurpose: 'error', checkedAt: new Date().toISOString() } as CredentialStatus
              };
            }
          } else {
            // Enterprise credentials - trust Cloud Agent state
            return {
              unifiedCred,
              status: { revoked: false, suspended: false, statusPurpose: 'valid', checkedAt: new Date().toISOString() } as CredentialStatus
            };
          }
        })
      );

      // Filter out revoked/suspended credentials
      const validCreds = statusChecks.filter(result => {
        const isInvalid = result.status.revoked || result.status.suspended;
        return !isInvalid;
      }).map(result => result.unifiedCred);

      // Apply filtering based on request source
      let filteredCreds = validCreds;

      if (currentRequest.source === 'personal') {
        // Personal requests: Apply purpose-based filtering to remove system credentials
        const requestBody = currentRequest.requestMessage?.body as any;
        const requestPurpose = {
          goalCode: requestBody?.goal_code || requestBody?.goalCode,
          schemaId: currentRequest.schemaId,
          comment: requestBody?.comment || requestBody?.goal
        };

        // Get only personal credentials for filtering
        const personalCreds = validCreds
          .filter(c => c.source === 'personal')
          .map(c => c.credential);

        // Apply purpose-based filtering
        const filteredPersonalCreds = filterCredentialsForProofRequest(personalCreds, requestPurpose);
        console.log(`🎯 [UNIFIED] Purpose filtering: ${personalCreds.length} -> ${filteredPersonalCreds.length} personal credentials`);

        // Rebuild unified credentials list with filtered personal credentials
        filteredCreds = validCreds.filter(unifiedCred => {
          if (unifiedCred.source === 'personal') {
            return filteredPersonalCreds.some(fc => fc.id === unifiedCred.credential.id);
          }
          return true; // Keep enterprise credentials
        });

        // Then apply schema filtering if schema ID specified
        if (currentRequest.schemaId) {
          filteredCreds = filteredCreds.filter(unifiedCred =>
            matchesSchema(unifiedCred.credential, currentRequest.schemaId!)
          );
        }

      } else if (currentRequest.source === 'enterprise') {
        // ✅ FILTERING DISABLED: Enterprise requests now show ALL credentials for manual selection
        // Previous schema-based filtering was rejecting credentials without schema IDs.
        // User explicitly requested: "remove the filter user will select VC by own"

        // Show only enterprise credentials (but don't filter by schema)
        filteredCreds = validCreds.filter(unifiedCred => {
          return unifiedCred.source === 'enterprise';
        });
      }

      setValidCredentials(filteredCreds);

      // Set warning if credentials were filtered
      const totalFiltered = unifiedCredentials.length - filteredCreds.length;
      if (totalFiltered > 0) {
        const msg = `${totalFiltered} credential${totalFiltered > 1 ? 's' : ''} filtered (revoked/suspended/schema mismatch)`;
        setRevocationWarning(msg);
        setTimeout(() => setRevocationWarning(''), 5000);
      } else {
        setRevocationWarning('');
      }

      // Auto-select ALL valid credentials for enterprise requests, first one for personal requests
      if (currentRequest.source === 'enterprise' && filteredCreds.length > 0) {
        // Enterprise: auto-select ALL matching credentials
        const allCredentialIds = filteredCreds.map(cred => cred.id);
        setSelectedCredentialIds(allCredentialIds);
      } else if (currentRequest.source === 'personal' && currentRequest.schemaId && filteredCreds.length > 0) {
        // Personal: auto-select first matching credential
        setSelectedCredentialIds([filteredCreds[0].id]);
      } else if (filteredCreds.length > 0) {
        // Fallback: select first credential
        setSelectedCredentialIds([filteredCreds[0].id]);
      } else {
        setSelectedCredentialIds([]);
      }
    };

    filterCredentials();
  }, [unifiedRequests.length, unifiedCredentials.length]);

  // Don't render if no pending requests
  if (unifiedRequests.length === 0) return null;

  const currentRequest = unifiedRequests[0];
  const connectionName = getConnectionName(currentRequest);

  /**
   * Handle approve action - route to correct agent
   */
  const handleApprove = async () => {
    if (selectedCredentialIds.length === 0) {
      setError('Please select at least one credential to share');
      return;
    }

    setIsProcessing(true);
    setError(null);

    try {
      // ✅ ARCHITECTURAL FIX: Route based on REQUEST source (delivery mechanism), not credential source
      // - Personal requests: SDK sends VP via DIDComm using SINGLE credentialId (does not support multiple credentials)
      // - Enterprise requests: Send ALL selected credential record IDs
      if (currentRequest.source === 'personal') {
        // Personal proof request from CA: Use SDK to send VP via DIDComm
        // Note: Personal requests currently only support single credential selection (radio button)

        await app.dispatch(sendVerifiablePresentation({
          requestId: currentRequest.id,
          credentialId: selectedCredentialIds[0]
        }));
      } else {
        // Enterprise proof request: Send ALL selected credential record IDs
        // Cloud Agent expects proofId (array of credential record IDs from its database),
        // NOT the credential JWTs themselves. It will query the database and construct the VP internally.

        // Extract credential record IDs for all selected credentials
        const credentialRecordIds = selectedCredentialIds.map(id => {
          const cred = validCredentials.find(c => c.id === id);
          const recordId = cred?.recordId || id;
          return recordId;
        });

        // Send ALL credential record IDs (Cloud Agent will query database and construct VP with all credentials)
        await app.dispatch(approveProofRequest({
          presentationId: currentRequest.id,
          proofId: credentialRecordIds
        }));
      }

      // Modal auto-closes when request removed from queue
      setSelectedCredentialIds([]);
    } catch (err) {
      console.error(`❌ [UnifiedModal] Failed to approve proof request:`, err);
      setError(err instanceof Error ? err.message : 'Failed to approve request');
    } finally {
      setIsProcessing(false);
    }
  };

  /**
   * Handle decline action - route to correct agent
   */
  const handleDecline = async () => {
    setIsProcessing(true);
    setError(null);

    try {
      if (currentRequest.source === 'personal') {
        // Personal request: Use SDK action
        await app.dispatch(declinePresentation({
          requestId: currentRequest.id
        }));
      } else {
        // Enterprise request: Use enterprise action
        await app.dispatch(rejectProofRequest(currentRequest.id));
      }

      // Modal auto-closes when request removed from queue
      setSelectedCredentialIds([]);
    } catch (err) {
      console.error(`❌ [UnifiedModal] Failed to decline proof request:`, err);
      setError(err instanceof Error ? err.message : 'Failed to decline request');
    } finally {
      setIsProcessing(false);
    }
  };

  /**
   * Get source badge styling
   */
  const getSourceBadge = (source: 'personal' | 'enterprise') => {
    if (source === 'personal') {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
          🏠 Personal
        </span>
      );
    } else {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200">
          🏢 Enterprise
        </span>
      );
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[10001] flex items-center justify-center"
    >
      <div
        className="bg-slate-900 border border-slate-700/50 rounded-2xl p-6 max-w-2xl w-full mx-4 shadow-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="mb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <span className="text-2xl">🔐</span>
              <div>
                <h2 className="text-xl font-bold text-white">
                  {connectionName} is requesting a credential
                </h2>
                <p className="text-sm text-slate-400 mt-1">
                  {getSourceBadge(currentRequest.source)}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Request Info */}
        <div className="mb-4">
          <div className="space-y-3">
            {(currentRequest.goal || currentRequest.comment) && (
              <div className="p-3 bg-slate-800/50 border border-slate-700/50 rounded-xl">
                <p className="text-sm italic text-slate-300">
                  "{currentRequest.goal || currentRequest.comment}"
                </p>
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <span className="text-sm font-medium text-slate-400">Request ID:</span>
                <p className="text-xs font-mono text-slate-300 mt-1 break-all">
                  {currentRequest.id.substring(0, 30)}...
                </p>
              </div>
              <div>
                <span className="text-sm font-medium text-slate-400">Time:</span>
                <p className="text-sm text-slate-300 mt-1">
                  {new Date(currentRequest.timestamp).toLocaleString()}
                </p>
              </div>
            </div>
            {currentRequest.schemaId && (
              <div>
                <span className="text-sm font-medium text-slate-400">Requested Type:</span>
                <p className="text-sm text-slate-300 mt-1">
                  {getSchemaDisplayName(currentRequest.schemaId)}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Revocation Warning Banner */}
        {revocationWarning && (
          <div className="mb-4">
            <div className="bg-yellow-900/20 border border-yellow-700/30 rounded-xl p-4">
              <p className="text-yellow-400 text-sm flex items-center">
                <span className="text-lg mr-2">⚠️</span>
                <span>{revocationWarning}</span>
              </p>
            </div>
          </div>
        )}

        {/* Credential Selection */}
        <div className="mb-4">
          <h3 className="text-lg font-semibold text-white mb-4">
            Select a credential to share:
          </h3>

          {unifiedCredentials.length === 0 ? (
            <div className="bg-yellow-900/20 border border-yellow-700/30 rounded-xl p-4">
              <p className="text-yellow-400 text-sm">
                ⚠️ No credentials available. You need to obtain credentials before responding to this request.
              </p>
            </div>
          ) : validCredentials.length === 0 ? (
            <div className="bg-red-500/20 border border-red-500/30 rounded-xl p-4">
              <p className="text-red-400 text-sm">
                ❌ All matching credentials have been revoked, suspended, or don't match the requested schema. You cannot respond to this request.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {validCredentials.map((unifiedCred) => {
                const isSelected = selectedCredentialIds.includes(unifiedCred.id);

                return (
                  <label
                    key={unifiedCred.id}
                    className={`
                      block p-3 rounded-xl cursor-pointer transition-colors
                      ${isSelected
                        ? 'bg-gradient-to-r from-cyan-500/20 to-purple-500/20 border border-cyan-500/30'
                        : 'bg-slate-800/50 border border-slate-700/50 hover:bg-slate-700/50'
                      }
                    `}
                  >
                    <div className="flex items-start space-x-3">
                      <input
                        type={currentRequest.source === 'enterprise' ? 'checkbox' : 'radio'}
                        name={currentRequest.source === 'enterprise' ? undefined : 'credential'}
                        value={unifiedCred.id}
                        checked={isSelected}
                        onChange={() => {
                          if (currentRequest.source === 'enterprise') {
                            // Checkbox: toggle selection
                            if (isSelected) {
                              setSelectedCredentialIds(prev => prev.filter(id => id !== unifiedCred.id));
                            } else {
                              setSelectedCredentialIds(prev => [...prev, unifiedCred.id]);
                            }
                          } else {
                            // Radio: single selection
                            setSelectedCredentialIds([unifiedCred.id]);
                          }
                        }}
                        disabled={isProcessing}
                        className="mt-1 h-4 w-4 text-cyan-500 focus:ring-cyan-500/50 disabled:opacity-50"
                      />
                      <div className="flex-1">
                        <div className="flex items-center space-x-2 mb-2">
                          <div className="font-semibold text-white">
                            {unifiedCred.displayName}
                          </div>
                          {getSourceBadge(unifiedCred.source)}
                        </div>
                        <div className="text-xs text-slate-400 space-y-1">
                          <div>Type: {unifiedCred.type}</div>
                          <div>Issuer: {formatDID(unifiedCred.issuer)}</div>
                          {unifiedCred.recordId && (
                            <div className="font-mono">Record: {unifiedCred.recordId.substring(0, 16)}...</div>
                          )}
                        </div>
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {/* Error Display */}
        {error && (
          <div className="mb-4">
            <div className="bg-red-500/20 border border-red-500/30 rounded-xl p-3">
              <p className="text-red-400 text-sm">
                ❌ {error}
              </p>
            </div>
          </div>
        )}

        {/* Action Buttons */}
        <div className="mt-6">
          <div className="flex space-x-3">
            <button
              onClick={handleDecline}
              disabled={isProcessing}
              className="flex-1 px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-xl text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isProcessing ? '⏳ Processing...' : '🚫 Decline'}
            </button>
            <button
              onClick={handleApprove}
              disabled={isProcessing || unifiedCredentials.length === 0 || validCredentials.length === 0 || selectedCredentialIds.length === 0}
              className="flex-1 px-4 py-2 bg-gradient-to-r from-cyan-500 to-purple-500 rounded-xl text-white font-medium hover:shadow-lg hover:shadow-cyan-500/25 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isProcessing ? '⏳ Sending...' : `📤 Approve & Send${selectedCredentialIds.length > 1 ? ` (${selectedCredentialIds.length})` : ''}`}
            </button>
          </div>

          {/* Helper Text */}
          <div className="mt-3 space-y-1">
            <p className="text-xs text-slate-400 text-center">
              {unifiedRequests.length > 1
                ? `${unifiedRequests.length} pending requests (${unifiedRequests.filter(r => r.source === 'personal').length} personal, ${unifiedRequests.filter(r => r.source === 'enterprise').length} enterprise)`
                : 'This is the only pending request'
              }
            </p>
            <p className="text-xs text-slate-400 text-center">
              Available credentials: {validCredentials.filter(c => c.source === 'personal').length} personal, {validCredentials.filter(c => c.source === 'enterprise').length} enterprise
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
