/**
 * DocxMergeService.js
 *
 * Merges a user's edited DOCX with the original, restoring restricted paragraphs.
 * Security invariant: paragraphs styled with clearance > user's level are ALWAYS
 * replaced with original content, regardless of what the user submitted.
 */

const JSZip = require('jszip');
const DocxRedactionService = require('./DocxRedactionService');

class DocxMergeService {
  /**
   * Merge user's edited DOCX with original, restoring hidden paragraphs.
   * @param {Buffer} originalDocxBuffer  - original from Iagon (all sections)
   * @param {Buffer} userDocxBuffer      - user's edited upload
   * @param {string} userClearanceLevel  - e.g. 'CONFIDENTIAL'
   * @returns {Promise<Buffer>}          - merged DOCX buffer
   */
  static async mergeDocx(originalDocxBuffer, userDocxBuffer, userClearanceLevel) {
    const userLevel = DocxRedactionService.getClearanceLevel(userClearanceLevel);

    const originalZip = await JSZip.loadAsync(originalDocxBuffer);
    const userZip     = await JSZip.loadAsync(userDocxBuffer);

    // 1. Get restricted style IDs (styles whose clearance > user's level)
    const stylesXml = await originalZip.file('word/styles.xml').async('string');
    const { paragraphStyleIds } = await DocxRedactionService.findClearanceStyleIds(
      stylesXml, userLevel
    );
    // paragraphStyleIds: Map<styleId, clearanceName>  e.g. { 'Confidential' -> 'CONFIDENTIAL' }

    // 2. Extract document XML from both
    const originalXml = await originalZip.file('word/document.xml').async('string');
    const userXml     = await userZip.file('word/document.xml').async('string');

    // 3. Extract paragraphs as an array of XML strings
    const originalParagraphs = this.extractParagraphBlocks(originalXml);
    const userParagraphs     = this.extractParagraphBlocks(userXml);

    // 4. Build restricted-paragraph collections:
    //    - From user's doc: indices of paragraphs that have a restricted style
    //    - From original:   the corresponding XML blocks in order
    const restrictedIndicesInUser = [];
    for (let i = 0; i < userParagraphs.length; i++) {
      if (this.hasRestrictedStyle(userParagraphs[i], paragraphStyleIds)) {
        restrictedIndicesInUser.push(i);
      }
    }

    const restrictedBlocksInOriginal = originalParagraphs.filter(p =>
      this.hasRestrictedStyle(p, paragraphStyleIds)
    );

    // 5. Validate counts match (same document structure)
    if (restrictedIndicesInUser.length !== restrictedBlocksInOriginal.length) {
      throw new Error(
        `MergeError: Document structure mismatch — ` +
        `${restrictedIndicesInUser.length} restricted paragraphs in upload vs ` +
        `${restrictedBlocksInOriginal.length} in original. ` +
        `Do not add or remove paragraphs near redacted sections.`
      );
    }

    // 6. Build merged paragraph array: swap restricted paragraphs
    const merged = [...userParagraphs];
    restrictedIndicesInUser.forEach((userIdx, n) => {
      merged[userIdx] = restrictedBlocksInOriginal[n];
    });

    // 7. Rebuild document XML by replacing all paragraphs in the original structure
    const mergedDocXml = this.rebuildDocumentXml(userXml, merged);

    // 8. Start from original ZIP (preserves styles, media, etc.)
    //    only replace document.xml
    const mergedZip = await JSZip.loadAsync(originalDocxBuffer);
    mergedZip.file('word/document.xml', mergedDocXml);

    return await mergedZip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    });
  }

  /** Extract <w:p>...</w:p> blocks from document XML as an array of strings */
  static extractParagraphBlocks(xml) {
    const blocks = [];
    const regex = /<w:p[ >][\s\S]*?<\/w:p>/g;
    let match;
    while ((match = regex.exec(xml)) !== null) {
      blocks.push(match[0]);
    }
    return blocks;
  }

  /** Check if a paragraph XML block uses any of the restricted style IDs */
  static hasRestrictedStyle(paragraphXml, paragraphStyleIds) {
    for (const styleId of paragraphStyleIds.keys()) {
      const pattern = new RegExp(
        `<w:pStyle[^>]*w:val=["']${DocxRedactionService.escapeRegex(styleId)}["']`,
        'i'
      );
      if (pattern.test(paragraphXml)) return true;
    }
    return false;
  }

  /** Replace all <w:p> blocks in the XML structure with the merged array */
  static rebuildDocumentXml(baseXml, mergedParagraphs) {
    let i = 0;
    return baseXml.replace(/<w:p[ >][\s\S]*?<\/w:p>/g, () => {
      return i < mergedParagraphs.length ? mergedParagraphs[i++] : '';
    });
  }
}

module.exports = DocxMergeService;
