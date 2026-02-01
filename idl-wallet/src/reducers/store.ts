import { Store } from "redux";
import { configureStore } from '@reduxjs/toolkit'
import { bindActionCreators } from "redux";
import { useMemo } from "react";

import rootReducer from "./index";

import * as actions from "../actions";

import { RootState, initialState } from "./app";
import { initialEnterpriseAgentState, EnterpriseAgentState } from "./enterpriseAgent";
import classifiedDocumentsReducer, { ClassifiedDocumentsState } from "./classifiedDocuments";
import { TypedUseSelectorHook, useDispatch, useSelector } from "react-redux";

// Initial state for classified documents
const initialClassifiedDocumentsState: ClassifiedDocumentsState = {
    documents: [],
    selectedDocument: null,
    isLoading: false,
    isViewing: false,
    error: null,
    lastRefresh: null,
    stats: null
};


// Expose store globally for debugging
if (typeof window !== 'undefined') {
    (window as any).__REDUX_STORE__ = null; // Will be set after store creation
}

export const store = configureStore({
    reducer: rootReducer,
    devTools: false,
    preloadedState: {
        app: initialState,
        enterpriseAgent: initialEnterpriseAgentState,
        classifiedDocuments: initialClassifiedDocumentsState
    },
    middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware({
            // Explicitly enable thunk (it's enabled by default, but being explicit)
            thunk: true,
            serializableCheck: {
                // Ignore these action types that contain non-serializable values
                ignoredActions: [
                    'connectDatabase/pending',
                    'connectDatabase/fulfilled',
                    'connectDatabase/rejected',
                    'app/dbPreload',
                    'app/messageSuccess',
                    'initAgent/pending',
                    'initAgent/fulfilled',
                    'initAgent/rejected',
                    'startAgent/pending',
                    'startAgent/fulfilled',
                    'startAgent/rejected',
                    'sendMessage/pending',  // ✅ FIX: Ignore SDK Message objects
                    'sendMessage/fulfilled',
                    'sendMessage/rejected',
                    'connections/refresh/pending',
                    'connections/refresh/fulfilled',
                    'connections/refresh/rejected',
                    'credentials/refresh/pending',
                    'credentials/refresh/fulfilled',
                    'credentials/refresh/rejected',
                    'enterpriseAgent/applyConfiguration/pending',
                    'enterpriseAgent/applyConfiguration/fulfilled',
                    'enterpriseAgent/applyConfiguration/rejected',
                    'enterpriseAgent/setConfiguration',
                    'persist/PERSIST',
                    'persist/REHYDRATE'
                ],
                // Ignore these field paths in all actions
                ignoredActionsPaths: [
                    'meta.arg',
                    'meta.arg.message',  // ✅ FIX: Ignore SDK Message in action meta
                    'meta.baseQueryMeta',
                    'payload.db',
                    'payload.agent',
                    'payload.selfDID',
                    'payload.message',  // ✅ FIX: Ignore SDK Message in payload
                    'payload.messages',
                    'payload.connections',
                    'payload.credentials',
                    'payload.defaultSeed',
                    'payload.defaultSeed.value',
                    'payload.value',
                    'payload.encryptionKey',
                    'register',
                    'rehydrate'
                ],
                // Ignore these paths in the state
                ignoredPaths: [
                    'app.db.instance',
                    'app.agent.instance',
                    'app.agent.selfDID',
                    'app.messages',
                    'app.connections',
                    'app.credentials',
                    'app.mediatorDID',
                    'app.errors',
                    'app.defaultSeed.value',
                    'app.defaultSeed',
                    'app.prismDIDs',
                    'enterpriseAgent.client',
                    'enterpriseAgent.activeConfiguration',
                    'register',
                    'rehydrate'
                ]
            },
            immutableCheck: {
                ignoredPaths: [
                    'app.db.instance',
                    'app.agent.instance',
                    'app.agent.selfDID',
                    'app.messages',
                    'app.connections',
                    'app.credentials',
                    'app.defaultSeed.value',
                    'app.defaultSeed',
                    'app.prismDIDs',
                    'enterpriseAgent.client',
                    'enterpriseAgent.activeConfiguration'
                ]
            }
        })
});

// Expose store globally for debugging (after creation)
if (typeof window !== 'undefined') {
    (window as any).__REDUX_STORE__ = store;
}

export type AppDispatch = typeof store.dispatch;
export const useAppDispatch = () => useDispatch<AppDispatch>();
export const useAppSelector: TypedUseSelectorHook<{
    app: RootState;
    enterpriseAgent: EnterpriseAgentState;
    classifiedDocuments: ClassifiedDocumentsState;
}> = useSelector;

export const useMountedApp = () => {
    const dispatch = useDispatch<AppDispatch>();
    const dispatchedActions = useMemo(
        () => bindActionCreators(actions, dispatch),
        [dispatch]
    );
    const state = useAppSelector((state) => state.app);

    return {
        ...state,
        ...dispatchedActions,
        dispatch
    };
};

export const wrapper: Store = store;
