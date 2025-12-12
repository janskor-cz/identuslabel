/**
 * DocxClearanceParser.js
 *
 * Parses Microsoft Word (DOCX) documents with clearance-level markers.
 * Supports TWO methods for marking classified content:
 *
 * METHOD 1: PARAGRAPH STYLES (Recommended - User-Friendly)
 * =========================================================
 * Users apply predefined paragraph styles from Word's style dropdown:
 * - "Unclassified" or "Public" → UNCLASSIFIED
 * - "Confidential" → CONFIDENTIAL
 * - "Secret" → SECRET
 * - "TopSecret" or "Top_Secret" → TOP_SECRET
 *
 * Simply: Select text → Apply style from dropdown. Done!
 *
 * METHOD 2: CONTENT CONTROLS (Advanced)
 * =====================================
 * For complex documents, use Content Controls with tags:
 * 1. Select content
 * 2. Developer Tab → Rich Text Content Control
 * 3. Properties → Tag: "clearance:CONFIDENTIAL"
 *
 * This parser extracts both paragraph styles and SDTs with clearance
 * tags and converts to the same section format used by ClearanceDocumentParser.
 */

const JSZip = require('jszip');
const xml2js = require('xml2js');
const crypto = require('crypto');

// Import shared clearance constants
const { CLEARANCE_LEVELS, VALID_CLEARANCE_VALUES, getClearanceName } = require('./ClearanceDocumentParser');

// Word XML namespaces
const WORD_NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
};

// Style name to clearance level mapping (case-insensitive)
// Users apply these styles from Word's style dropdown
const STYLE_CLEARANCE_MAP = {
  // Unclassified styles
  'unclassified': 'UNCLASSIFIED',
  'public': 'UNCLASSIFIED',
  'clearance_unclassified': 'UNCLASSIFIED',
  'clearanceunclassified': 'UNCLASSIFIED',

  // Confidential styles
  'confidential': 'CONFIDENTIAL',
  'clearance_confidential': 'CONFIDENTIAL',
  'clearanceconfidential': 'CONFIDENTIAL',

  // Secret styles
  'secret': 'SECRET',
  'clearance_secret': 'SECRET',
  'clearancesecret': 'SECRET',

  // Top Secret styles
  'topsecret': 'TOP_SECRET',
  'top_secret': 'TOP_SECRET',
  'top-secret': 'TOP_SECRET',
  'clearance_topsecret': 'TOP_SECRET',
  'clearance_top_secret': 'TOP_SECRET',
  'clearancetopsecret': 'TOP_SECRET'
};

/**
 * Get clearance level from a paragraph style name
 * @param {string} styleName - Word paragraph style name
 * @returns {string|null} Clearance level or null if not a clearance style
 */
function getClearanceFromStyle(styleName) {
  if (!styleName) return null;

  // Normalize style name: lowercase, remove spaces
  const normalized = styleName.toLowerCase().replace(/\s+/g, '');

  // Direct lookup
  if (STYLE_CLEARANCE_MAP[normalized]) {
    return STYLE_CLEARANCE_MAP[normalized];
  }

  // Try with underscores replaced by empty string
  const noUnderscores = normalized.replace(/_/g, '');
  if (STYLE_CLEARANCE_MAP[noUnderscores]) {
    return STYLE_CLEARANCE_MAP[noUnderscores];
  }

  // Check if style name contains a clearance keyword
  for (const [key, value] of Object.entries(STYLE_CLEARANCE_MAP)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return value;
    }
  }

  return null;
}

/**
 * Parse a DOCX file and extract clearance sections from both:
 * 1. Paragraph Styles (user-friendly - recommended)
 * 2. Content Controls / SDTs (advanced method)
 *
 * @param {Buffer} docxBuffer - The DOCX file buffer
 * @returns {Promise<Object>} Parsed document with metadata and sections
 */
async function parseDocxClearanceSections(docxBuffer) {
  const zip = new JSZip();
  await zip.loadAsync(docxBuffer);

  // Parse document.xml (main content)
  const documentXml = await zip.file('word/document.xml').async('string');
  const parser = new xml2js.Parser({
    explicitArray: true,
    tagNameProcessors: [xml2js.processors.stripPrefix]
  });

  const doc = await parser.parseStringPromise(documentXml);

  // Load style definitions from styles.xml
  const styleMap = await loadStyleDefinitions(zip);

  // Extract metadata from core.xml if available
  const metadata = await extractDocxMetadata(zip);

  // Find all sections (from styles and SDTs)
  const sections = [];
  let sectionCounter = 0;
  const processedIds = new Set();

  // METHOD 1: Extract paragraphs with clearance styles (User-Friendly)
  if (doc.document && doc.document.body) {
    for (const bodyContent of doc.document.body) {
      findStyledParagraphs(bodyContent, styleMap, sections, sectionCounter, processedIds);
      sectionCounter = sections.length;
    }
  }

  // METHOD 2: Extract SDT Content Controls (Advanced)
  // Recursive function to find SDTs
  function findSDTs(obj, path = '') {
    if (!obj || typeof obj !== 'object') return;

    // Check if this is an SDT element
    if (obj.sdt) {
      const sdtArray = Array.isArray(obj.sdt) ? obj.sdt : [obj.sdt];

      for (const sdt of sdtArray) {
        const section = extractSDTSection(sdt, sectionCounter, processedIds);
        if (section) {
          sectionCounter++;
          sections.push(section);
        }
      }
    }

    // Recursively search
    for (const key of Object.keys(obj)) {
      if (Array.isArray(obj[key])) {
        for (const item of obj[key]) {
          findSDTs(item, `${path}.${key}`);
        }
      } else if (typeof obj[key] === 'object') {
        findSDTs(obj[key], `${path}.${key}`);
      }
    }
  }

  // Start searching from document body (for SDTs)
  if (doc.document && doc.document.body) {
    for (const bodyContent of doc.document.body) {
      findSDTs(bodyContent);
    }
  }

  // Extract unmarked content (treated as UNCLASSIFIED)
  const unclassifiedContent = await extractUnmarkedContent(doc, sections);
  if (unclassifiedContent && unclassifiedContent.textLength > 0) {
    sections.unshift({
      sectionId: 'sec-000',
      clearance: 'UNCLASSIFIED',
      clearanceLevel: 1,
      tagName: 'div',
      isInline: false,
      title: 'Public Content',
      content: unclassifiedContent.content,
      textLength: unclassifiedContent.textLength,
      contentHash: crypto
        .createHash('sha256')
        .update(unclassifiedContent.content)
        .digest('hex')
        .substring(0, 16),
      attributes: {},
      sourceFormat: 'docx-unmarked'
    });
  }

  // Determine overall document classification
  const overallClassification = determineOverallClassification(sections);

  metadata.overallClassification = overallClassification;
  metadata.sectionCount = sections.length;
  metadata.clearanceLevelStats = calculateClearanceStats(sections);
  metadata.sourceFormat = 'docx';

  return {
    metadata,
    sections,
    parsedAt: new Date().toISOString()
  };
}

/**
 * Load style definitions from styles.xml
 * Maps style IDs to style names for clearance lookup
 * @param {JSZip} zip - Unzipped DOCX
 * @returns {Promise<Object>} Map of styleId → { name, clearance }
 */
async function loadStyleDefinitions(zip) {
  const styleMap = {};

  try {
    const stylesFile = zip.file('word/styles.xml');
    if (!stylesFile) return styleMap;

    const stylesXml = await stylesFile.async('string');
    const parser = new xml2js.Parser({
      explicitArray: true,
      tagNameProcessors: [xml2js.processors.stripPrefix]
    });
    const styles = await parser.parseStringPromise(stylesXml);

    // Extract paragraph styles
    if (styles.styles && styles.styles.style) {
      const styleArray = Array.isArray(styles.styles.style)
        ? styles.styles.style
        : [styles.styles.style];

      for (const style of styleArray) {
        const styleId = style.$ && style.$['w:styleId'];
        const styleName = style.name && style.name[0] && style.name[0].$ && style.name[0].$['w:val'];
        const styleType = style.$ && style.$['w:type'];

        // Only process paragraph styles
        if (styleId && styleType === 'paragraph') {
          const clearance = getClearanceFromStyle(styleName || styleId);
          if (clearance) {
            styleMap[styleId] = {
              name: styleName || styleId,
              clearance
            };
          }
        }
      }
    }
  } catch (error) {
    console.warn('Failed to load style definitions:', error.message);
  }

  return styleMap;
}

/**
 * Find paragraphs with clearance styles
 * @param {Object} obj - Parsed XML object to search
 * @param {Object} styleMap - Map of styleId → { name, clearance }
 * @param {Array} sections - Array to add found sections
 * @param {number} startCounter - Starting section counter
 * @param {Set} processedIds - Set of already processed section IDs
 */
function findStyledParagraphs(obj, styleMap, sections, startCounter, processedIds) {
  if (!obj || typeof obj !== 'object') return;

  // Check for paragraph elements
  if (obj.p) {
    const paragraphs = Array.isArray(obj.p) ? obj.p : [obj.p];

    // Group consecutive paragraphs with the same clearance
    let currentClearance = null;
    let currentParagraphs = [];

    for (const p of paragraphs) {
      // Get paragraph style
      const pPr = p.pPr && p.pPr[0];
      const pStyleEl = pPr && pPr.pStyle && pPr.pStyle[0];
      const styleId = pStyleEl && pStyleEl.$ && pStyleEl.$['w:val'];

      // Check if this style has a clearance
      const styleInfo = styleMap[styleId];
      const clearance = styleInfo ? styleInfo.clearance : null;

      if (clearance) {
        if (clearance === currentClearance) {
          // Same clearance - add to current group
          currentParagraphs.push(p);
        } else {
          // Different clearance - finalize previous group and start new one
          if (currentClearance && currentParagraphs.length > 0) {
            addStyledSection(currentParagraphs, currentClearance, styleMap[styleId]?.name || currentClearance,
              sections, sections.length + startCounter, processedIds);
          }
          currentClearance = clearance;
          currentParagraphs = [p];
        }
      } else if (currentClearance && currentParagraphs.length > 0) {
        // Non-clearance paragraph - finalize current group
        addStyledSection(currentParagraphs, currentClearance, styleMap[styleId]?.name || currentClearance,
          sections, sections.length + startCounter, processedIds);
        currentClearance = null;
        currentParagraphs = [];
      }
    }

    // Finalize any remaining group
    if (currentClearance && currentParagraphs.length > 0) {
      addStyledSection(currentParagraphs, currentClearance, currentClearance,
        sections, sections.length + startCounter, processedIds);
    }
  }

  // Recursively search other elements (but not paragraphs again)
  for (const key of Object.keys(obj)) {
    if (key !== 'p') {
      if (Array.isArray(obj[key])) {
        for (const item of obj[key]) {
          findStyledParagraphs(item, styleMap, sections, startCounter, processedIds);
        }
      } else if (typeof obj[key] === 'object') {
        findStyledParagraphs(obj[key], styleMap, sections, startCounter, processedIds);
      }
    }
  }
}

/**
 * Add a section from styled paragraphs
 * @param {Array} paragraphs - Array of paragraph XML objects
 * @param {string} clearance - Clearance level
 * @param {string} styleName - Style name for title
 * @param {Array} sections - Array to add section to
 * @param {number} counter - Section counter
 * @param {Set} processedIds - Set of processed IDs
 */
function addStyledSection(paragraphs, clearance, styleName, sections, counter, processedIds) {
  // Generate section ID
  let sectionId = `sec-${String(counter + 1).padStart(3, '0')}`;
  while (processedIds.has(sectionId)) {
    sectionId = `sec-${String(++counter + 1).padStart(3, '0')}`;
  }
  processedIds.add(sectionId);

  // Extract text content from paragraphs
  const textParts = [];
  const htmlParts = [];

  for (const p of paragraphs) {
    const pText = extractParagraphText(p);
    if (pText) {
      textParts.push(pText);
      htmlParts.push(`<p>${escapeHtml(pText)}</p>`);
    }
  }

  const textContent = textParts.join('\n');
  const htmlContent = htmlParts.join('\n') || '<p></p>';

  // Calculate content hash
  const contentHash = crypto
    .createHash('sha256')
    .update(htmlContent)
    .digest('hex')
    .substring(0, 16);

  sections.push({
    sectionId,
    clearance,
    clearanceLevel: CLEARANCE_LEVELS[clearance],
    tagName: 'section',
    isInline: false,
    title: `${styleName} Section`,
    content: htmlContent,
    textLength: textContent.length,
    contentHash,
    attributes: {},
    sourceFormat: 'docx-style'
  });
}

/**
 * Extract text from a paragraph element
 * @param {Object} p - Paragraph XML object
 * @returns {string} Text content
 */
function extractParagraphText(p) {
  if (!p) return '';

  const textParts = [];

  // Handle runs (r elements)
  if (p.r) {
    const runs = Array.isArray(p.r) ? p.r : [p.r];
    for (const r of runs) {
      if (r.t) {
        const tElements = Array.isArray(r.t) ? r.t : [r.t];
        for (const t of tElements) {
          const text = typeof t === 'string' ? t : (t._ || t);
          if (text && typeof text === 'string') {
            textParts.push(text);
          }
        }
      }
    }
  }

  return textParts.join('');
}

/**
 * Extract metadata from DOCX core.xml
 * @param {JSZip} zip - Unzipped DOCX
 * @returns {Promise<Object>} Document metadata
 */
async function extractDocxMetadata(zip) {
  const metadata = {
    title: 'Untitled Document',
    documentType: 'classified-document',
    author: null,
    createdDate: null,
    department: null
  };

  try {
    // Try to read core.xml for document properties
    const coreXmlFile = zip.file('docProps/core.xml');
    if (coreXmlFile) {
      const coreXml = await coreXmlFile.async('string');
      const parser = new xml2js.Parser({
        explicitArray: false,
        tagNameProcessors: [xml2js.processors.stripPrefix]
      });
      const core = await parser.parseStringPromise(coreXml);

      if (core.coreProperties) {
        metadata.title = core.coreProperties.title || metadata.title;
        metadata.author = core.coreProperties.creator || null;
        metadata.createdDate = core.coreProperties.created || null;
      }
    }

    // Try to read custom.xml for department and other custom properties
    const customXmlFile = zip.file('docProps/custom.xml');
    if (customXmlFile) {
      const customXml = await customXmlFile.async('string');
      const parser = new xml2js.Parser({
        explicitArray: false,
        tagNameProcessors: [xml2js.processors.stripPrefix]
      });
      const custom = await parser.parseStringPromise(customXml);

      if (custom.Properties && custom.Properties.property) {
        const props = Array.isArray(custom.Properties.property)
          ? custom.Properties.property
          : [custom.Properties.property];

        for (const prop of props) {
          if (prop.$.name === 'Department') {
            metadata.department = prop.lpwstr || prop._ || null;
          }
        }
      }
    }
  } catch (error) {
    console.warn('Failed to extract DOCX metadata:', error.message);
  }

  return metadata;
}

/**
 * Extract a section from an SDT element
 * @param {Object} sdt - SDT object from parsed XML
 * @param {number} counter - Section counter
 * @param {Set} processedIds - Set of processed section IDs
 * @returns {Object|null} Section object or null if not a clearance SDT
 */
function extractSDTSection(sdt, counter, processedIds) {
  // Get SDT properties
  const sdtPr = sdt.sdtPr ? sdt.sdtPr[0] : null;
  if (!sdtPr) return null;

  // Look for tag with clearance value
  const tagElement = sdtPr.tag ? sdtPr.tag[0] : null;
  if (!tagElement) return null;

  const tagValue = tagElement.$ && tagElement.$['w:val'];
  if (!tagValue || !tagValue.startsWith('clearance:')) return null;

  // Extract clearance level
  const clearance = tagValue.split(':')[1].toUpperCase();
  if (!VALID_CLEARANCE_VALUES.includes(clearance)) {
    console.warn(`Invalid clearance level in DOCX: "${clearance}"`);
    return null;
  }

  // Get alias (used as section title)
  const aliasElement = sdtPr.alias ? sdtPr.alias[0] : null;
  const alias = aliasElement && aliasElement.$ ? aliasElement.$['w:val'] : null;

  // Generate section ID
  let sectionId = `sec-${String(counter + 1).padStart(3, '0')}`;
  while (processedIds.has(sectionId)) {
    sectionId = `sec-${String(++counter + 1).padStart(3, '0')}`;
  }
  processedIds.add(sectionId);

  // Extract text content from SDT content
  const sdtContent = sdt.sdtContent ? sdt.sdtContent[0] : null;
  const { textContent, htmlContent } = extractSDTTextContent(sdtContent);

  // Calculate content hash
  const contentHash = crypto
    .createHash('sha256')
    .update(htmlContent)
    .digest('hex')
    .substring(0, 16);

  return {
    sectionId,
    clearance,
    clearanceLevel: CLEARANCE_LEVELS[clearance],
    tagName: 'section',
    isInline: false,
    title: alias || `${clearance} Section`,
    content: htmlContent,
    textLength: textContent.length,
    contentHash,
    attributes: {},
    sourceFormat: 'docx-sdt'
  };
}

/**
 * Extract text and HTML content from SDT content element
 * @param {Object} sdtContent - SDT content object
 * @returns {Object} { textContent, htmlContent }
 */
function extractSDTTextContent(sdtContent) {
  if (!sdtContent) {
    return { textContent: '', htmlContent: '' };
  }

  const textParts = [];
  const htmlParts = [];

  function extractText(obj, isFirstParagraph = false) {
    if (!obj || typeof obj !== 'object') return;

    // Handle paragraph
    if (obj.p) {
      const paragraphs = Array.isArray(obj.p) ? obj.p : [obj.p];
      for (const p of paragraphs) {
        const pText = [];
        extractTextFromParagraph(p, pText);
        const paragraphText = pText.join('');
        if (paragraphText) {
          textParts.push(paragraphText);
          htmlParts.push(`<p>${escapeHtml(paragraphText)}</p>`);
        }
      }
    }

    // Recurse for other elements
    for (const key of Object.keys(obj)) {
      if (key !== 'p' && typeof obj[key] === 'object') {
        if (Array.isArray(obj[key])) {
          for (const item of obj[key]) {
            extractText(item);
          }
        } else {
          extractText(obj[key]);
        }
      }
    }
  }

  function extractTextFromParagraph(p, textParts) {
    if (!p) return;

    // Handle runs (r elements)
    if (p.r) {
      const runs = Array.isArray(p.r) ? p.r : [p.r];
      for (const r of runs) {
        if (r.t) {
          const tElements = Array.isArray(r.t) ? r.t : [r.t];
          for (const t of tElements) {
            const text = typeof t === 'string' ? t : (t._ || t);
            if (text) {
              textParts.push(text);
            }
          }
        }
      }
    }
  }

  extractText(sdtContent);

  return {
    textContent: textParts.join('\n'),
    htmlContent: htmlParts.join('\n') || '<p></p>'
  };
}

/**
 * Extract content not inside any SDT
 * @param {Object} doc - Parsed document XML
 * @param {Array} sections - Already extracted sections
 * @returns {Object|null} Unclassified content info
 */
async function extractUnmarkedContent(doc, sections) {
  // For now, return null - all content should be in SDTs
  // In a more complete implementation, we'd walk the document
  // and collect paragraphs not inside SDTs
  return null;
}

/**
 * Determine overall classification from sections
 * @param {Array} sections - Parsed sections
 * @returns {string} Overall classification
 */
function determineOverallClassification(sections) {
  if (sections.length === 0) {
    return 'UNCLASSIFIED';
  }

  let highestLevel = 1;
  for (const section of sections) {
    if (section.clearanceLevel > highestLevel) {
      highestLevel = section.clearanceLevel;
    }
  }

  return getClearanceName(highestLevel);
}

/**
 * Calculate clearance statistics
 * @param {Array} sections - Parsed sections
 * @returns {Object} Stats by clearance level
 */
function calculateClearanceStats(sections) {
  const stats = {
    UNCLASSIFIED: 0,
    CONFIDENTIAL: 0,
    SECRET: 0,
    TOP_SECRET: 0
  };

  for (const section of sections) {
    if (stats.hasOwnProperty(section.clearance)) {
      stats[section.clearance]++;
    }
  }

  return stats;
}

/**
 * Escape HTML special characters
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Validate a DOCX file for clearance markers
 * @param {Buffer} docxBuffer - DOCX file buffer
 * @returns {Promise<Object>} Validation result
 */
async function validateDocx(docxBuffer) {
  const errors = [];
  const warnings = [];

  try {
    const zip = new JSZip();
    await zip.loadAsync(docxBuffer);

    // Check for required files
    if (!zip.file('word/document.xml')) {
      errors.push('Invalid DOCX: Missing word/document.xml');
      return { valid: false, errors, warnings, elementCount: 0 };
    }

    // Parse and count SDTs
    const result = await parseDocxClearanceSections(docxBuffer);

    if (result.sections.length === 0) {
      warnings.push('No Content Controls with clearance tags found. Document will be treated as UNCLASSIFIED.');
    }

    // Check for sections without proper tags
    for (const section of result.sections) {
      if (!section.content || section.textLength === 0) {
        warnings.push(`Section "${section.title}" has no content`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      elementCount: result.sections.length,
      classification: result.metadata.overallClassification
    };

  } catch (error) {
    return {
      valid: false,
      errors: [`Failed to parse DOCX: ${error.message}`],
      warnings: [],
      elementCount: 0
    };
  }
}

/**
 * Check if a buffer is a valid DOCX file
 * @param {Buffer} buffer - File buffer
 * @returns {Promise<boolean>} True if valid DOCX
 */
async function isValidDocx(buffer) {
  try {
    const zip = new JSZip();
    await zip.loadAsync(buffer);
    return !!zip.file('word/document.xml');
  } catch {
    return false;
  }
}

module.exports = {
  parseDocxClearanceSections,
  validateDocx,
  isValidDocx,
  CLEARANCE_LEVELS,
  VALID_CLEARANCE_VALUES
};
