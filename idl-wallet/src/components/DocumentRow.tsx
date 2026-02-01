import React from 'react';

type Classification = 'public' | 'internal' | 'confidential' | 'unclassified' | 'secret' | 'top_secret';

interface DocumentRowProps {
  name: string;
  classification: Classification;
  date: string;
  size?: string;
  onClick?: () => void;
}

export const DocumentRow: React.FC<DocumentRowProps> = ({ name, classification, date, size, onClick }) => {
  const classColors: Record<Classification, string> = {
    unclassified: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    public: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    internal: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
    confidential: 'bg-red-500/20 text-red-400 border-red-500/30',
    secret: 'bg-red-600/20 text-red-500 border-red-600/30',
    top_secret: 'bg-red-700/20 text-red-600 border-red-700/30'
  };

  const displayLabel = classification.replace('_', ' ').toUpperCase();

  return (
    <div
      className="flex items-center gap-4 p-3 rounded-xl hover:bg-white/5 transition-colors group cursor-pointer"
      onClick={onClick}
    >
      <div className="w-10 h-10 rounded-lg bg-slate-700/50 flex items-center justify-center text-slate-400">
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      </div>
      <div className="flex-1 min-w-0">
        <h4 className="text-sm font-medium text-white truncate">{name}</h4>
        <p className="text-xs text-slate-500">{date}{size ? ` · ${size}` : ''}</p>
      </div>
      <span className={`px-2 py-1 text-xs rounded-full border font-medium ${classColors[classification] || classColors.public}`}>
        {displayLabel}
      </span>
      <button className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-white transition-all p-1">
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
          <circle cx="12" cy="6" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="12" cy="18" r="2" />
        </svg>
      </button>
    </div>
  );
};

export default DocumentRow;
