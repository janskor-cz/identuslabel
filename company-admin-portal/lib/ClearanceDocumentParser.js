/**
 * ClearanceDocumentParser.js
 *
 * Parses HTML documents with clearance-level markers on any element.
 * Supports data-clearance attributes on sections, paragraphs, spans, tables, etc.
 *
 * Clearance Hierarchy (Standardized to CA Portal names):
 * - INTERNAL (1) - Basic organizational access
 * - CONFIDENTIAL (2) - Sensitive business information
 * - RESTRICTED (3) - Highly sensitive strategic information
 * - TOP-SECRET (4) - Classified information (highest)
 */

const { JSDOM } = require('jsdom');
const crypto = require('crypto');

// Clearance level hierarchy (standardized to CA Portal naming)
const CLEARANCE_LEVELS = {
  'INTERNAL': 1,
  'CONFIDENTIAL': 2,
  'RESTRICTED': 3,
  'TOP-SECRET': 4
};

const VALID_CLEARANCE_VALUES = Object.keys(CLEARANCE_LEVELS);

/**
 * Parse an HTML document and extract all elements with clearance markers
 * @param {string} htmlString - The HTML document content
 * @returns {Object} Parsed document with metadata and sections
 */
function parseClearanceSections(htmlString) {
  const dom = new JSDOM(htmlString);
  const document = dom.window.document;

  // Extract document metadata from <meta> tags
  const metadata = extractMetadata(document);

  // Find all elements with data-clearance attribute
  const classifiedElements = document.querySelectorAll('[data-clearance]');
  const sections = [];

  // Track element IDs to avoid duplicates
  const processedIds = new Set();
  let sectionCounter = 0;

  classifiedElements.forEach((element) => {
    const clearance = element.getAttribute('data-clearance').toUpperCase();

    // Validate clearance level
    if (!VALID_CLEARANCE_VALUES.includes(clearance)) {
      console.warn(`Invalid clearance level "${clearance}" on element, skipping`);
      return;
    }

    // Generate unique section ID
    let sectionId = element.id || `sec-${String(++sectionCounter).padStart(3, '0')}`;
    while (processedIds.has(sectionId)) {
      sectionId = `sec-${String(++sectionCounter).padStart(3, '0')}`;
    }
    processedIds.add(sectionId);

    // Determine element type (block or inline)
    const tagName = element.tagName.toLowerCase();
    const isInline = ['span', 'a', 'strong', 'em', 'b', 'i', 'code', 'mark'].includes(tagName);

    // Extract title from first heading or use generic
    const headingElement = element.querySelector('h1, h2, h3, h4, h5, h6');
    const title = headingElement ? headingElement.textContent.trim() :
                  (element.getAttribute('data-title') || `${clearance} Section`);

    // Get the content
    const content = element.innerHTML;
    const textContent = element.textContent.trim();

    // Calculate content hash for integrity verification
    const contentHash = crypto
      .createHash('sha256')
      .update(content)
      .digest('hex')
      .substring(0, 16);

    sections.push({
      sectionId,
      clearance,
      clearanceLevel: CLEARANCE_LEVELS[clearance],
      tagName,
      isInline,
      title,
      content,
      textLength: textContent.length,
      contentHash,
      // Store original attributes for reconstruction
      attributes: getElementAttributes(element)
    });
  });

  // Extract content outside classified sections (treated as UNCLASSIFIED)
  const unclassifiedContent = extractUnclassifiedContent(document, classifiedElements);
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
      attributes: {}
    });
  }

  // Determine overall document classification (LOWEST clearance level present)
  const overallClassification = determineOverallClassification(sections);

  // Update metadata with calculated values
  metadata.overallClassification = overallClassification;
  metadata.sectionCount = sections.length;
  metadata.clearanceLevelStats = calculateClearanceStats(sections);

  return {
    metadata,
    sections,
    originalHtml: htmlString,
    parsedAt: new Date().toISOString()
  };
}

/**
 * Extract document metadata from HTML <meta> tags
 * @param {Document} document - DOM document
 * @returns {Object} Metadata object
 */
function extractMetadata(document) {
  const getMetaContent = (name) => {
    const meta = document.querySelector(`meta[name="${name}"]`);
    return meta ? meta.getAttribute('content') : null;
  };

  // Get title from <title> tag or meta tag
  const titleElement = document.querySelector('title');
  const title = getMetaContent('document-title') ||
                (titleElement ? titleElement.textContent.trim() : 'Untitled Document');

  return {
    title,
    documentType: getMetaContent('document-type') || 'classified-document',
    author: getMetaContent('author') || null,
    createdDate: getMetaContent('created-date') || null,
    department: getMetaContent('department') || null,
    // Will be calculated after parsing sections
    overallClassification: null,
    sectionCount: 0,
    clearanceLevelStats: {}
  };
}

/**
 * Extract all attributes from an element (except data-clearance which is handled separately)
 * @param {Element} element - DOM element
 * @returns {Object} Attributes object
 */
function getElementAttributes(element) {
  const attrs = {};
  for (const attr of element.attributes) {
    if (attr.name !== 'data-clearance') {
      attrs[attr.name] = attr.value;
    }
  }
  return attrs;
}

/**
 * Extract content that is not inside any classified section
 * @param {Document} document - DOM document
 * @param {NodeList} classifiedElements - Elements with data-clearance
 * @returns {Object|null} Unclassified content info
 */
function extractUnclassifiedContent(document, classifiedElements) {
  // Clone the body to work with
  const body = document.body;
  if (!body) return null;

  const bodyClone = body.cloneNode(true);

  // Remove all classified elements from the clone
  const classifiedInClone = bodyClone.querySelectorAll('[data-clearance]');
  classifiedInClone.forEach(el => {
    // Replace with placeholder to maintain document structure
    const placeholder = document.createTextNode('');
    el.parentNode.replaceChild(placeholder, el);
  });

  // Get remaining content
  const content = bodyClone.innerHTML.trim();
  const textContent = bodyClone.textContent.trim();

  // Only return if there's meaningful content
  if (textContent.length < 10) {
    return null;
  }

  return {
    content,
    textLength: textContent.length
  };
}

/**
 * Determine overall document classification (LOWEST clearance level = most restrictive document)
 * A document containing SECRET content is classified SECRET overall
 * @param {Array} sections - Parsed sections
 * @returns {string} Overall classification
 */
function determineOverallClassification(sections) {
  if (sections.length === 0) {
    return 'UNCLASSIFIED';
  }

  // Find the LOWEST clearance level (least restrictive)
  // This determines who can access the document (with redactions for higher sections)
  let lowestLevel = 4; // Start with TOP_SECRET

  for (const section of sections) {
    if (section.clearanceLevel < lowestLevel) {
      lowestLevel = section.clearanceLevel;
    }
  }

  // Convert level back to string
  for (const [name, level] of Object.entries(CLEARANCE_LEVELS)) {
    if (level === lowestLevel) {
      return name;
    }
  }

  return 'UNCLASSIFIED';
}

/**
 * Calculate statistics about clearance levels in the document
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
 * Validate clearance markers in a document
 * @param {string} htmlString - HTML document content
 * @returns {Object} Validation result
 */
function validateDocument(htmlString) {
  const errors = [];
  const warnings = [];

  try {
    const dom = new JSDOM(htmlString);
    const document = dom.window.document;

    // Check for classified elements
    const classifiedElements = document.querySelectorAll('[data-clearance]');

    if (classifiedElements.length === 0) {
      warnings.push('No elements with data-clearance attribute found. Entire document will be treated as UNCLASSIFIED.');
    }

    // Validate each classified element
    classifiedElements.forEach((element, index) => {
      const clearance = element.getAttribute('data-clearance');
      const tagName = element.tagName.toLowerCase();

      // Check clearance value
      if (!clearance) {
        errors.push(`Element ${index + 1} (${tagName}): data-clearance attribute is empty`);
      } else if (!VALID_CLEARANCE_VALUES.includes(clearance.toUpperCase())) {
        errors.push(`Element ${index + 1} (${tagName}): Invalid clearance level "${clearance}". Valid values: ${VALID_CLEARANCE_VALUES.join(', ')}`);
      }

      // Check for nested classified elements (warning, not error)
      const nestedClassified = element.querySelectorAll('[data-clearance]');
      if (nestedClassified.length > 0) {
        warnings.push(`Element ${index + 1} (${tagName}): Contains nested classified elements. Each will be processed independently.`);
      }

      // Check for empty content
      if (!element.textContent.trim()) {
        warnings.push(`Element ${index + 1} (${tagName}): Classified element has no text content`);
      }
    });

    // Check document structure
    if (!document.body) {
      errors.push('Document is missing <body> element');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      elementCount: classifiedElements.length
    };

  } catch (error) {
    return {
      valid: false,
      errors: [`Failed to parse HTML: ${error.message}`],
      warnings: [],
      elementCount: 0
    };
  }
}

/**
 * Reconstruct an HTML document from parsed sections (for preview/debugging)
 * @param {Object} parsedDoc - Parsed document from parseClearanceSections
 * @returns {string} Reconstructed HTML
 */
function reconstructDocument(parsedDoc) {
  const sections = parsedDoc.sections;

  let bodyContent = '';

  for (const section of sections) {
    const attrs = Object.entries(section.attributes || {})
      .map(([key, value]) => `${key}="${value}"`)
      .join(' ');

    const attrStr = attrs ? ` ${attrs}` : '';

    bodyContent += `<${section.tagName} data-clearance="${section.clearance}"${attrStr}>\n`;
    bodyContent += section.content;
    bodyContent += `\n</${section.tagName}>\n\n`;
  }

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="document-type" content="${parsedDoc.metadata.documentType}">
  <meta name="document-title" content="${parsedDoc.metadata.title}">
  <title>${parsedDoc.metadata.title}</title>
</head>
<body>
${bodyContent}
</body>
</html>`;
}

/**
 * Get sections filtered by clearance level
 * @param {Object} parsedDoc - Parsed document
 * @param {number} userClearanceLevel - User's clearance level (1-4)
 * @returns {Object} Document with filtered sections and redaction info
 */
function filterSectionsByClearance(parsedDoc, userClearanceLevel) {
  const visibleSections = [];
  const redactedSections = [];

  for (const section of parsedDoc.sections) {
    if (section.clearanceLevel <= userClearanceLevel) {
      visibleSections.push(section);
    } else {
      redactedSections.push({
        sectionId: section.sectionId,
        clearance: section.clearance,
        clearanceLevel: section.clearanceLevel,
        tagName: section.tagName,
        isInline: section.isInline,
        title: section.title
      });
    }
  }

  return {
    metadata: parsedDoc.metadata,
    visibleSections,
    redactedSections,
    userClearanceLevel,
    accessibleClassification: getClearanceName(userClearanceLevel)
  };
}

/**
 * Get clearance level name from numeric level
 * @param {number} level - Numeric clearance level
 * @returns {string} Clearance name
 */
function getClearanceName(level) {
  for (const [name, lvl] of Object.entries(CLEARANCE_LEVELS)) {
    if (lvl === level) {
      return name;
    }
  }
  return 'UNKNOWN';
}

module.exports = {
  parseClearanceSections,
  validateDocument,
  reconstructDocument,
  filterSectionsByClearance,
  determineOverallClassification,
  CLEARANCE_LEVELS,
  VALID_CLEARANCE_VALUES,
  getClearanceName
};
