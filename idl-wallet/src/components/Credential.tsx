
import React, { useState, useEffect } from "react";

import SDK from "@hyperledger/identus-edge-agent-sdk";
import { useMountedApp } from "@/reducers/store";
import { AgentRequire } from "@/components/AgentRequire";
import { verifyCredentialStatus, CredentialStatus } from '@/utils/credentialStatus';


function protect(credential: SDK.Domain.Credential) {
    const newClaims: any[] = []
    credential.claims.forEach((claim) => {
        const newClaim = {}
        Object.keys(claim).forEach((key) => {
            newClaim[key] = "******"
        })
        newClaims.push(newClaim)
    })
    return newClaims
}

export function Credential(props) {
    const { credential } = props;
    const app = useMountedApp();
    const [claims, setClaims] = useState(protect(credential));
    const [revocationStatus, setRevocationStatus] = useState<CredentialStatus | null>(null);

    useEffect(() => {
        verifyCredentialStatus(credential).then(setRevocationStatus);
    }, [credential]);

    function revealAttributes(credential: SDK.Domain.Credential, claimIndex: number, field: string) {
        app.agent.instance?.pluto.getLinkSecret()
            .then((linkSecret) => {
                app.agent.instance?.revealCredentialFields(
                    credential,
                    [field],
                    linkSecret!.secret
                ).then((revealedFields) => {
                    const revealed = claims.map((claim, index) => {
                        if (claimIndex === index) {
                            return {
                                ...claim,
                                [field]: revealedFields[field]
                            }
                        }
                        return claim
                    })
                    setClaims(revealed)
                })
            })
    }

    return <div className="w-full mt-5  p-6 bg-white rounded-lg shadow dark:bg-gray-800">
        {/* Revocation Status Badge */}
        {revocationStatus && (
            <div className="mb-4">
                {revocationStatus.revoked ? (
                    <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-red-100 text-red-800 border border-red-200 dark:bg-red-900/20 dark:text-red-200 dark:border-red-800">
                        ✗ REVOKED
                    </span>
                ) : revocationStatus.statusPurpose === 'none' ? (
                    <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-yellow-100 text-yellow-800 border border-yellow-200 dark:bg-yellow-900/20 dark:text-yellow-200 dark:border-yellow-800">
                        ? Unknown
                    </span>
                ) : (
                    <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-green-100 text-green-800 border border-green-200 dark:bg-green-900/20 dark:text-green-200 dark:border-green-800">
                        ✓ Valid
                    </span>
                )}
            </div>
        )}
        <p className="text-md font-normal text-gray-500 whitespace-normal max-w-full dark:text-gray-400"
            style={{
                textOverflow: 'ellipsis',
                overflow: "hidden"
            }}>
            Issuer {credential.issuer}
        </p>
        <p className="mt-5 text-md font-normal text-gray-500 whitespace-normal max-w-full dark:text-gray-400">
            Claims:
        </p>
        {claims.map((claim, claimIndex) =>
            Object.keys(claim)
                .filter((field) => field !== "id")
                .map((field, i) => (
                    <div
                        key={`field${i}`}
                        className="text-md font-normal text-gray-500 dark:text-gray-400"
                    >
                        {field}
                        <AgentRequire hide text="Revealing attributes requires agent running">
                            {claim[field] === "******" ? (
                                <button
                                    onClick={() => {
                                        revealAttributes(credential, claimIndex, field);
                                    }}
                                    className="m-3 px-3 py-2 text-md font-medium text-center text-white bg-blue-700 rounded-lg hover:bg-blue-800 focus:ring-4 focus:outline-none focus:ring-blue-300 dark:bg-blue-600 dark:hover:bg-blue-700 dark:focus:ring-blue-800"
                                >
                                    Reveal
                                </button>
                            ) : (
                                <>: {claim[field]}</>
                            )}
                        </AgentRequire>
                    </div>
                ))
        )}
    </div>

}
