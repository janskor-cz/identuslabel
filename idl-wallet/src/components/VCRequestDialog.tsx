import React, { useState } from 'react';
import SDK from '@hyperledger/identus-edge-agent-sdk';
import { useMountedApp } from '@/reducers/store';

interface VCRequestDialogProps {
  connection: SDK.Domain.DIDPair;
  onClose: () => void;
}

export const VCRequestDialog: React.FC<VCRequestDialogProps> = ({ connection, onClose }) => {
  const app = useMountedApp();
  const [isProcessing, setIsProcessing] = useState(false);
  const [vcRequestType, setVcRequestType] = useState<'RealPerson' | 'SecurityClearance'>('RealPerson');

  const handleVCRequest = async () => {
    if (!app.agent.instance) return;

    try {
      setIsProcessing(true);
      console.log(`📋 Requesting ${vcRequestType} VC from connection...`);

      // Use the receiver DID (the other party's DID)
      const targetDID = connection.receiver;

      // Create presentation claims based on VC type
      let presentationClaims;
      let credentialType;

      if (vcRequestType === 'RealPerson') {
        presentationClaims = {
          "uniqueId": {
            type: "string",
            pattern: ".*"
          },
          "firstName": {
            type: "string",
            pattern: ".*"
          },
          "lastName": {
            type: "string",
            pattern: ".*"
          },
          "dateOfBirth": {
            type: "string",
            pattern: ".*"
          },
          "gender": {
            type: "string",
            pattern: ".*"
          }
        };
        credentialType = SDK.Domain.CredentialType.JWT;
      } else {
        // Security Clearance VC
        presentationClaims = {
          "clearanceLevel": {
            type: "string",
            pattern: ".*"
          },
          "clearanceId": {
            type: "string",
            pattern: ".*"
          },
          "issuedAt": {
            type: "string",
            pattern: ".*"
          },
          "expiresAt": {
            type: "string",
            pattern: ".*"
          },
          "publicKeyFingerprint": {
            type: "string",
            pattern: ".*"
          }
        };
        credentialType = SDK.Domain.CredentialType.JWT;
      }

      console.log('🎯 [VC REQUEST] Sending presentation request:', {
        targetDID: targetDID.toString().substring(0, 60) + '...',
        vcType: vcRequestType,
        credentialType,
        claims: Object.keys(presentationClaims)
      });

      // Send the VC request using the SDK action
      await app.initiatePresentationRequest({
        agent: app.agent.instance,
        toDID: targetDID,
        presentationClaims: presentationClaims,
        type: credentialType
      });

      console.log(`✅ [VC REQUEST] ${vcRequestType} VC request sent successfully`);
      onClose();

    } catch (error) {
      console.error('❌ Failed to request VC:', error);
      alert(`Failed to request VC: ${error.message}`);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">
            📋 Request VC
          </h2>
          <button
            onClick={onClose}
            disabled={isProcessing}
            className="text-gray-500 hover:text-gray-700 disabled:opacity-50"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label htmlFor="vcType" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Credential Type
            </label>
            <select
              id="vcType"
              value={vcRequestType}
              onChange={(e) => setVcRequestType(e.target.value as 'RealPerson' | 'SecurityClearance')}
              disabled={isProcessing}
              className="w-full p-3 border border-gray-300 dark:border-gray-600 rounded-lg
                       bg-white dark:bg-gray-700 text-gray-900 dark:text-white
                       focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
            >
              <option value="RealPerson">RealPerson VC</option>
              <option value="SecurityClearance">Security Clearance VC</option>
            </select>
          </div>

          <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4">
            <h3 className="font-semibold text-gray-900 dark:text-white mb-2">
              Requested Fields:
            </h3>
            <div className="text-sm text-gray-600 dark:text-gray-400">
              {vcRequestType === 'RealPerson'
                ? 'firstName, lastName, uniqueId, dateOfBirth, gender'
                : 'clearanceLevel, clearanceId, issuedAt, expiresAt, publicKeyFingerprint'
              }
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-500 mt-2">
              The other party will be asked to present a {vcRequestType} credential with these fields.
            </p>
          </div>

          <div className="flex space-x-3">
            <button
              onClick={handleVCRequest}
              disabled={isProcessing}
              className="flex-1 px-4 py-2 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-400
                       text-white rounded-lg transition-colors duration-200
                       disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {isProcessing ? 'Requesting...' : 'Send Request'}
            </button>
            <button
              onClick={onClose}
              disabled={isProcessing}
              className="flex-1 px-4 py-2 bg-gray-500 hover:bg-gray-600 disabled:bg-gray-400
                       text-white rounded-lg transition-colors duration-200
                       disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-gray-500"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};