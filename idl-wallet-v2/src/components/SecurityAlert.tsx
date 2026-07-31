import React from 'react';

type AlertType = 'no-proof' | 'invalid-proof' | 'expired-proof';

interface SecurityAlertProps {
  type: AlertType;
  onAcceptRisk: () => void;
  onReject: () => void;
  errors?: string[];
  className?: string;
}

export const SecurityAlert: React.FC<SecurityAlertProps> = ({
  type,
  onAcceptRisk,
  onReject,
  errors = [],
  className = ''
}) => {
  const getAlertConfig = () => {
    switch (type) {
      case 'no-proof':
        return {
          icon: '⚠️',
          title: 'Unverified Inviter',
          message: 'This invitation does not include identity verification. The inviter has not provided a RealPerson credential to prove their identity.',
          severity: 'warning',
          bgColor: 'bg-amber-500/20',
          borderColor: 'border-amber-500/30',
          textColor: 'text-amber-300',
          buttonColor: 'bg-amber-500/80 hover:bg-amber-500'
        };
      case 'invalid-proof':
        return {
          icon: '🚨',
          title: 'Invalid Identity Proof',
          message: 'The provided identity proof could not be verified. This may indicate a corrupted or tampered credential.',
          severity: 'error',
          bgColor: 'bg-red-500/20',
          borderColor: 'border-red-500/30',
          textColor: 'text-red-300',
          buttonColor: 'bg-red-500/80 hover:bg-red-500'
        };
      case 'expired-proof':
        return {
          icon: '⏰',
          title: 'Expired Identity Proof',
          message: 'The provided identity credential has expired and is no longer valid for verification.',
          severity: 'error',
          bgColor: 'bg-orange-500/20',
          borderColor: 'border-orange-500/30',
          textColor: 'text-orange-300',
          buttonColor: 'bg-orange-500/80 hover:bg-orange-500'
        };
      default:
        return {
          icon: '⚠️',
          title: 'Security Alert',
          message: 'There is a security concern with this invitation.',
          severity: 'warning',
          bgColor: 'bg-slate-800/50',
          borderColor: 'border-slate-700/50',
          textColor: 'text-slate-300',
          buttonColor: 'bg-slate-600 hover:bg-slate-500'
        };
    }
  };

  const config = getAlertConfig();

  const getRiskLevel = () => {
    switch (type) {
      case 'no-proof':
        return 'MEDIUM';
      case 'invalid-proof':
      case 'expired-proof':
        return 'HIGH';
      default:
        return 'UNKNOWN';
    }
  };

  const getRecommendation = () => {
    switch (type) {
      case 'no-proof':
        return 'Consider asking the inviter to provide identity verification before establishing a connection.';
      case 'invalid-proof':
        return 'Do not accept this invitation. The identity proof appears to be tampered with or corrupted.';
      case 'expired-proof':
        return 'Ask the inviter to provide a current, valid credential before proceeding.';
      default:
        return 'Exercise caution when proceeding with this invitation.';
    }
  };

  return (
    <div className={`security-alert ${config.bgColor} ${config.borderColor} border rounded-2xl p-4 ${className}`}>
      {/* Header */}
      <div className="flex items-center space-x-3 mb-3">
        <span className="text-2xl">{config.icon}</span>
        <div>
          <h3 className={`font-bold text-lg ${config.textColor}`}>
            {config.title}
          </h3>
          <div className="flex items-center space-x-2 mt-1">
            <span className="text-sm font-medium text-slate-400">Risk Level:</span>
            <span className={`px-2 py-1 rounded-lg text-xs font-bold ${
              getRiskLevel() === 'HIGH' ? 'bg-red-500/30 text-red-300' :
              getRiskLevel() === 'MEDIUM' ? 'bg-amber-500/30 text-amber-300' :
              'bg-slate-700 text-slate-300'
            }`}>
              {getRiskLevel()}
            </span>
          </div>
        </div>
      </div>

      {/* Message */}
      <div className={`mb-4 ${config.textColor}`}>
        <p className="text-sm leading-relaxed">{config.message}</p>
      </div>

      {/* Errors (if any) */}
      {errors.length > 0 && (
        <div className="mb-4">
          <h4 className={`font-medium text-sm ${config.textColor} mb-2`}>Technical Details:</h4>
          <ul className={`text-xs ${config.textColor} space-y-1 ml-4`}>
            {errors.map((error, index) => (
              <li key={index} className="list-disc">
                {error}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Recommendation */}
      <div className={`mb-4 p-3 bg-slate-800/50 rounded-xl border border-slate-700/50 ${config.textColor}`}>
        <h4 className="font-medium text-sm mb-1">💡 Recommendation:</h4>
        <p className="text-sm">{getRecommendation()}</p>
      </div>

      {/* Actions */}
      <div className="flex space-x-3">
        <button
          onClick={onReject}
          className="flex-1 px-4 py-2 bg-slate-700/50 hover:bg-slate-700 text-white font-medium rounded-xl transition-colors border border-slate-600/50"
        >
          🛡️ Reject Invitation
        </button>
        <button
          onClick={onAcceptRisk}
          className={`flex-1 px-4 py-2 ${config.buttonColor} text-white font-medium rounded-xl transition-colors`}
        >
          ⚠️ Accept Risk & Continue
        </button>
      </div>

      {/* Disclaimer */}
      <div className="mt-3 pt-3 border-t border-slate-700/50">
        <p className={`text-xs ${config.textColor} opacity-75`}>
          <strong>Security Notice:</strong> Proceeding without identity verification increases the risk of
          connecting with malicious actors. Only accept if you trust the source of this invitation.
        </p>
      </div>
    </div>
  );
};
