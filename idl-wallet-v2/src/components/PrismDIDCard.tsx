import React, { useState } from 'react';
import {
    ClipboardCopyIcon,
    CheckCircleIcon,
    ChevronDownIcon,
    ChevronUpIcon,
    DocumentTextIcon,
    RefreshIcon
} from '@heroicons/react/solid';

interface PrismDIDCardProps {
    did: { did: string; alias?: string } | string;
    index: number;
    agent?: any; // Optional SDK agent for DID resolution
}

/**
 * PrismDIDCard - Display component for PRISM DIDs
 *
 * Shows PRISM DIDs with:
 * - Alias as primary title
 * - Type badge (LONG-FORM vs SHORT-FORM)
 * - Expandable section to show full DID
 * - Copy to clipboard functionality
 * - DID Document resolution (when agent provided)
 */
export const PrismDIDCard: React.FC<PrismDIDCardProps> = ({ did, index, agent }) => {
    const [copied, setCopied] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const [didDocument, setDidDocument] = useState<any>(null);
    const [isResolving, setIsResolving] = useState(false);
    const [resolveError, setResolveError] = useState<string | null>(null);

    // Handle both object format { did, alias } and string format
    const didString = typeof did === 'string' ? did : did.did;
    const alias = typeof did === 'object' ? did.alias : undefined;

    const copyToClipboard = (e: React.MouseEvent) => {
        e.stopPropagation();
        navigator.clipboard.writeText(didString).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    };

    const copyDocumentToClipboard = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (didDocument) {
            navigator.clipboard.writeText(JSON.stringify(didDocument, null, 2)).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
            });
        }
    };

    /**
     * Resolve DID Document using SDK's Castor
     */
    const resolveDIDDocument = async (e: React.MouseEvent) => {
        e.stopPropagation();

        if (!agent?.castor) {
            setResolveError('Agent not available for DID resolution');
            return;
        }

        setIsResolving(true);
        setResolveError(null);

        try {
            console.log('[PrismDIDCard] Resolving DID:', didString);
            const document = await agent.castor.resolveDID(didString);
            console.log('[PrismDIDCard] Resolved document:', document);

            // Convert to plain object for display
            const docObj = {
                id: document.id?.toString?.() || document.id,
                coreProperties: document.coreProperties?.map((prop: any) => {
                    if (prop.type === 'verificationMethods') {
                        return {
                            type: 'verificationMethods',
                            methods: prop.verificationMethods?.map((vm: any) => ({
                                id: vm.id?.toString?.() || vm.id,
                                type: vm.type,
                                controller: vm.controller?.toString?.() || vm.controller,
                                publicKeyJwk: vm.publicKeyJwk,
                                publicKeyMultibase: vm.publicKeyMultibase
                            }))
                        };
                    } else if (prop.type === 'services') {
                        return {
                            type: 'services',
                            services: prop.services?.map((svc: any) => ({
                                id: svc.id,
                                type: svc.type,
                                serviceEndpoint: svc.serviceEndpoint
                            }))
                        };
                    } else if (prop.type === 'authentication') {
                        return {
                            type: 'authentication',
                            urls: prop.urls?.map((u: any) => u?.toString?.() || u)
                        };
                    } else if (prop.type === 'assertionMethod') {
                        return {
                            type: 'assertionMethod',
                            urls: prop.urls?.map((u: any) => u?.toString?.() || u)
                        };
                    }
                    return prop;
                })
            };

            setDidDocument(docObj);
        } catch (error: any) {
            console.error('[PrismDIDCard] Failed to resolve DID:', error);
            setResolveError(error?.message || 'Failed to resolve DID document');
        } finally {
            setIsResolving(false);
        }
    };

    // Long-form DIDs have format: did:prism:[stateHash]:[encodedState]
    // Short-form DIDs have format: did:prism:[stateHash]
    const isLongForm = didString.split(':').length > 3;

    // Truncate DID for display (show first 20 and last 15 chars)
    const truncatedDID = didString.length > 50
        ? `${didString.substring(0, 20)}...${didString.substring(didString.length - 15)}`
        : didString;

    return (
        <div className="bg-slate-800/30 border border-slate-700/50 rounded-2xl backdrop-blur-sm overflow-hidden hover:shadow-md transition-shadow">
            {/* Header - Always visible, clickable to expand */}
            <div
                className="p-4 cursor-pointer flex items-center justify-between hover:bg-slate-700/30 transition-colors"
                onClick={() => setExpanded(!expanded)}
            >
                <div className="flex-1 min-w-0">
                    {/* Alias as title */}
                    <div className="flex items-center space-x-3 mb-1">
                        <h3 className="text-lg font-semibold text-white truncate">
                            {alias || `DID #${index + 1}`}
                        </h3>
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full flex-shrink-0 ${
                            isLongForm
                                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                                : 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30'
                        }`}>
                            {isLongForm ? 'LONG-FORM' : 'SHORT-FORM'}
                        </span>
                    </div>
                    {/* Truncated DID preview */}
                    <div className="text-sm text-slate-400 font-mono">
                        {truncatedDID}
                    </div>
                </div>

                {/* Expand/Collapse icon */}
                <div className="ml-4 flex items-center">
                    {expanded ? (
                        <ChevronUpIcon className="w-5 h-5 text-slate-400" />
                    ) : (
                        <ChevronDownIcon className="w-5 h-5 text-slate-400" />
                    )}
                </div>
            </div>

            {/* Expanded content - Full DID and Document */}
            {expanded && (
                <div className="px-4 pb-4 border-t border-slate-700/50 bg-slate-900/30">
                    {/* Full DID Section */}
                    <div className="pt-3">
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-xs font-semibold text-slate-400 uppercase">
                                Full DID
                            </span>
                            <button
                                onClick={copyToClipboard}
                                className="flex items-center space-x-1 text-xs text-emerald-400 hover:text-emerald-300 transition-colors"
                            >
                                {copied && !didDocument ? (
                                    <>
                                        <CheckCircleIcon className="w-4 h-4" />
                                        <span>Copied!</span>
                                    </>
                                ) : (
                                    <>
                                        <ClipboardCopyIcon className="w-4 h-4" />
                                        <span>Copy</span>
                                    </>
                                )}
                            </button>
                        </div>
                        <div className="text-xs text-slate-300 font-mono break-all bg-slate-800/50 p-3 rounded-xl border border-slate-700/50">
                            {didString}
                        </div>
                    </div>

                    {/* DID Document Resolution Section */}
                    <div className="mt-4">
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-xs font-semibold text-slate-400 uppercase flex items-center">
                                <DocumentTextIcon className="w-4 h-4 mr-1" />
                                DID Document
                            </span>
                            <div className="flex items-center space-x-2">
                                {didDocument && (
                                    <button
                                        onClick={copyDocumentToClipboard}
                                        className="flex items-center space-x-1 text-xs text-emerald-400 hover:text-emerald-300 transition-colors"
                                    >
                                        {copied && didDocument ? (
                                            <>
                                                <CheckCircleIcon className="w-4 h-4" />
                                                <span>Copied!</span>
                                            </>
                                        ) : (
                                            <>
                                                <ClipboardCopyIcon className="w-4 h-4" />
                                                <span>Copy JSON</span>
                                            </>
                                        )}
                                    </button>
                                )}
                                {agent && (
                                    <button
                                        onClick={resolveDIDDocument}
                                        disabled={isResolving}
                                        className="flex items-center space-x-1 text-xs text-cyan-400 hover:text-cyan-300 transition-colors disabled:opacity-50"
                                    >
                                        <RefreshIcon className={`w-4 h-4 ${isResolving ? 'animate-spin' : ''}`} />
                                        <span>{didDocument ? 'Refresh' : 'Resolve'}</span>
                                    </button>
                                )}
                            </div>
                        </div>

                        {resolveError && (
                            <div className="text-xs text-red-400 bg-red-500/20 p-2 rounded-xl border border-red-500/30 mb-2">
                                {resolveError}
                            </div>
                        )}

                        {didDocument ? (
                            <div className="text-xs text-slate-300 font-mono break-all bg-slate-800/50 p-3 rounded-xl border border-slate-700/50 max-h-96 overflow-auto">
                                <pre className="whitespace-pre-wrap">
                                    {JSON.stringify(didDocument, null, 2)}
                                </pre>
                            </div>
                        ) : (
                            <div className="text-xs text-slate-500 bg-slate-800/30 p-3 rounded-xl border border-slate-700/50 text-center">
                                {agent ? (
                                    <>Click "Resolve" to load DID Document</>
                                ) : (
                                    <>Agent not available - Start wallet to resolve DID document</>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

export default PrismDIDCard;
