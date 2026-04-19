/**
 * SectionRenderer.tsx
 *
 * Renders a client-side decrypted document.
 * Accessible sections render their HTML content with a clearance badge.
 * Inaccessible sections render a [REDACTED] placeholder block.
 */

import React from 'react';
import type { SectionResult } from '@/utils/sectionDecryptor';

const CLEARANCE_COLORS: Record<string, string> = {
  'UNCLASSIFIED': 'text-slate-400 bg-slate-800/50 border-slate-600',
  'INTERNAL':     'text-emerald-400 bg-emerald-900/20 border-emerald-700/50',
  'CONFIDENTIAL': 'text-yellow-400 bg-yellow-900/20 border-yellow-700/50',
  'RESTRICTED':   'text-orange-400 bg-orange-900/20 border-orange-700/50',
  'SECRET':       'text-red-400 bg-red-900/20 border-red-700/50',
  'TOP-SECRET':   'text-purple-400 bg-purple-900/20 border-purple-700/50',
};

function getClearanceColors(clearance: string): string {
  return CLEARANCE_COLORS[clearance] || CLEARANCE_COLORS['INTERNAL'];
}

interface SectionRendererProps {
  sections: SectionResult[];
  documentTitle: string;
  overallClassification: string;
  userClearance: string;
}

export function SectionRenderer({
  sections,
  documentTitle,
  overallClassification,
  userClearance
}: SectionRendererProps) {
  const visibleCount  = sections.filter(s => s.accessible).length;
  const redactedCount = sections.filter(s => !s.accessible).length;

  return (
    <div className="flex flex-col gap-0 font-sans text-sm text-slate-100 bg-slate-900 rounded-xl border border-slate-700/50 overflow-hidden">
      {/* Document header */}
      <div className="px-5 py-4 border-b border-slate-700/50 bg-slate-800/50">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-white">{documentTitle}</h2>
            <p className="text-xs text-slate-400 mt-0.5">Overall classification: {overallClassification}</p>
          </div>
          <span className={`text-xs px-2 py-1 rounded border font-medium flex-shrink-0 ${getClearanceColors(overallClassification)}`}>
            {overallClassification}
          </span>
        </div>
      </div>

      {/* Sections */}
      <div className="divide-y divide-slate-700/30">
        {sections.map(section => (
          <SectionBlock key={section.sectionId} section={section} />
        ))}
      </div>

      {/* Footer */}
      <div className="px-5 py-3 border-t border-slate-700/50 bg-slate-800/30 flex items-center justify-between">
        <span className="text-xs text-slate-400">
          {visibleCount} of {sections.length} sections visible at{' '}
          <span className="font-medium text-slate-300">{userClearance}</span> clearance
        </span>
        {redactedCount > 0 && (
          <span className="text-xs text-amber-400">
            {redactedCount} section{redactedCount > 1 ? 's' : ''} redacted
          </span>
        )}
      </div>
    </div>
  );
}

function SectionBlock({ section }: { section: SectionResult }) {
  const colors = getClearanceColors(section.clearance);

  if (!section.accessible) {
    return (
      <div className="px-5 py-4 bg-slate-950/50">
        <div className="flex items-center gap-2 mb-2">
          <span className={`text-xs px-1.5 py-0.5 rounded border font-medium ${colors}`}>
            {section.clearance}
          </span>
          {section.title && (
            <span className="text-xs text-slate-500 italic">{section.title}</span>
          )}
        </div>
        <div className="flex items-center gap-3 p-3 bg-slate-800/50 border border-slate-600/30 rounded-lg">
          <div className="w-3 h-3 bg-slate-600 rounded-sm flex-shrink-0" />
          <span className="text-xs text-slate-500 font-mono">
            [REDACTED — Requires {section.clearance} clearance]
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="px-5 py-4">
      <div className="flex items-center gap-2 mb-3">
        <span className={`text-xs px-1.5 py-0.5 rounded border font-medium ${colors}`}>
          {section.clearance}
        </span>
        {section.title && (
          <span className="text-xs text-slate-400 font-medium">{section.title}</span>
        )}
      </div>
      <div
        className="prose prose-invert prose-sm max-w-none text-slate-200 leading-relaxed"
        dangerouslySetInnerHTML={{ __html: section.plaintext }}
      />
    </div>
  );
}

export default SectionRenderer;
