import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { useMountedApp } from '@/reducers/store';
import { Box } from '@/app/Box';
import '@/app/index.css';
import styles from '@/app/Verify.module.css';
import SDK from '@hyperledger/identus-edge-agent-sdk';
import { Scanner } from '@/components/Scanner';
import { parseQRMessage, MessageType, ScanResult } from '@/utils/qrMessageParser';

interface ProofRequest {
  id: string;
  challengeId: string;
  type: string;
  credentialType: string;
  challenge: string;
  verifyUrl: string;
  walletUrl: string;
  useExistingConnection: boolean;
}

export default function VerifyPage() {
  const router = useRouter();
  const app = useMountedApp();
  const agent = app.agent.instance;
  const { request } = router.query;

  const [proofRequest, setProofRequest] = useState<ProofRequest | null>(null);
  const [selectedCredential, setSelectedCredential] = useState<any>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [matchingCredentials, setMatchingCredentials] = useState<any[]>([]);

  // Base64 input state
  const [base64Input, setBase64Input] = useState<string>('');
  const [isParsing, setIsParsing] = useState(false);

  // QR scanner state
  const [showScanner, setShowScanner] = useState(false);

  // Parse the proof request when component mounts or request changes
  useEffect(() => {
    if (request && typeof request === 'string') {
      try {
        const decoded = atob(request);
        const parsed = JSON.parse(decoded);
        setProofRequest(parsed);
        console.log('📋 Parsed proof request:', parsed);
      } catch (e) {
        console.error('Failed to parse proof request:', e);
        setError('Invalid proof request format');
      }
    }
  }, [request]);

  // Filter credentials based on proof request type
  useEffect(() => {
    if (proofRequest && app.credentials) {
      console.log(`🔍 Searching for ${proofRequest.credentialType} credentials...`);
      console.log(`📦 Total credentials in wallet: ${app.credentials.length}`);

      const matching = app.credentials.filter((cred: any) => {
        console.log(`🔍 Checking credential:`, {
          type: cred.type,
          credentialType: cred.credentialType,
          credentialData: cred.credentialData,
          claims: cred.claims,
          credentialSubject: cred.credentialData?.credentialSubject || cred.claims?.credentialSubject,
          // Deep inspection of all credential properties
          allKeys: Object.keys(cred)
        });

        // Check if credential type matches the requested type
        const credType = cred.type || [];
        const hasMatchingType = Array.isArray(credType)
          ? credType.some((t: string) =>
              t.includes(proofRequest.credentialType) ||
              t === proofRequest.credentialType
            )
          : credType.includes && credType.includes(proofRequest.credentialType);

        // Check credential's own credentialType field
        const hasDirectTypeMatch = cred.credentialType === proofRequest.credentialType;

        // Look for credential data in multiple possible locations
        const credData = cred.credentialData || cred.claims || cred.data || cred.credential || {};
        const dataHasType = credData.type?.includes(proofRequest.credentialType);

        // Check credential subject for matching schema and type - try multiple paths
        const credSubject = credData.credentialSubject ||
                           credData.subject ||
                           cred.credentialSubject ||
                           cred.subject ||
                           {};

        const subjectHasType = credSubject.type?.includes(proofRequest.credentialType);
        const hasRequiredFields = credSubject.firstName || credSubject.lastName || credSubject.uniqueId;

        // For RealPerson specifically, check for person-related fields in any part of credential
        const isRealPersonMatch = proofRequest.credentialType === 'RealPerson' && (
          hasRequiredFields ||
          credType.some(t => t.toLowerCase().includes('person')) ||
          // Check if any property contains person-like data
          Object.values(cred).some((value: any) =>
            value && typeof value === 'object' &&
            (value.firstName || value.lastName || value.uniqueId)
          )
        );

        const matches = hasMatchingType || hasDirectTypeMatch || dataHasType || subjectHasType || isRealPersonMatch;

        if (matches) {
          console.log(`✅ Found matching credential for ${proofRequest.credentialType}`);
        } else {
          console.log(`❌ No match for credential type ${cred.credentialType}`);
        }

        return matches;
      });

      console.log(`🔍 Found ${matching.length} matching ${proofRequest.credentialType} credentials`);
      setMatchingCredentials(matching);
    }
  }, [proofRequest, app.credentials]);

  const handleSelectCredential = (credential: any) => {
    setSelectedCredential(credential);
    setError(null);
  };

  // Handle base64 input parsing
  const handleParseBase64 = async () => {
    if (!base64Input.trim()) {
      setError('Please enter a base64 proof request');
      return;
    }

    setIsParsing(true);
    setError(null);

    try {
      const decoded = atob(base64Input.trim());
      const parsed = JSON.parse(decoded);
      setProofRequest(parsed);
      setBase64Input(''); // Clear input after successful parsing
      console.log('📋 Parsed proof request from input:', parsed);
    } catch (e) {
      console.error('Failed to parse base64 proof request:', e);
      setError('Invalid base64 proof request format. Please check your input.');
    } finally {
      setIsParsing(false);
    }
  };

  // Handle QR code scan
  const handleScan = (result: ScanResult) => {
    console.log('✅ [Verify] QR code scanned successfully:', result.messageType);

    if (result.messageType === 'proof-request') {
      // Extract base64 request parameter from route action
      const requestBase64 = result.routeAction.queryParams.request;

      if (requestBase64) {
        console.log('📋 [Verify] Populating base64 input from QR scan');
        setBase64Input(requestBase64);
        setShowScanner(false);

        // Auto-parse if we have the request
        try {
          const decoded = atob(requestBase64);
          const parsed = JSON.parse(decoded);
          setProofRequest(parsed);
          console.log('📋 [Verify] Auto-parsed proof request from QR:', parsed);
        } catch (e) {
          console.error('Failed to auto-parse proof request:', e);
          setError('Failed to parse proof request from QR code');
        }
      }
    } else {
      setError(`Invalid QR code type. Expected proof-request, got: ${result.messageType}`);
      setShowScanner(false);
    }
  };

  // Handle QR scan error
  const handleScanError = (error: Error) => {
    console.error('❌ [Verify] QR scan error:', error);
    setError(error.message);
  };

  const handleSubmitProof = async () => {
    if (!selectedCredential || !proofRequest || !agent) return;

    setIsSubmitting(true);
    setError(null);

    try {
      console.log('🔐 Creating direct credential verification...');
      console.log('📋 Using credential:', selectedCredential);

      // Extract credential data for direct submission
      let credentialData = selectedCredential.credentialData || selectedCredential;

      // Handle claims array structure
      if (selectedCredential.claims && Array.isArray(selectedCredential.claims) && selectedCredential.claims.length > 0) {
        const firstClaim = selectedCredential.claims[0];
        if (firstClaim.credentialData) {
          credentialData = firstClaim.credentialData;
        } else if (firstClaim.credential) {
          credentialData = firstClaim.credential;
        } else {
          credentialData = firstClaim;
        }
      }

      console.log('📤 Extracted credential data:', credentialData);

      // Create a simple presentation structure for verification
      const presentationData = {
        "@context": ["https://www.w3.org/2018/credentials/v1"],
        "type": ["VerifiablePresentation"],
        "verifiableCredential": [credentialData],
        "proof": {
          "type": "Ed25519Signature2018",
          "created": new Date().toISOString(),
          "challenge": proofRequest.challenge,
          "domain": proofRequest.verifyUrl,
          "proofPurpose": "authentication"
        }
      };

      // Submit to the verification endpoint
      let verifyUrl = proofRequest.verifyUrl;
      if (verifyUrl.includes('localhost')) {
        verifyUrl = verifyUrl.replace('http://localhost:3004', 'http://91.99.4.54:3005');
        verifyUrl = verifyUrl.replace('http://localhost:3005', 'http://91.99.4.54:3005');
      }

      console.log('📤 Submitting direct credential verification to:', verifyUrl);

      const response = await fetch(verifyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          presentationId: proofRequest.id,
          challengeId: proofRequest.challengeId,
          presentation: presentationData,
          credential: credentialData,
          directVerification: true,
          walletDID: agent.currentDID?.toString()
        }),
      });

      const result = await response.json();

      if (response.ok && result.success) {
        console.log('✅ Direct credential verification submitted successfully:', result);
        setSuccess(true);

        // Show success message for longer, then redirect to home instead of credentials
        setTimeout(() => {
          if (result.redirectUrl) {
            // Use router.push instead of window.location.href to preserve state
            const url = new URL(result.redirectUrl);
            router.push(url.pathname + url.search);
          } else {
            // Redirect to home page instead of credentials to avoid reload issues
            router.push('/');
          }
        }, 3000); // Increased timeout to 3 seconds
      } else {
        throw new Error(result.error || 'Failed to submit credential verification');
      }
    } catch (e: any) {
      console.error('❌ Error creating credential verification:', e);
      setError(e.message || 'Failed to create credential verification');
    } finally {
      setIsSubmitting(false);
    }
  };


  if (error && !proofRequest) {
    return (
      <div className={styles.container}>
        <header className="mb-8">
          <h2 className="text-2xl font-bold text-white mb-1">Credential Verification</h2>
          <p className="text-slate-400 text-sm">Submit proofs to verify your credentials</p>
        </header>
        <Box>
          <div className={styles.error}>
            <h2>Invalid Request</h2>
            <p>{error}</p>
            <button onClick={() => router.push('/')} className={styles.button}>
              Go Home
            </button>
          </div>
        </Box>
      </div>
    );
  }

  if (success) {
    return (
      <div className={styles.container}>
        <header className="mb-8">
          <h2 className="text-2xl font-bold text-white mb-1">Credential Verification</h2>
          <p className="text-slate-400 text-sm">Submit proofs to verify your credentials</p>
        </header>
        <Box>
          <div className={styles.success}>
            <h2>✅ Proof Submitted Successfully</h2>
            <p>Your credential has been verified. Redirecting...</p>
          </div>
        </Box>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      {/* Header */}
      <header className="mb-8">
        <h2 className="text-2xl font-bold text-white mb-1">Credential Verification</h2>
        <p className="text-slate-400 text-sm">Submit proofs to verify your credentials</p>
      </header>

      {/* Agent Check - Don't reinitialize if already running */}
      {!agent && (
        <div className={styles.error}>
          <h2>Agent Not Available</h2>
          <p>Please go to the main wallet and ensure the agent is running.</p>
          <button onClick={() => router.push('/')} className={styles.button}>
            Go to Wallet
          </button>
        </div>
      )}

      <Box>
        <h1 className={styles.title}>🔐 Credential Verification Request</h1>

        {/* Base64 Proof Request Input */}
        {!proofRequest && (
          <div className={styles.inputSection}>
            <h2>📋 Enter Proof Request</h2>
            <p>Paste the base64-encoded proof request from the Certification Authority or scan a QR code:</p>

            {/* QR Scanner Toggle Button */}
            <div className={styles.inputGroup}>
              <button
                onClick={() => setShowScanner(!showScanner)}
                className={`${styles.button} ${styles.scanButton}`}
                style={{ marginBottom: '1rem' }}
              >
                {showScanner ? '❌ Close Scanner' : '📷 Scan Proof Request QR Code'}
              </button>
            </div>

            {/* Inline QR Scanner */}
            {showScanner && (
              <div className={styles.scannerContainer} style={{ marginBottom: '1rem' }}>
                <Scanner
                  allowedTypes={['proof-request' as MessageType]}
                  onScan={handleScan}
                  onError={handleScanError}
                  preferredCamera="back"
                  scanMode="single"
                  pauseAfterScan={true}
                  showOverlay={true}
                />
              </div>
            )}

            {/* Manual Base64 Input */}
            <div className={styles.inputGroup}>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
                Or paste base64 manually:
              </label>
              <textarea
                value={base64Input}
                onChange={(e) => setBase64Input(e.target.value)}
                placeholder="Paste base64 proof request here..."
                className={styles.textArea}
                rows={4}
                disabled={isParsing || showScanner}
              />

              <button
                onClick={handleParseBase64}
                disabled={isParsing || !base64Input.trim() || showScanner}
                className="px-4 py-2 bg-gradient-to-r from-cyan-500 to-purple-500 text-white rounded-xl hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isParsing ? 'Parsing...' : 'Parse Request'}
              </button>
            </div>
          </div>
        )}

        {proofRequest && (
          <div className={styles.requestDetails}>
            <h2>Request Details</h2>
            <div className={styles.detail}>
              <strong>Type:</strong> {proofRequest.credentialType}
            </div>
            <div className={styles.detail}>
              <strong>Challenge:</strong> {proofRequest.challenge}
            </div>
            <div className={styles.detail}>
              <strong>Request ID:</strong> {proofRequest.id}
            </div>
          </div>
        )}

        <div className={styles.credentialSection}>
          <h2>Select Credential</h2>

          {matchingCredentials.length === 0 ? (
            <div className={styles.noCredentials}>
              <p>No matching {proofRequest?.credentialType} credentials found in your wallet.</p>
              <p>Please obtain a {proofRequest?.credentialType} credential first.</p>
              <button onClick={() => router.push('/credentials')} className={styles.button}>
                View Credentials
              </button>
            </div>
          ) : (
            <div className={styles.credentialList}>
              {matchingCredentials.map((credential, index) => {
                // Enhanced credential data extraction - try multiple paths
                let credData = credential.credentialData || credential.data || credential.credential || {};

                // Special handling for claims array
                if (credential.claims && Array.isArray(credential.claims) && credential.claims.length > 0) {
                  // Take the first claim and extract credential data from it
                  const firstClaim = credential.claims[0];
                  if (firstClaim.credentialData) {
                    credData = firstClaim.credentialData;
                  } else if (firstClaim.credential) {
                    credData = firstClaim.credential;
                  } else {
                    credData = firstClaim;
                  }
                }

                // Extract credential subject from multiple possible locations
                const credSubject = credData.credentialSubject ||
                                   credData.subject ||
                                   credential.credentialSubject ||
                                   credential.subject ||
                                   credData || {}; // Fallback to the whole credData

                // Look for person data anywhere in the credential object
                let personData = {};

                // First check if credSubject has the data we need
                if (credSubject.firstName || credSubject.lastName || credSubject.uniqueId) {
                  personData = credSubject;
                } else {
                  // Search through all values in the credential object
                  Object.values(credential).forEach((value: any) => {
                    if (value && typeof value === 'object') {
                      if (value.firstName || value.lastName || value.uniqueId) {
                        personData = value;
                      }
                      // Check nested objects (like in claims array)
                      if (Array.isArray(value)) {
                        value.forEach((item: any) => {
                          if (item && typeof item === 'object') {
                            if (item.credentialSubject && (item.credentialSubject.firstName || item.credentialSubject.lastName || item.credentialSubject.uniqueId)) {
                              personData = item.credentialSubject;
                            } else if (item.firstName || item.lastName || item.uniqueId) {
                              personData = item;
                            }
                          }
                        });
                      }
                    }
                  });
                }

                const isSelected = selectedCredential === credential;

                console.log(`🎯 Credential ${index} display data:`, {
                  credData,
                  credSubject,
                  personData,
                  allCredentialKeys: Object.keys(credential),
                  claimsStructure: credential.claims
                });

                return (
                  <div
                    key={index}
                    className={`p-4 border-2 rounded-2xl cursor-pointer transition-all ${isSelected ? 'bg-gradient-to-r from-cyan-500/20 to-purple-500/20 border-cyan-500/30' : 'bg-slate-800/30 border-slate-700/50 hover:border-slate-600/50'} backdrop-blur-sm`}
                    onClick={() => handleSelectCredential(credential)}
                  >
                    <h3>{proofRequest?.credentialType} Credential #{index + 1}</h3>
                    <div className={styles.credentialDetails}>
                      {personData.firstName && (
                        <div><strong>Name:</strong> {personData.firstName} {personData.lastName}</div>
                      )}
                      {personData.dateOfBirth && (
                        <div><strong>Date of Birth:</strong> {personData.dateOfBirth}</div>
                      )}
                      {personData.uniqueId && (
                        <div><strong>ID:</strong> {personData.uniqueId}</div>
                      )}
                      {personData.gender && (
                        <div><strong>Gender:</strong> {personData.gender}</div>
                      )}

                      {/* Fallback display if no person data found */}
                      {!personData.firstName && !personData.uniqueId && (
                        <div>
                          <div><strong>Type:</strong> {credential.credentialType || 'Unknown'}</div>
                          <div><strong>Credential ID:</strong> {credential.id || `cred-${index + 1}`}</div>
                          <div><strong>Available Keys:</strong> {Object.keys(credential).join(', ')}</div>
                        </div>
                      )}
                    </div>
                    {isSelected && (
                      <div className={styles.selectedBadge}>✓ Selected</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {selectedCredential && (
          <div className={styles.submitSection}>
            <button
              onClick={handleSubmitProof}
              disabled={isSubmitting}
              className="px-6 py-3 bg-gradient-to-r from-emerald-500 to-cyan-500 text-white rounded-xl hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed text-lg font-semibold"
            >
              {isSubmitting ? 'Submitting...' : 'Submit Proof'}
            </button>
          </div>
        )}

        {error && (
          <div className={styles.errorMessage}>
            <strong>Error:</strong> {error}
          </div>
        )}
      </Box>
    </div>
  );
}