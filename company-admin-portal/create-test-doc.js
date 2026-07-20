#!/usr/bin/env node
'use strict';

/**
 * create-test-doc.js
 * Generates a multi-section DOCX with content at four classification levels.
 * Each section is marked with its clearance level so the redaction service
 * can be verified against the output.
 */

const path = require('path');
const fs   = require('fs');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, ShadingType
} = require('./node_modules/docx');

const OUT = path.join(__dirname, '..', 'docs', 'test_doc.docx');

// ── Helpers ───────────────────────────────────────────────────────────────────

function levelColor(level) {
  return { INTERNAL: '1F497D', CONFIDENTIAL: '375623', RESTRICTED: '7F3F00', 'TOP-SECRET': '7B0000' }[level] || '000000';
}

function banner(level) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    shading: { type: ShadingType.SOLID, color: levelColor(level) },
    children: [new TextRun({ text: `[${level}]`, bold: true, color: 'FFFFFF', size: 20 })]
  });
}

function heading(text, level = HeadingLevel.HEADING_1) {
  return new Paragraph({ heading: level, children: [new TextRun({ text, bold: true })] });
}

function body(text) {
  return new Paragraph({ children: [new TextRun({ text })] });
}

function spacer() {
  return new Paragraph({ children: [new TextRun({ text: '' })] });
}

// ── Document ──────────────────────────────────────────────────────────────────

const doc = new Document({
  creator:     'identuslabel-test',
  title:       'Multi-Level Security Test Document',
  description: 'Generated test document for SSI document access control pipeline',
  sections: [{
    children: [

      // Cover
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: 'IDENTUSLABEL SECURITY SYSTEMS', bold: true, size: 36 })]
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: 'Multi-Level Security Test Document', size: 28 })]
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: 'Version 1.0  |  April 2026  |  ACME Corp', size: 20, italics: true })]
      }),
      spacer(),

      // ── INTERNAL ──────────────────────────────────────────────────────────
      banner('INTERNAL'),
      heading('1. Company Overview  [INTERNAL]'),
      body(
        'ACME Corporation was founded in 2010 and operates across 14 countries. ' +
        'The company employs approximately 3,400 staff globally and maintains regional ' +
        'offices in Prague, Vienna, Warsaw and Bratislava. Annual revenue for fiscal year ' +
        '2025 was €420 million, a 12% increase year-over-year.'
      ),
      spacer(),
      body(
        'The primary business units are: Industrial Automation, Digital Services, ' +
        'and Supply Chain Solutions. Each business unit operates with dedicated P&L ' +
        'responsibility and reports to the Group Executive Committee on a quarterly basis.'
      ),
      spacer(),
      heading('1.1 Organisational Structure  [INTERNAL]', HeadingLevel.HEADING_2),
      body(
        'The Group CEO is supported by a C-suite of seven executives. The Board of Directors ' +
        'convenes six times per year. Employee representation is guaranteed through the Works ' +
        'Council established under Czech Labour Code §276.'
      ),
      spacer(),

      // ── CONFIDENTIAL ──────────────────────────────────────────────────────
      banner('CONFIDENTIAL'),
      heading('2. Financial Performance  [CONFIDENTIAL]'),
      body(
        'EBITDA for Q1 2026 was €38.2 million against a budget of €35.0 million (+9.1%). ' +
        'The Digital Services unit underperformed by €2.1 million due to delayed contract ' +
        'renewals in the public sector vertical. Corrective measures include a pricing ' +
        'revision effective 1 May 2026 and two pipeline deals totalling €6.4 million ' +
        'expected to close in Q2.'
      ),
      spacer(),
      body(
        'Net debt position as of 31 March 2026: €112 million (2.9× EBITDA leverage). ' +
        'The revolving credit facility of €80 million remains undrawn. Covenant ' +
        'compliance is confirmed; next measurement date is 30 June 2026.'
      ),
      spacer(),
      heading('2.1 Budget Variances  [CONFIDENTIAL]', HeadingLevel.HEADING_2),
      body(
        'Capex spend YTD: €8.7 million vs. plan of €10.2 million. The underspend ' +
        'relates to a 6-week delay in the Prague data centre fit-out. Project completion ' +
        'is now forecast for 15 June 2026. No material impact on EBITDA is expected.'
      ),
      spacer(),

      // ── RESTRICTED ────────────────────────────────────────────────────────
      banner('RESTRICTED'),
      heading('3. Merger & Acquisition Pipeline  [RESTRICTED]'),
      body(
        'Project FALCON (code name): Evaluation of a controlling stake (55-70%) in ' +
        'TechDynamics s.r.o., a Prague-based industrial IoT platform with ARR of €9 million. ' +
        'Indicative valuation range: €45-55 million EV. Exclusivity period expires 30 April 2026. ' +
        'Legal DD is 80% complete; financial DD to close by 18 April. Decision gate scheduled ' +
        'for 25 April ExCo meeting.'
      ),
      spacer(),
      body(
        'Project EAGLE (code name): Disposal of the non-core logistics subsidiary ' +
        'ACME-LOG a.s. Two binding bids received: Bidder A at €31 million, Bidder B at €28 million. ' +
        'Board approval sought at the 10 May extraordinary session. Anticipated closing Q3 2026.'
      ),
      spacer(),
      heading('3.1 Integration Risk Register  [RESTRICTED]', HeadingLevel.HEADING_2),
      body(
        'Key risks: (1) Key-person dependency — 3 of TechDynamics founders hold critical ' +
        'IP knowledge; retention bonuses of €200k per person proposed over 24 months. ' +
        '(2) Regulatory — Czech UOHS merger notification required; filing prepared. ' +
        '(3) IT integration — estimated 9-month programme, €1.2 million budget.'
      ),
      spacer(),

      // ── TOP-SECRET ────────────────────────────────────────────────────────
      banner('TOP-SECRET'),
      heading('4. Strategic Intelligence Assessment  [TOP-SECRET]'),
      body(
        'Competitive intelligence (classified): ' +
        'Competitor BETA GmbH is actively pursuing the same TechDynamics target. ' +
        "Beta's CFO met TechDynamics management on 28 March 2026 in Vienna. " +
        "Beta's indicative offer is believed to be in the €48-52 million range. " +
        'ACME must move decisively to protect exclusivity.'
      ),
      spacer(),
      body(
        'Government relations (classified): Ministry of Industry contact has confirmed ' +
        'informal preference for Czech-domiciled ownership of TechDynamics given its ' +
        'involvement in critical infrastructure sensor networks under Act No. 181/2014 Coll. ' +
        "This creates a regulatory moat that favours ACME's acquisition over foreign bidders."
      ),
      spacer(),
      heading('4.1 Counterintelligence Protocol  [TOP-SECRET]', HeadingLevel.HEADING_2),
      body(
        'All communications regarding Project FALCON must use end-to-end encrypted channels. ' +
        'No references to TechDynamics or Project FALCON may appear in email. ' +
        'This document is stored exclusively via the Identus SSI document access control system ' +
        'and accessed only by personnel with TOP-SECRET clearance. ' +
        'Printed copies are prohibited.'
      ),
      spacer(),

      // Footer
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({
          text: 'This document contains information at four classification levels. ' +
                'Access is governed by the Identus SSI Document Access Control System.',
          italics: true, size: 16, color: '666666'
        })]
      }),
    ]
  }]
});

// ── Write ─────────────────────────────────────────────────────────────────────
Packer.toBuffer(doc).then(buf => {
  // docs/ is owned by root — write to company-admin-portal instead
  const outPath = path.join(__dirname, 'test_doc.docx');
  fs.writeFileSync(outPath, buf);
  console.log(`Written: ${outPath} (${(buf.length / 1024).toFixed(1)} KB)`);
  console.log('Sections: INTERNAL | CONFIDENTIAL | RESTRICTED | TOP-SECRET');
}).catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
