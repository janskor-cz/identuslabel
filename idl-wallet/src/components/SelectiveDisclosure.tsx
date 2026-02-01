import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { DisclosureLevel, DISCLOSURE_PRESETS, FIELD_LABELS } from '../types/invitations';
import { extractCredentialSubject } from '../utils/vcValidation';
import { getFieldsForDisclosureLevel, applySelectiveDisclosure } from '../utils/selectiveDisclosure';

interface SelectiveDisclosureProps {
  credential: any;
  onFieldSelection: (fields: string[], level: DisclosureLevel) => void;
  initialLevel?: DisclosureLevel;
}

export const SelectiveDisclosure: React.FC<SelectiveDisclosureProps> = ({
  credential,
  onFieldSelection,
  initialLevel = 'minimal'
}) => {
  const [selectedLevel, setSelectedLevel] = useState<DisclosureLevel>(initialLevel);
  const [customFields, setCustomFields] = useState<string[]>([]);
  const [isCustomMode, setIsCustomMode] = useState(false);

  const credentialSubject = useMemo(() => extractCredentialSubject(credential), [credential]);
  const availableFields = useMemo(() => Object.keys(credentialSubject), [credentialSubject]);

  // Stabilize the callback to prevent infinite re-renders
  const stableOnFieldSelection = useCallback(onFieldSelection, []);

  useEffect(() => {
    if (!isCustomMode) {
      const presetFields = getFieldsForDisclosureLevel(selectedLevel);
      const validFields = presetFields.filter(field => availableFields.includes(field));
      setCustomFields(validFields);
      stableOnFieldSelection(validFields, selectedLevel);
    }
  }, [selectedLevel, isCustomMode, availableFields, stableOnFieldSelection]);

  useEffect(() => {
    if (isCustomMode) {
      // Determine appropriate disclosure level based on custom field selection
      let customLevel: DisclosureLevel = 'minimal';

      // Match custom selection to appropriate preset level
      const minimalFields = DISCLOSURE_PRESETS.minimal.fields;
      const standardFields = DISCLOSURE_PRESETS.standard.fields;
      const fullFields = DISCLOSURE_PRESETS.full.fields;

      if (customFields.length >= fullFields.length && fullFields.every(field => customFields.includes(field))) {
        customLevel = 'full';
      } else if (customFields.length >= standardFields.length && standardFields.every(field => customFields.includes(field))) {
        customLevel = 'standard';
      } else {
        customLevel = 'minimal';
      }

      console.log(`🎛️ Custom field selection mapped to disclosure level: ${customLevel}`);
      stableOnFieldSelection(customFields, customLevel);
    }
  }, [customFields, isCustomMode, stableOnFieldSelection]);

  const handlePresetChange = (level: DisclosureLevel) => {
    console.log(`📋 Preset disclosure level selected: ${level}`);
    setSelectedLevel(level);
    setIsCustomMode(false);
  };

  const handleCustomFieldToggle = (field: string) => {
    setCustomFields(prev => {
      if (prev.includes(field)) {
        return prev.filter(f => f !== field);
      } else {
        return [...prev, field];
      }
    });
  };

  const getPreviewData = () => {
    const fieldsToShow = isCustomMode ? customFields : getFieldsForDisclosureLevel(selectedLevel);
    return applySelectiveDisclosure(credential, fieldsToShow);
  };

  const previewData = getPreviewData();

  return (
    <div className="selective-disclosure">
      <h3 className="text-lg font-semibold mb-4 text-white">🔒 Choose Information to Share</h3>

      {/* Disclosure Level Presets */}
      <div className="disclosure-presets mb-6">
        <h4 className="text-md font-medium mb-3 text-slate-300">Preset Levels:</h4>
        <div className="space-y-2">
          {Object.entries(DISCLOSURE_PRESETS).map(([level, preset]) => (
            <label key={level} className="flex items-center space-x-3 cursor-pointer">
              <input
                type="radio"
                name="disclosureLevel"
                value={level}
                checked={selectedLevel === level && !isCustomMode}
                onChange={() => handlePresetChange(level as DisclosureLevel)}
                className="h-4 w-4 text-cyan-500 accent-cyan-500"
              />
              <div>
                <div className="font-medium text-white">{preset.label}</div>
                <div className="text-sm text-slate-400">{preset.description}</div>
              </div>
            </label>
          ))}

          <label className="flex items-center space-x-3 cursor-pointer">
            <input
              type="radio"
              name="disclosureLevel"
              value="custom"
              checked={isCustomMode}
              onChange={() => setIsCustomMode(true)}
              className="h-4 w-4 text-cyan-500 accent-cyan-500"
            />
            <div>
              <div className="font-medium text-white">Custom Selection</div>
              <div className="text-sm text-slate-400">Choose specific fields to share</div>
            </div>
          </label>
        </div>
      </div>

      {/* Custom Field Selection */}
      {isCustomMode && (
        <div className="custom-fields mb-6">
          <h4 className="text-md font-medium mb-3 text-slate-300">Select Fields:</h4>
          <div className="space-y-2">
            {availableFields.map(field => (
              <label key={field} className="flex items-center space-x-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={customFields.includes(field)}
                  onChange={() => handleCustomFieldToggle(field)}
                  className="h-4 w-4 text-cyan-500 accent-cyan-500"
                />
                <span className="font-medium text-white">
                  {FIELD_LABELS[field as keyof typeof FIELD_LABELS] || field}
                </span>
                <span className="text-sm text-slate-400">
                  ({credentialSubject[field]})
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Preview Section */}
      <div className="preview-section">
        <h4 className="text-md font-medium mb-3 text-slate-300">📋 Preview - What will be shared:</h4>
        <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-4">
          {Object.keys(previewData).length === 0 ? (
            <div className="text-slate-500 italic">No fields selected for sharing</div>
          ) : (
            <div className="space-y-2">
              {Object.entries(previewData).map(([field, value]) => (
                <div key={field} className="flex justify-between">
                  <span className="font-medium text-slate-300">
                    {FIELD_LABELS[field as keyof typeof FIELD_LABELS] || field}:
                  </span>
                  <span className="text-white">{value}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Information Box */}
      <div className="info-box mt-4 p-3 bg-cyan-500/20 border border-cyan-500/30 rounded-xl">
        <div className="text-sm text-cyan-300">
          <strong>🔒 Privacy Note:</strong> Only the selected information will be included in your invitation.
          Hidden fields will not be visible to the recipient.
        </div>
      </div>
    </div>
  );
};