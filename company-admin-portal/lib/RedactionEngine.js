/**
 * RedactionEngine.js
 *
 * Generates view-ready HTML documents with redacted sections.
 * Sections the user doesn't have clearance for are replaced with
 * black boxes displaying "REDACTED - Requires X clearance".
 */

const { JSDOM } = require('jsdom');
const { CLEARANCE_LEVELS } = require('./ClearanceDocumentParser');

// Redaction CSS styles
const REDACTION_STYLES = `
<style id="redaction-styles">
  /* Block-level redaction box */
  .redacted-block {
    background: #000000;
    color: #ffffff;
    padding: 30px;
    margin: 15px 0;
    border: 3px solid #ff0000;
    border-radius: 4px;
    text-align: center;
    min-height: 80px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
  }

  .redaction-box {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }

  .redaction-label {
    font-size: 28px;
    font-weight: bold;
    letter-spacing: 6px;
    text-transform: uppercase;
  }

  .clearance-required {
    font-size: 14px;
    opacity: 0.8;
    font-style: italic;
  }

  /* Inline redaction marker */
  .redacted-inline {
    background: #000000;
    color: #ff4444;
    padding: 2px 8px;
    border-radius: 3px;
    font-family: monospace;
    font-size: 0.9em;
    display: inline;
  }

  /* Redacted table row */
  tr.redacted-row td {
    background: #000000 !important;
    color: #ff4444 !important;
    text-align: center;
  }

  /* Classification badges for visible sections */
  .classification-badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 3px;
    font-size: 11px;
    font-weight: bold;
    margin-right: 8px;
    vertical-align: middle;
  }

  .classification-UNCLASSIFIED { background: #4CAF50; color: white; }
  .classification-CONFIDENTIAL { background: #2196F3; color: white; }
  .classification-SECRET { background: #FF9800; color: white; }
  .classification-TOP_SECRET { background: #f44336; color: white; }

  /* Security watermark */
  .security-watermark {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%) rotate(-45deg);
    font-size: 100px;
    opacity: 0.05;
    pointer-events: none;
    z-index: 1000;
    white-space: nowrap;
    color: #000;
    font-weight: bold;
  }

  /* Document header with classification */
  .document-classification-header {
    background: #f5f5f5;
    border-bottom: 2px solid #333;
    padding: 10px 20px;
    margin-bottom: 20px;
    font-size: 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .document-classification-header .classification {
    font-weight: bold;
    padding: 4px 12px;
    border-radius: 4px;
  }

  .document-classification-header .viewer-info {
    color: #666;
  }
</style>
`;

/**
 * Generate redacted HTML document
 * @param {Object} decryptionResult - Result from SectionEncryptionService.decryptSectionsForUser
 * @param {Object} options - Redaction options
 * @returns {string} Complete HTML document with redactions
 */
function generateRedactedDocument(decryptionResult, options = {}) {
  const {
    decryptedSections,
    redactedSections,
    metadata,
    userClearance,
    userClearanceLevel
  } = decryptionResult;

  const {
    includeWatermark = true,
    includeHeader = true,
    viewerName = 'Unknown',
    viewerDID = null,
    copyId = null
  } = options;

  // Create new HTML document
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>');
  const document = dom.window.document;

  // Set up head
  const head = document.head;
  head.innerHTML = `
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(metadata.title || 'Document')}</title>
    ${REDACTION_STYLES}
  `;

  // Build body content
  const body = document.body;

  // Add classification header
  if (includeHeader) {
    const header = createClassificationHeader(document, metadata, userClearance, viewerName, viewerDID, copyId);
    body.appendChild(header);
  }

  // Add watermark
  if (includeWatermark) {
    const watermark = document.createElement('div');
    watermark.className = 'security-watermark';
    watermark.textContent = metadata.overallClassification || 'CLASSIFIED';
    body.appendChild(watermark);
  }

  // Create content container
  const contentContainer = document.createElement('div');
  contentContainer.id = 'document-content';
  contentContainer.style.cssText = 'max-width: 800px; margin: 0 auto; padding: 20px;';

  // Add document title
  const title = document.createElement('h1');
  title.textContent = metadata.title || 'Document';
  contentContainer.appendChild(title);

  // Combine and sort sections by original order (using sectionId)
  const allSections = [
    ...decryptedSections.map(s => ({ ...s, isRedacted: false })),
    ...redactedSections.map(s => ({ ...s, isRedacted: true }))
  ].sort((a, b) => {
    // Sort by section ID (sec-001, sec-002, etc.)
    return a.sectionId.localeCompare(b.sectionId);
  });

  // Render each section
  for (const section of allSections) {
    if (section.isRedacted) {
      // Create redaction element
      const redactedElement = createRedactionElement(document, section);
      contentContainer.appendChild(redactedElement);
    } else {
      // Create visible section with content
      const visibleElement = createVisibleSection(document, section);
      contentContainer.appendChild(visibleElement);
    }
  }

  body.appendChild(contentContainer);

  // Add footer with redaction summary
  const footer = createRedactionFooter(document, decryptedSections, redactedSections, userClearance);
  body.appendChild(footer);

  return dom.serialize();
}

/**
 * Create classification header element
 */
function createClassificationHeader(document, metadata, userClearance, viewerName, viewerDID, copyId) {
  const header = document.createElement('div');
  header.className = 'document-classification-header';

  const classification = document.createElement('span');
  classification.className = `classification classification-${metadata.overallClassification}`;
  classification.textContent = metadata.overallClassification || 'UNCLASSIFIED';

  const viewerInfo = document.createElement('span');
  viewerInfo.className = 'viewer-info';
  viewerInfo.innerHTML = `
    Viewer: ${escapeHtml(viewerName)} |
    Clearance: ${userClearance} |
    ${copyId ? `Copy ID: ${copyId.substring(0, 8)}...` : ''}
  `;

  header.appendChild(classification);
  header.appendChild(viewerInfo);

  return header;
}

/**
 * Create a redaction element (black box)
 */
function createRedactionElement(document, section) {
  if (section.isInline) {
    // Inline redaction
    const span = document.createElement('span');
    span.className = 'redacted-inline';
    span.setAttribute('data-clearance', section.clearance);
    span.setAttribute('data-section-id', section.sectionId);
    span.textContent = `[REDACTED - ${section.clearance}]`;
    return span;
  }

  // Block redaction
  const div = document.createElement('div');
  div.className = 'redacted-block';
  div.setAttribute('data-original-tag', section.tagName || 'section');
  div.setAttribute('data-clearance', section.clearance);
  div.setAttribute('data-section-id', section.sectionId);

  div.innerHTML = `
    <div class="redaction-box">
      <span class="redaction-label">REDACTED</span>
      <span class="clearance-required">Requires: ${section.clearance} clearance</span>
    </div>
  `;

  return div;
}

/**
 * Create a visible section element
 * Classification badge is shown via CSS ::before pseudo-element using data-clearance attribute
 */
function createVisibleSection(document, section) {
  const wrapper = document.createElement(section.tagName || 'section');
  wrapper.setAttribute('data-clearance', section.clearance);
  wrapper.setAttribute('data-section-id', section.sectionId);

  // Parse and insert content (no visible badge - CSS handles display)
  wrapper.innerHTML = section.content;

  return wrapper;
}

/**
 * Create redaction footer with summary
 */
function createRedactionFooter(document, decryptedSections, redactedSections, userClearance) {
  const footer = document.createElement('div');
  footer.style.cssText = `
    margin-top: 40px;
    padding: 20px;
    background: #f9f9f9;
    border-top: 2px solid #ddd;
    font-size: 12px;
    color: #666;
  `;

  const visibleCount = decryptedSections.length;
  const redactedCount = redactedSections.length;
  const totalCount = visibleCount + redactedCount;

  footer.innerHTML = `
    <p><strong>Document Access Summary</strong></p>
    <p>Your clearance level: <strong>${userClearance}</strong></p>
    <p>Sections visible: ${visibleCount} of ${totalCount}</p>
    <p>Sections redacted: ${redactedCount}</p>
    ${redactedCount > 0 ? `
      <p style="color: #c00;">
        To view redacted content, you need higher clearance:
        ${[...new Set(redactedSections.map(s => s.clearance))].join(', ')}
      </p>
    ` : ''}
    <p style="margin-top: 10px; font-style: italic;">
      Generated: ${new Date().toISOString()}
    </p>
  `;

  return footer;
}

/**
 * Apply redaction to an existing HTML document
 * @param {string} htmlString - Original HTML document
 * @param {number} userClearanceLevel - User's clearance level (1-4)
 * @param {Object} options - Redaction options
 * @returns {string} Redacted HTML document
 */
function applyRedactionToHtml(htmlString, userClearanceLevel, options = {}) {
  const dom = new JSDOM(htmlString);
  const document = dom.window.document;

  // Inject redaction styles
  const styleElement = document.createElement('style');
  styleElement.id = 'redaction-styles';
  styleElement.textContent = REDACTION_STYLES.replace(/<\/?style[^>]*>/g, '');
  document.head.appendChild(styleElement);

  // Find all elements with data-clearance
  const classifiedElements = document.querySelectorAll('[data-clearance]');
  const redactedInfo = [];

  classifiedElements.forEach(element => {
    const elementClearance = element.getAttribute('data-clearance').toUpperCase();
    const elementLevel = CLEARANCE_LEVELS[elementClearance] || 1;

    // Check if user can see this content
    if (elementLevel > userClearanceLevel) {
      // Redact this element
      const isInline = ['SPAN', 'A', 'STRONG', 'EM', 'B', 'I', 'CODE', 'MARK'].includes(element.tagName);

      redactedInfo.push({
        tagName: element.tagName.toLowerCase(),
        clearance: elementClearance,
        isInline
      });

      if (isInline) {
        // Replace with inline redaction
        const redactionSpan = document.createElement('span');
        redactionSpan.className = 'redacted-inline';
        redactionSpan.setAttribute('data-clearance', elementClearance);
        redactionSpan.textContent = `[REDACTED - ${elementClearance}]`;
        element.parentNode.replaceChild(redactionSpan, element);
      } else {
        // Replace with block redaction
        const redactionDiv = document.createElement('div');
        redactionDiv.className = 'redacted-block';
        redactionDiv.setAttribute('data-original-tag', element.tagName.toLowerCase());
        redactionDiv.setAttribute('data-clearance', elementClearance);
        redactionDiv.innerHTML = `
          <div class="redaction-box">
            <span class="redaction-label">REDACTED</span>
            <span class="clearance-required">Requires: ${elementClearance} clearance</span>
          </div>
        `;
        element.parentNode.replaceChild(redactionDiv, element);
      }
    }
  });

  // Add watermark if option enabled
  if (options.includeWatermark) {
    const watermark = document.createElement('div');
    watermark.className = 'security-watermark';
    watermark.textContent = options.classification || 'CLASSIFIED';
    document.body.appendChild(watermark);
  }

  return {
    html: dom.serialize(),
    redactedCount: redactedInfo.length,
    redactedSections: redactedInfo
  };
}

/**
 * Generate a simple redacted view for API response
 * @param {Array} decryptedSections - Sections user can see
 * @param {Array} redactedSections - Sections that are redacted
 * @param {Object} metadata - Document metadata
 * @returns {Object} JSON-friendly representation
 */
function generateRedactedView(decryptedSections, redactedSections, metadata) {
  return {
    title: metadata.title,
    overallClassification: metadata.overallClassification,
    sections: [
      ...decryptedSections.map(s => ({
        sectionId: s.sectionId,
        clearance: s.clearance,
        title: s.title,
        content: s.content,
        isRedacted: false
      })),
      ...redactedSections.map(s => ({
        sectionId: s.sectionId,
        clearance: s.clearance,
        title: s.title,
        content: null,
        isRedacted: true,
        redactionMessage: `REDACTED - Requires ${s.clearance} clearance`
      }))
    ].sort((a, b) => a.sectionId.localeCompare(b.sectionId)),
    summary: {
      totalSections: decryptedSections.length + redactedSections.length,
      visibleSections: decryptedSections.length,
      redactedSections: redactedSections.length
    }
  };
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

module.exports = {
  generateRedactedDocument,
  applyRedactionToHtml,
  generateRedactedView,
  REDACTION_STYLES
};
