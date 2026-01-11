/**
 * DocxRedactionService.js
 *
 * Applies in-place redactions to DOCX files using STRING MANIPULATION
 * to preserve original formatting and whitespace perfectly.
 *
 * KEY APPROACH: We use xml2js to FIND which paragraphs need redaction,
 * then use regex/string manipulation on the ORIGINAL XML to replace
 * only those specific paragraphs. Non-redacted content is untouched.
 */

const JSZip = require('jszip');
const xml2js = require('xml2js');

// Clearance level hierarchy (standardized to CA Portal naming)
const CLEARANCE_LEVELS = {
  'INTERNAL': 1,
  'CONFIDENTIAL': 2,
  'RESTRICTED': 3,
  'TOP-SECRET': 4
};

// Style name to clearance mapping (matches DocxClearanceParser and template)
const STYLE_CLEARANCE_MAP = {
  // Paragraph styles
  'internal': 'INTERNAL',
  'confidential': 'CONFIDENTIAL',
  'restricted': 'RESTRICTED',
  'topsecret': 'TOP-SECRET',
  'top-secret': 'TOP-SECRET',
  // Character styles (inline)
  'confidentialinline': 'CONFIDENTIAL',
  'restrictedinline': 'RESTRICTED',
  'topsecretinline': 'TOP-SECRET'
};

class DocxRedactionService {
  /**
   * Apply redactions to a DOCX file based on user's clearance level
   * Uses STRING MANIPULATION to preserve whitespace perfectly.
   */
  static async applyRedactions(docxBuffer, userClearance, sectionMetadata = []) {
    const userLevel = typeof userClearance === 'string'
      ? CLEARANCE_LEVELS[userClearance.toUpperCase()] || 1
      : userClearance;

    console.log(`[DocxRedaction] Applying redactions for clearance level: ${userLevel}`);

    try {
      // 1. Load the DOCX as a ZIP archive
      const zip = await JSZip.loadAsync(docxBuffer);

      // 2. Get the ORIGINAL document.xml as a string (we'll modify this directly)
      let documentXml = await zip.file('word/document.xml').async('string');

      // 3. Load and parse styles.xml to find clearance style IDs
      const stylesXml = await zip.file('word/styles.xml')?.async('string');
      const { paragraphStyleIds, characterStyleIds } = await this.findClearanceStyleIds(stylesXml, userLevel);

      console.log(`[DocxRedaction] Paragraph styles to redact: ${[...paragraphStyleIds.keys()].join(', ')}`);
      console.log(`[DocxRedaction] Character styles to redact: ${[...characterStyleIds.keys()].join(', ')}`);

      // 4. Apply paragraph-level redactions using regex
      let redactionCount = 0;
      for (const [styleId, clearance] of paragraphStyleIds) {
        const result = this.redactParagraphsByStyle(documentXml, styleId, clearance);
        documentXml = result.xml;
        redactionCount += result.count;
      }

      // 5. Apply inline/character-level redactions using regex
      for (const [styleId, clearance] of characterStyleIds) {
        const result = this.redactRunsByStyle(documentXml, styleId, clearance);
        documentXml = result.xml;
        redactionCount += result.count;
      }

      console.log(`[DocxRedaction] Redacted ${redactionCount} sections`);

      // 6. Update document.xml in the ZIP
      zip.file('word/document.xml', documentXml);

      // 7. Return the modified DOCX as a buffer
      const modifiedDocx = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 }
      });

      console.log(`[DocxRedaction] Generated redacted DOCX: ${modifiedDocx.length} bytes`);
      return modifiedDocx;

    } catch (error) {
      console.error('[DocxRedaction] Error applying redactions:', error);
      throw error;
    }
  }

  /**
   * Find style IDs that should be redacted based on user's clearance level
   */
  static async findClearanceStyleIds(stylesXml, userLevel) {
    const paragraphStyleIds = new Map(); // styleId -> clearance name
    const characterStyleIds = new Map();

    if (!stylesXml) {
      return { paragraphStyleIds, characterStyleIds };
    }

    try {
      const parser = new xml2js.Parser({ explicitArray: true });
      const styles = await parser.parseStringPromise(stylesXml);

      const stylesRoot = styles['w:styles'];
      if (!stylesRoot || !stylesRoot['w:style']) {
        return { paragraphStyleIds, characterStyleIds };
      }

      for (const style of stylesRoot['w:style']) {
        const styleId = style.$?.['w:styleId'];
        const styleName = style['w:name']?.[0]?.$?.['w:val'];
        const styleType = style.$?.['w:type'];

        if (!styleId || !styleName) continue;

        const normalizedName = styleName.toLowerCase().replace(/\s+/g, '');
        const clearance = STYLE_CLEARANCE_MAP[normalizedName];

        if (clearance && CLEARANCE_LEVELS[clearance] > userLevel) {
          if (styleType === 'paragraph') {
            paragraphStyleIds.set(styleId, clearance);
          } else if (styleType === 'character') {
            characterStyleIds.set(styleId, clearance);
          }
        }
      }

      console.log(`[DocxRedaction] Found ${paragraphStyleIds.size} paragraph styles and ${characterStyleIds.size} character styles to redact`);
      return { paragraphStyleIds, characterStyleIds };

    } catch (error) {
      console.error('[DocxRedaction] Error parsing styles:', error);
      return { paragraphStyleIds, characterStyleIds };
    }
  }

  /**
   * Redact paragraphs with a specific style using regex
   * This preserves whitespace in non-redacted content perfectly
   */
  static redactParagraphsByStyle(xml, styleId, clearance) {
    let count = 0;

    // Find paragraphs that have this style
    // Pattern: <w:p ...>...<w:pStyle w:val="styleId"/>...</w:p>
    const paragraphRegex = new RegExp(
      `(<w:p[^>]*>)(.*?)(<\\/w:p>)`,
      'gs'
    );

    const stylePattern = new RegExp(
      `<w:pStyle[^>]*w:val=["']${this.escapeRegex(styleId)}["'][^>]*\\/>`,
      'i'
    );

    const redactedXml = xml.replace(paragraphRegex, (match, openTag, content, closeTag) => {
      // Check if this paragraph has the style we're looking for
      if (stylePattern.test(content)) {
        count++;
        // Replace the entire paragraph content with redaction
        return this.createRedactedParagraphXml(styleId, clearance);
      }
      return match; // Keep original
    });

    return { xml: redactedXml, count };
  }

  /**
   * Redact runs (inline text) with a specific character style using regex
   */
  static redactRunsByStyle(xml, styleId, clearance) {
    let count = 0;

    // Find runs that have this character style
    // Pattern: <w:r ...>...<w:rStyle w:val="styleId"/>...</w:r>
    const runRegex = new RegExp(
      `<w:r>([\\s\\S]*?)<\\/w:r>|<w:r (?:[^>]*)>([\\s\\S]*?)<\\/w:r>`,
      'g'
    );

    const stylePattern = new RegExp(
      `<w:rStyle[^>]*w:val=["']${this.escapeRegex(styleId)}["'][^>]*\\/>`,
      'i'
    );

    // Track if we're in a redacted sequence to consolidate consecutive redactions
    let lastWasRedacted = false;
    let redactedXml = xml.replace(runRegex, (match, content1, content2) => {
      const content = content1 || content2;

      if (stylePattern.test(match)) {
        count++;
        if (lastWasRedacted) {
          // Skip consecutive redacted runs (already have placeholder)
          return '';
        }
        lastWasRedacted = true;
        return this.createRedactedRunXml(clearance);
      }

      lastWasRedacted = false;
      return match; // Keep original
    });

    return { xml: redactedXml, count };
  }

  /**
   * Create redacted paragraph XML with styling
   */
  static createRedactedParagraphXml(styleId, clearance) {
    const text = `[REDACTED - REQUIRES ${clearance} CLEARANCE]`;
    return `<w:p><w:pPr><w:pStyle w:val="${styleId}"/><w:shd w:val="clear" w:color="auto" w:fill="000000"/><w:pBdr><w:top w:val="single" w:sz="12" w:space="1" w:color="FF0000"/><w:bottom w:val="single" w:sz="12" w:space="1" w:color="FF0000"/><w:left w:val="single" w:sz="12" w:space="4" w:color="FF0000"/><w:right w:val="single" w:sz="12" w:space="4" w:color="FF0000"/></w:pBdr></w:pPr><w:r><w:rPr><w:b/><w:color w:val="FFFFFF"/><w:highlight w:val="black"/><w:smallCaps/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  }

  /**
   * Create redacted run XML with styling
   */
  static createRedactedRunXml(clearance) {
    return `<w:r><w:rPr><w:b/><w:color w:val="FFFFFF"/><w:highlight w:val="black"/><w:smallCaps/></w:rPr><w:t xml:space="preserve"> [REDACTED] </w:t></w:r>`;
  }

  /**
   * Escape special regex characters in a string
   */
  static escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Get clearance level name from numeric value
   */
  static getClearanceName(level) {
    for (const [name, lvl] of Object.entries(CLEARANCE_LEVELS)) {
      if (lvl === level) return name;
    }
    return 'UNKNOWN';
  }

  /**
   * Get numeric clearance level from string
   */
  static getClearanceLevel(name) {
    return CLEARANCE_LEVELS[name?.toUpperCase()] || 1;
  }
}

module.exports = DocxRedactionService;
