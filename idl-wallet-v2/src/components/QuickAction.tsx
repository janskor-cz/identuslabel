import React from 'react';

interface QuickActionProps {
  icon: string;
  label: string;
  onClick?: () => void;
  variant?: 'default' | 'primary';
}

export const QuickAction: React.FC<QuickActionProps> = ({ icon, label, onClick, variant = 'default' }) => {
  const variants = {
    default: 'bg-slate-800/50 hover:bg-slate-700/50 border-slate-700/50 text-slate-300',
    primary: 'bg-gradient-to-r from-cyan-500/20 to-purple-500/20 hover:from-cyan-500/30 hover:to-purple-500/30 border-cyan-500/30 text-cyan-400'
  };

  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center gap-2 p-4 rounded-xl border transition-all duration-200 ${variants[variant]}`}
    >
      <span className="text-2xl">{icon}</span>
      <span className="text-xs font-medium">{label}</span>
    </button>
  );
};

export default QuickAction;
