/**
 * Enterprise Agent Redux Slice
 *
 * Extends Redux state to support dual-agent architecture where wallet can
 * simultaneously work with both:
 * - Main CA Cloud Agent (port 8000) - for CA-issued credentials
 * - Enterprise Cloud Agent (port 8300) - for department/company operations
 *
 * This allows employees to:
 * - Maintain CA connection for Security Clearance, RealPerson credentials
 * - Connect to enterprise agent for department-specific operations
 * - Switch contexts based on operation type
 *
 * Architecture:
 * ```
 * Main Agent Context                Enterprise Agent Context
 * ├── CA Connections                ├── Department Connections
 * ├── CA-issued Credentials         ├── Enterprise Credentials
 * └── Main SDK Agent Instance       └── Enterprise HTTP Client
 * ```
 */

import { PayloadAction, createSlice } from "@reduxjs/toolkit";
import { WalletConfiguration } from "@/utils/serviceConfigManager";
import { EnterpriseAgentClient, ColleagueMessage } from "@/utils/EnterpriseAgentClient";

/**
 * Agent context types
 */
export type AgentContext = 'main' | 'enterprise';

/**
 * Connection record from enterprise agent
 */
export interface EnterpriseConnection {
  connectionId: string;
  thid?: string;
  label?: string;
  goalCode?: string;
  // The Cloud Agent's AcceptConnectionInvitationRequest schema has no `label` field at all —
  // only the invitation *creator* (POST /connections) can set one, so an invitee-side connection
  // record's `label` is always empty. `goal` (a free-text OOB invitation body field, unlike
  // `label`) *is* transmitted to the invitee and is what these enterprise connections actually
  // carry a human-readable description in — see EmployeeWalletManager.js's createTechCorpInvitation.
  goal?: string;
  state: string;
  role: string;
  createdAt: string;
  updatedAt?: string;
  myDid?: string;
  theirDid?: string;
}

/**
 * Credential record from enterprise agent
 */
export interface EnterpriseCredential {
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
export interface EnterpriseDID {
  did: string;
  status: string;
  method?: string;
  createdAt?: string;
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
 * Enterprise agent state
 */
export interface EnterpriseAgentState {
  // Configuration
  activeConfiguration: WalletConfiguration | null;

  // Agent context
  currentContext: AgentContext;

  // Enterprise HTTP client
  client: EnterpriseAgentClient | null;

  // Enterprise connections (separate from main CA connections)
  connections: EnterpriseConnection[];

  // Enterprise credentials (separate from main CA credentials)
  credentials: EnterpriseCredential[];

  // Enterprise DIDs (PRISM DIDs from Cloud Agent)
  dids: EnterpriseDID[];

  // Pending proof requests (presentations needing user approval)
  pendingProofRequests: PresentationRecord[];

  // Colleague messages from enterprise agent (connectionId → messages)
  colleagueMessages: Record<string, ColleagueMessage[]>;
  colleagueMessagesLastPoll: number;

  // Loading states
  isLoadingConnections: boolean;
  isLoadingCredentials: boolean;
  isLoadingDIDs: boolean;
  isLoadingProofRequests: boolean;

  // Error tracking
  lastError: string | null;
}

/**
 * Initial state
 */
export const initialEnterpriseAgentState: EnterpriseAgentState = {
  activeConfiguration: null,
  currentContext: 'main',
  client: null,
  connections: [],
  credentials: [],
  dids: [],
  pendingProofRequests: [],
  colleagueMessages: {},
  colleagueMessagesLastPoll: 0,
  isLoadingConnections: false,
  isLoadingCredentials: false,
  isLoadingDIDs: false,
  isLoadingProofRequests: false,
  lastError: null
};

/**
 * Enterprise agent slice
 */
const enterpriseAgentSlice = createSlice({
  name: 'enterpriseAgent',
  initialState: initialEnterpriseAgentState,
  reducers: {
    /**
     * Set active configuration
     */
    setConfiguration: (state, action: PayloadAction<WalletConfiguration>) => {
      state.activeConfiguration = action.payload;

      // Create new client with configuration
      state.client = new EnterpriseAgentClient(action.payload);
    },

    /**
     * Clear active configuration
     */
    clearConfiguration: (state) => {
      state.activeConfiguration = null;
      state.client = null;
      state.connections = [];
      state.credentials = [];
      state.lastError = null;
    },

    /**
     * Switch agent context
     */
    setContext: (state, action: PayloadAction<AgentContext>) => {
      state.currentContext = action.payload;
    },

    /**
     * Set enterprise connections
     */
    setConnections: (state, action: PayloadAction<EnterpriseConnection[]>) => {
      state.connections = action.payload;
      state.isLoadingConnections = false;
    },

    /**
     * Set enterprise credentials
     */
    setCredentials: (state, action: PayloadAction<EnterpriseCredential[]>) => {
      state.credentials = action.payload;
      state.isLoadingCredentials = false;
    },

    /**
     * Start loading connections
     */
    startLoadingConnections: (state) => {
      state.isLoadingConnections = true;
      state.lastError = null;
    },

    /**
     * Start loading credentials
     */
    startLoadingCredentials: (state) => {
      state.isLoadingCredentials = true;
      state.lastError = null;
    },

    /**
     * Set error
     */
    setError: (state, action: PayloadAction<string>) => {
      state.lastError = action.payload;
      state.isLoadingConnections = false;
      state.isLoadingCredentials = false;
    },

    /**
     * Clear error
     */
    clearError: (state) => {
      state.lastError = null;
    },

    /**
     * Add enterprise connection
     */
    addConnection: (state, action: PayloadAction<EnterpriseConnection>) => {
      // Check if already exists
      const exists = state.connections.some(
        conn => conn.connectionId === action.payload.connectionId
      );

      if (!exists) {
        state.connections.push(action.payload);
      } else {
        state.connections = state.connections.map(conn =>
          conn.connectionId === action.payload.connectionId ? action.payload : conn
        );
      }
    },

    /**
     * Update connection
     */
    updateConnection: (state, action: PayloadAction<EnterpriseConnection>) => {
      state.connections = state.connections.map(conn =>
        conn.connectionId === action.payload.connectionId ? action.payload : conn
      );
    },

    /**
     * Remove connection
     */
    removeConnection: (state, action: PayloadAction<string>) => {
      state.connections = state.connections.filter(
        conn => conn.connectionId !== action.payload
      );
    },

    /**
     * Add enterprise credential
     */
    addCredential: (state, action: PayloadAction<EnterpriseCredential>) => {
      // Check if already exists
      const exists = state.credentials.some(
        cred => cred.recordId === action.payload.recordId
      );

      if (!exists) {
        state.credentials.push(action.payload);
      } else {
        state.credentials = state.credentials.map(cred =>
          cred.recordId === action.payload.recordId ? action.payload : cred
        );
      }
    },

    /**
     * Update credential
     */
    updateCredential: (state, action: PayloadAction<EnterpriseCredential>) => {
      state.credentials = state.credentials.map(cred =>
        cred.recordId === action.payload.recordId ? action.payload : cred
      );
    },

    /**
     * Remove credential
     */
    removeCredential: (state, action: PayloadAction<string>) => {
      state.credentials = state.credentials.filter(
        cred => cred.recordId !== action.payload
      );
    },

    /**
     * Set enterprise DIDs
     */
    setEnterpriseDIDs: (state, action: PayloadAction<EnterpriseDID[]>) => {
      state.dids = action.payload;
      state.isLoadingDIDs = false;
    },

    /**
     * Start loading DIDs
     */
    startLoadingDIDs: (state) => {
      state.isLoadingDIDs = true;
      state.lastError = null;
    },

    /**
     * Set pending proof requests
     */
    setPendingProofRequests: (state, action: PayloadAction<PresentationRecord[]>) => {
      state.pendingProofRequests = action.payload;
      state.isLoadingProofRequests = false;
    },

    /**
     * Start loading proof requests
     */
    startLoadingProofRequests: (state) => {
      state.isLoadingProofRequests = true;
      state.lastError = null;
    },

    /**
     * Remove proof request (after approval/rejection)
     */
    removeProofRequest: (state, action: PayloadAction<string>) => {
      state.pendingProofRequests = state.pendingProofRequests.filter(
        req => req.presentationId !== action.payload
      );
    },

    /**
     * Append colleague messages (keyed by connectionId)
     */
    mergeColleagueMessages: (state, action: PayloadAction<{ connectionId: string; messages: ColleagueMessage[] }>) => {
      const { connectionId, messages } = action.payload;
      const existing = state.colleagueMessages[connectionId] || [];
      const existingIds = new Set(existing.map(m => m.id));
      const fresh = messages.filter(m => !existingIds.has(m.id));
      state.colleagueMessages[connectionId] = [...existing, ...fresh].slice(-200);
      state.colleagueMessagesLastPoll = Date.now();
    },

    /**
     * Add a locally sent message to the colleague messages store
     */
    addSentColleagueMessage: (state, action: PayloadAction<{ connectionId: string; message: ColleagueMessage }>) => {
      const { connectionId, message } = action.payload;
      const existing = state.colleagueMessages[connectionId] || [];
      state.colleagueMessages[connectionId] = [...existing, message].slice(-200);
    },

    /**
     * Clear colleague messages (on logout / config change)
     */
    clearColleagueMessages: (state) => {
      state.colleagueMessages = {};
      state.colleagueMessagesLastPoll = 0;
    }
  }
});

/**
 * Export actions
 */
export const {
  setConfiguration,
  clearConfiguration,
  setContext,
  setConnections,
  setCredentials,
  setEnterpriseDIDs,
  startLoadingConnections,
  startLoadingCredentials,
  startLoadingDIDs,
  setError,
  clearError,
  addConnection,
  updateConnection,
  removeConnection,
  addCredential,
  updateCredential,
  removeCredential,
  setPendingProofRequests,
  startLoadingProofRequests,
  removeProofRequest,
  mergeColleagueMessages,
  addSentColleagueMessage,
  clearColleagueMessages
} = enterpriseAgentSlice.actions;

/**
 * Export reducer
 */
export default enterpriseAgentSlice.reducer;

/**
 * Selectors
 */

/**
 * Get current agent context
 */
export const selectAgentContext = (state: { enterpriseAgent: EnterpriseAgentState }) =>
  state.enterpriseAgent.currentContext;

/**
 * Get active configuration
 */
export const selectActiveConfiguration = (state: { enterpriseAgent: EnterpriseAgentState }) =>
  state.enterpriseAgent.activeConfiguration;

/**
 * Get enterprise client
 */
export const selectEnterpriseClient = (state: { enterpriseAgent: EnterpriseAgentState }) =>
  state.enterpriseAgent.client;

/**
 * Check if enterprise agent configured
 */
export const selectIsEnterpriseConfigured = (state: { enterpriseAgent: EnterpriseAgentState }) =>
  !!state.enterpriseAgent.activeConfiguration && !!state.enterpriseAgent.client;

/**
 * Get enterprise connections
 */
export const selectEnterpriseConnections = (state: { enterpriseAgent: EnterpriseAgentState }) =>
  state.enterpriseAgent.connections;

/**
 * Get enterprise credentials
 */
export const selectEnterpriseCredentials = (state: { enterpriseAgent: EnterpriseAgentState }) =>
  state.enterpriseAgent.credentials;

/**
 * Check if loading connections
 */
export const selectIsLoadingConnections = (state: { enterpriseAgent: EnterpriseAgentState }) =>
  state.enterpriseAgent.isLoadingConnections;

/**
 * Check if loading credentials
 */
export const selectIsLoadingCredentials = (state: { enterpriseAgent: EnterpriseAgentState }) =>
  state.enterpriseAgent.isLoadingCredentials;

/**
 * Get last error
 */
export const selectLastError = (state: { enterpriseAgent: EnterpriseAgentState }) =>
  state.enterpriseAgent.lastError;

/**
 * Get enterprise DIDs
 */
export const selectEnterpriseDIDs = (state: { enterpriseAgent: EnterpriseAgentState }) =>
  state.enterpriseAgent.dids;

/**
 * Check if loading DIDs
 */
export const selectIsLoadingDIDs = (state: { enterpriseAgent: EnterpriseAgentState }) =>
  state.enterpriseAgent.isLoadingDIDs;

/**
 * Get colleague messages for a connection
 */
export const selectColleagueMessages = (connectionId: string) =>
  (state: { enterpriseAgent: EnterpriseAgentState }) =>
    state.enterpriseAgent.colleagueMessages[connectionId] || [];

/**
 * Get all colleague messages map
 */
export const selectAllColleagueMessages = (state: { enterpriseAgent: EnterpriseAgentState }) =>
  state.enterpriseAgent.colleagueMessages;

/**
 * Get last poll timestamp
 */
export const selectColleagueMessagesLastPoll = (state: { enterpriseAgent: EnterpriseAgentState }) =>
  state.enterpriseAgent.colleagueMessagesLastPoll;
