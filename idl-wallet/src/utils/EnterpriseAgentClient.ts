/**
 * Enterprise Agent Client
 *
 * HTTP client for communicating with enterprise cloud agents using
 * ServiceConfiguration credentials. Handles API key authentication,
 * request/response formatting, and error handling.
 *
 * Usage:
 * ```typescript
 * const client = new EnterpriseAgentClient(config);
 * const connections = await client.listConnections();
 * const credentials = await client.listCredentials();
 * ```
 *
 * Security:
 * - API keys stored in signed ServiceConfiguration VC
 * - Automatic authentication header injection
 * - Request/response logging for debugging
 */

import { WalletConfiguration } from './serviceConfigManager';

/**
 * HTTP response wrapper
 */
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  status?: number;
}

/**
 * Connection record from enterprise agent
 */
export interface ConnectionRecord {
  connectionId: string;
  thid?: string;
  label?: string;
  state: string;
  role: string;
  invitation?: any;
  createdAt: string;
  updatedAt?: string;
  myDid?: string;
  theirDid?: string;
}

/**
 * Credential record from enterprise agent
 */
export interface CredentialRecord {
  recordId: string;
  state: string;
  role: string;
  credentialFormat?: string;
  subjectId?: string;
  thid?: string;
  createdAt: string;
  updatedAt?: string;
  credential?: any;
}

/**
 * DID record from enterprise agent
 */
export interface DIDRecord {
  did: string;
  status: string;
  method?: string;
  createdAt: string;
  updatedAt?: string;
}

/**
 * Presentation record from enterprise agent
 */
export interface PresentationRecord {
  presentationId: string;
  thid?: string;
  role: string;
  status: string;
  connectionId?: string;
  proofs?: any[];
  options?: {
    challenge?: string;
    domain?: string;
  };
  credentialFormat?: string;
  createdAt: string;
  updatedAt?: string;
  presentationDefinition?: any;
}

/**
 * Credential offer creation request
 */
interface CreateCredentialOfferRequest {
  connectionId?: string;
  claims: Record<string, any>;
  credentialDefinitionId?: string;
  automaticIssuance?: boolean;
  issuingDID?: string;
}

/**
 * Enterprise Agent Client
 *
 * Provides authenticated HTTP client for enterprise cloud agent operations.
 */
export class EnterpriseAgentClient {
  private baseUrl: string;
  private apiKey: string | null;
  private walletId: string;
  private config: WalletConfiguration;

  /**
   * Create enterprise agent client from ServiceConfiguration
   *
   * @param config - Wallet configuration from ServiceConfiguration VC
   */
  constructor(config: WalletConfiguration) {
    this.config = config;
    this.baseUrl = config.enterpriseAgentUrl;
    this.walletId = config.enterpriseAgentWalletId;

    // API key is stored directly in the signed ServiceConfiguration VC
    // No encryption needed - VC signature provides integrity protection
    this.apiKey = config.enterpriseAgentApiKey;

    if (!this.apiKey) {
      console.warn('[EnterpriseAgentClient] No API key found in configuration');
      console.warn('[EnterpriseAgentClient] Client will not be able to authenticate requests');
    }
  }

  /**
   * Make authenticated HTTP request to enterprise agent
   *
   * @param endpoint - API endpoint path (e.g., '/connections')
   * @param options - Fetch options (method, body, etc.)
   * @returns API response wrapper
   */
  private async request<T = any>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<ApiResponse<T>> {
    try {
      // Validate API key available
      if (!this.apiKey) {
        return {
          success: false,
          error: 'No API key available - configuration may not be applied'
        };
      }

      // Build full URL
      const url = `${this.baseUrl}${endpoint}`;

      // Inject authentication header
      const headers = {
        'Content-Type': 'application/json',
        'apikey': this.apiKey, // Cloud Agent 2.0.0 uses lowercase 'apikey'
        ...(options.headers || {})
      };

      // Make request
      const response = await fetch(url, {
        ...options,
        headers
      });

      // Parse response
      const contentType = response.headers.get('content-type');
      let data: any;

      if (contentType?.includes('application/json')) {
        data = await response.json();
      } else {
        data = await response.text();
      }

      // Check for errors
      if (!response.ok) {
        console.error('[EnterpriseAgentClient] Request failed:', response.status, data);
        return {
          success: false,
          error: data?.detail || data?.message || `HTTP ${response.status}`,
          status: response.status,
          data
        };
      }

      return {
        success: true,
        data,
        status: response.status
      };

    } catch (error) {
      console.error('[EnterpriseAgentClient] Request error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Check if client is authenticated (has API key)
   *
   * @returns True if API key available
   */
  public isAuthenticated(): boolean {
    return !!this.apiKey;
  }

  /**
   * Get base URL of enterprise agent
   *
   * @returns Base URL
   */
  public getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Get wallet ID for this client
   *
   * @returns Enterprise wallet ID
   */
  public getWalletId(): string {
    return this.walletId;
  }

  /**
   * Get configuration used by this client
   *
   * @returns Wallet configuration
   */
  public getConfiguration(): WalletConfiguration {
    return this.config;
  }

  // ============================================================================
  // Cloud Agent API Methods
  // ============================================================================

  /**
   * List all connections in enterprise wallet
   *
   * @returns Array of connection records
   */
  public async listConnections(): Promise<ApiResponse<{ contents: ConnectionRecord[] }>> {
    return this.request<{ contents: ConnectionRecord[] }>('/connections');
  }

  /**
   * Get specific connection by ID
   *
   * @param connectionId - Connection ID
   * @returns Connection record
   */
  public async getConnection(connectionId: string): Promise<ApiResponse<ConnectionRecord>> {
    return this.request<ConnectionRecord>(`/connections/${connectionId}`);
  }

  /**
   * Create Out-of-Band invitation
   *
   * @param label - Optional label for the connection
   * @param goal - Optional goal for the invitation
   * @returns Created connection with invitation URL
   */
  public async createInvitation(label?: string, goal?: string): Promise<ApiResponse<ConnectionRecord>> {
    const requestBody: any = {};
    if (label) {
      requestBody.label = label;
    }
    if (goal) {
      requestBody.goal = goal;
    }

    return this.request<ConnectionRecord>(
      '/connections',
      {
        method: 'POST',
        body: JSON.stringify(requestBody)
      }
    );
  }

  /**
   * Accept Out-of-Band invitation
   *
   * @param invitationUrl - The invitation URL to accept
   * @param label - Optional label for the connection
   * @returns Created connection record
   */
  public async acceptInvitation(invitationUrl: string, label?: string): Promise<ApiResponse<ConnectionRecord>> {
    // Extract _oob query parameter from URL
    // Cloud Agent expects just the base64url-encoded OOB payload, not the full URL
    let oobPayload = invitationUrl;

    try {
      const url = new URL(invitationUrl);
      const oobParam = url.searchParams.get('_oob');

      if (oobParam) {
        oobPayload = oobParam;
      }
    } catch (error) {
      // If not a valid URL, assume it's already just the OOB payload
    }

    const requestBody: any = {
      invitation: oobPayload
    };
    if (label) {
      requestBody.label = label;
    }

    return this.request<ConnectionRecord>(
      '/connection-invitations',
      {
        method: 'POST',
        body: JSON.stringify(requestBody)
      }
    );
  }

  /**
   * List all credentials in enterprise wallet
   *
   * @returns Array of credential records
   */
  public async listCredentials(): Promise<ApiResponse<{ contents: CredentialRecord[] }>> {
    return this.request<{ contents: CredentialRecord[] }>('/issue-credentials/records');
  }

  /**
   * Get specific credential by record ID
   *
   * @param recordId - Credential record ID
   * @returns Credential record
   */
  public async getCredential(recordId: string): Promise<ApiResponse<CredentialRecord>> {
    return this.request<CredentialRecord>(`/issue-credentials/records/${recordId}`);
  }

  /**
   * Create credential offer to employee
   *
   * @param request - Credential offer request
   * @returns Created credential offer record
   */
  public async createCredentialOffer(
    request: CreateCredentialOfferRequest
  ): Promise<ApiResponse<CredentialRecord>> {
    return this.request<CredentialRecord>(
      '/issue-credentials/credential-offers',
      {
        method: 'POST',
        body: JSON.stringify(request)
      }
    );
  }

  /**
   * Accept credential offer (Holder side)
   *
   * When the holder (employee) receives a credential offer in "OfferReceived" state,
   * call this method to accept the offer and transition to "RequestSent" state.
   *
   * @param recordId - Credential record ID
   * @param subjectId - Holder's DID (required by Cloud Agent)
   * @returns Updated credential record
   */
  public async acceptCredentialOffer(recordId: string, subjectId: string): Promise<ApiResponse<CredentialRecord>> {
    return this.request<CredentialRecord>(
      `/issue-credentials/records/${recordId}/accept-offer`,
      {
        method: 'POST',
        body: JSON.stringify({
          subjectId
        })
      }
    );
  }

  /**
   * Accept credential request from employee (Issuer side)
   *
   * @param recordId - Credential record ID
   * @returns Updated credential record
   * @deprecated Use acceptCredentialOffer for holder-side operations
   */
  public async acceptCredentialRequest(recordId: string): Promise<ApiResponse<CredentialRecord>> {
    return this.acceptCredentialOffer(recordId);
  }

  /**
   * Issue credential to employee
   *
   * @param recordId - Credential record ID
   * @returns Updated credential record
   */
  public async issueCredential(recordId: string): Promise<ApiResponse<CredentialRecord>> {
    return this.request<CredentialRecord>(
      `/issue-credentials/records/${recordId}/issue-credential`,
      {
        method: 'POST'
      }
    );
  }

  /**
   * List all DIDs in enterprise wallet
   *
   * @returns Array of DID records
   */
  public async listDIDs(): Promise<ApiResponse<{ contents: DIDRecord[] }>> {
    return this.request<{ contents: DIDRecord[] }>('/did-registrar/dids');
  }

  /**
   * Get specific DID by ID
   *
   * @param did - DID string
   * @returns DID record
   */
  public async getDID(did: string): Promise<ApiResponse<DIDRecord>> {
    return this.request<DIDRecord>(`/did-registrar/dids/${encodeURIComponent(did)}`);
  }

  /**
   * Create new PRISM DID in enterprise wallet
   *
   * @param documentTemplate - DID document template (optional)
   * @returns Created DID record
   */
  public async createDID(documentTemplate?: any): Promise<ApiResponse<DIDRecord>> {
    return this.request<DIDRecord>(
      '/did-registrar/dids',
      {
        method: 'POST',
        body: JSON.stringify(documentTemplate || {})
      }
    );
  }

  /**
   * Create ephemeral PRISM DID with X25519 key and service endpoint
   *
   * Used for SSI-compliant document delivery where the wallet controls
   * the encryption keys. Creates a DID with:
   * - X25519 key for document encryption
   * - Service endpoint pointing to document access URL
   *
   * @param serviceEndpoint - URL where encrypted document can be fetched
   * @param storageId - Identifier for the document storage
   * @param expiresAt - Expiration timestamp for the document
   * @returns Created DID record with full DID document
   */
  public async createEphemeralDIDWithServiceEndpoint(
    serviceEndpoint: string,
    storageId: string,
    expiresAt: string
  ): Promise<ApiResponse<{
    did: string;
    longFormDid?: string;
    status: string;
    publicKeys?: Array<{
      id: string;
      purpose: string;
      publicKeyJwk?: {
        crv: string;
        x: string;
        kty: string;
      };
    }>;
    services?: Array<{
      id: string;
      type: string;
      serviceEndpoint: string;
    }>;
  }>> {
    // Create DID document template with X25519 key and service endpoint
    const documentTemplate = {
      documentTemplate: {
        publicKeys: [
          {
            id: 'key-agreement-1',
            purpose: 'keyAgreement'  // X25519 for encryption
          }
        ],
        services: [
          {
            id: 'document-access',
            type: 'EncryptedDocumentService',
            serviceEndpoint: JSON.stringify({
              uri: serviceEndpoint,
              storageId: storageId,
              expiresAt: expiresAt,
              encryption: 'X25519-XSalsa20-Poly1305'
            })
          }
        ]
      }
    };

    console.log('[EnterpriseAgentClient] Creating ephemeral DID with service endpoint:', {
      serviceEndpoint,
      storageId,
      expiresAt: expiresAt
    });

    return this.request(
      '/did-registrar/dids',
      {
        method: 'POST',
        body: JSON.stringify(documentTemplate)
      }
    );
  }

  /**
   * Get full DID document for a managed DID
   *
   * @param did - The DID to resolve
   * @returns Full DID document with keys and services
   */
  public async getDIDDocument(did: string): Promise<ApiResponse<any>> {
    return this.request(`/dids/${encodeURIComponent(did)}`);
  }

  /**
   * List all proof presentations in enterprise wallet
   *
   * @returns Array of presentation records
   */
  public async listPresentations(): Promise<ApiResponse<{ contents: PresentationRecord[] }>> {
    return this.request<{ contents: PresentationRecord[] }>('/present-proof/presentations');
  }

  /**
   * Get specific presentation by ID
   *
   * @param presentationId - Presentation ID
   * @returns Presentation record
   */
  public async getPresentation(presentationId: string): Promise<ApiResponse<PresentationRecord>> {
    return this.request<PresentationRecord>(`/present-proof/presentations/${presentationId}`);
  }

  /**
   * Update presentation (approve/reject proof request)
   *
   * @param presentationId - Presentation ID
   * @param action - Action to perform (e.g., 'request-accept', 'request-reject')
   * @param proof - Optional proof data for approval
   * @returns Updated presentation record
   */
  public async updatePresentation(
    presentationId: string,
    action: string,
    proofId?: string[]
  ): Promise<ApiResponse<PresentationRecord>> {
    const requestBody: any = { action };
    if (proofId) {
      requestBody.proofId = proofId;
    }

    return this.request<PresentationRecord>(
      `/present-proof/presentations/${presentationId}`,
      {
        method: 'PATCH',
        body: JSON.stringify(requestBody)
      }
    );
  }

  /**
   * Check health of enterprise cloud agent
   *
   * @returns Health status
   */
  public async checkHealth(): Promise<ApiResponse<any>> {
    return this.request('/_system/health');
  }

  /**
   * Get enterprise cloud agent version info
   *
   * @returns Version information
   */
  public async getVersion(): Promise<ApiResponse<any>> {
    return this.request('/_system/version');
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  /**
   * Find connection by label or DID
   *
   * @param labelOrDid - Connection label or DID to search for
   * @returns Connection record if found
   */
  public async findConnection(labelOrDid: string): Promise<ApiResponse<ConnectionRecord | null>> {
    const response = await this.listConnections();

    if (!response.success || !response.data) {
      return response as ApiResponse<null>;
    }

    const found = response.data.contents.find(conn =>
      conn.label === labelOrDid ||
      conn.myDid === labelOrDid ||
      conn.theirDid === labelOrDid
    );

    return {
      success: true,
      data: found || null
    };
  }

  /**
   * Find credentials by state
   *
   * @param state - Credential state to filter by
   * @returns Array of matching credential records
   */
  public async findCredentialsByState(
    state: string
  ): Promise<ApiResponse<CredentialRecord[]>> {
    const response = await this.listCredentials();

    if (!response.success || !response.data) {
      return { success: false, error: response.error, data: [] };
    }

    const filtered = response.data.contents.filter(cred => cred.state === state);

    return {
      success: true,
      data: filtered
    };
  }

  /**
   * Count credentials by state
   *
   * @returns Object with state counts
   */
  public async getCredentialStats(): Promise<ApiResponse<Record<string, number>>> {
    const response = await this.listCredentials();

    if (!response.success || !response.data) {
      return { success: false, error: response.error };
    }

    const stats: Record<string, number> = {};

    response.data.contents.forEach(cred => {
      stats[cred.state] = (stats[cred.state] || 0) + 1;
    });

    return {
      success: true,
      data: stats
    };
  }

  /**
   * Count connections by state
   *
   * @returns Object with state counts
   */
  public async getConnectionStats(): Promise<ApiResponse<Record<string, number>>> {
    const response = await this.listConnections();

    if (!response.success || !response.data) {
      return { success: false, error: response.error };
    }

    const stats: Record<string, number> = {};

    response.data.contents.forEach(conn => {
      stats[conn.state] = (stats[conn.state] || 0) + 1;
    });

    return {
      success: true,
      data: stats
    };
  }
}

/**
 * Create enterprise agent client from active configuration
 *
 * Convenience factory function that retrieves active configuration
 * and creates client instance.
 *
 * @returns Enterprise agent client or null if no active configuration
 */
export async function createEnterpriseAgentClient(): Promise<EnterpriseAgentClient | null> {
  try {
    const { getActiveConfiguration } = await import('./configurationStorage');
    const activeConfig = getActiveConfiguration();

    if (!activeConfig) {
      console.warn('[EnterpriseAgentClient] No active configuration found');
      return null;
    }

    return new EnterpriseAgentClient(activeConfig);
  } catch (error) {
    console.error('[EnterpriseAgentClient] Error creating client:', error);
    return null;
  }
}
