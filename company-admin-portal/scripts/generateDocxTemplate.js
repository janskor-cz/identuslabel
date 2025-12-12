/**
 * generateDocxTemplate.js
 *
 * Generates a Microsoft Word template with PARAGRAPH STYLES for clearance marking.
 * This is the USER-FRIENDLY approach - users simply select text and apply a style
 * from Word's Style dropdown (Home tab).
 *
 * Styles created:
 * - Unclassified (green) - Public information
 * - Confidential (blue) - Sensitive business info
 * - Secret (orange) - Highly restricted
 * - TopSecret (red) - Maximum classification
 *
 * Run: node scripts/generateDocxTemplate.js
 */

const {
  Document,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  BorderStyle,
  ShadingType,
  Packer
} = require('docx');
const fs = require('fs');
const path = require('path');

// Clearance level visual styles
const CLEARANCE_STYLES = {
  Unclassified: {
    id: 'Unclassified',
    name: 'Unclassified',
    color: '1B5E20', // Dark green text
    bgColor: 'E8F5E9', // Light green background
    borderColor: '4CAF50', // Green border
    description: 'Public information accessible to all'
  },
  Confidential: {
    id: 'Confidential',
    name: 'Confidential',
    color: '0D47A1', // Dark blue text
    bgColor: 'E3F2FD', // Light blue background
    borderColor: '2196F3', // Blue border
    description: 'Sensitive business information'
  },
  Secret: {
    id: 'Secret',
    name: 'Secret',
    color: 'E65100', // Dark orange text
    bgColor: 'FFF3E0', // Light orange background
    borderColor: 'FF9800', // Orange border
    description: 'Highly restricted information'
  },
  TopSecret: {
    id: 'TopSecret',
    name: 'TopSecret',
    color: 'B71C1C', // Dark red text
    bgColor: 'FFEBEE', // Light red background
    borderColor: 'F44336', // Red border
    description: 'Classified information (highest level)'
  }
};

/**
 * Build paragraph style definitions for Word
 */
function buildParagraphStyles() {
  const styles = [];

  for (const [key, style] of Object.entries(CLEARANCE_STYLES)) {
    styles.push({
      id: style.id,
      name: style.name,
      basedOn: 'Normal',
      next: 'Normal',
      quickFormat: true,
      run: {
        color: style.color,
        size: 24
      },
      paragraph: {
        shading: {
          type: ShadingType.SOLID,
          color: style.bgColor
        },
        spacing: {
          before: 120,
          after: 120,
          line: 276
        },
        border: {
          left: {
            color: style.borderColor,
            style: BorderStyle.SINGLE,
            size: 24,
            space: 4
          }
        }
      }
    });
  }

  return styles;
}

/**
 * Create instructions section
 */
function createInstructions() {
  return [
    // Title
    new Paragraph({
      children: [
        new TextRun({
          text: 'CLASSIFIED DOCUMENT TEMPLATE',
          bold: true,
          size: 40,
          color: '333333'
        })
      ],
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 }
    }),

    // How to use
    new Paragraph({
      children: [
        new TextRun({
          text: 'How to Use This Template (EASY!)',
          bold: true,
          size: 32,
          color: '1565C0'
        })
      ],
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 200, after: 200 }
    }),

    new Paragraph({
      children: [
        new TextRun({
          text: 'This template uses ',
          size: 24
        }),
        new TextRun({
          text: 'Paragraph Styles',
          bold: true,
          size: 24
        }),
        new TextRun({
          text: ' - the easiest way to mark classified content. Just 3 steps:',
          size: 24
        })
      ],
      spacing: { after: 200 }
    }),

    // Step 1
    new Paragraph({
      children: [
        new TextRun({
          text: 'Step 1: ',
          bold: true,
          size: 24,
          color: '1565C0'
        }),
        new TextRun({
          text: 'Write your document content (or paste it here)',
          size: 24
        })
      ],
      spacing: { after: 100 }
    }),

    // Step 2
    new Paragraph({
      children: [
        new TextRun({
          text: 'Step 2: ',
          bold: true,
          size: 24,
          color: '1565C0'
        }),
        new TextRun({
          text: 'Select the paragraph(s) you want to classify',
          size: 24
        })
      ],
      spacing: { after: 100 }
    }),

    // Step 3
    new Paragraph({
      children: [
        new TextRun({
          text: 'Step 3: ',
          bold: true,
          size: 24,
          color: '1565C0'
        }),
        new TextRun({
          text: 'From the ',
          size: 24
        }),
        new TextRun({
          text: 'Styles gallery (Home tab)',
          bold: true,
          size: 24
        }),
        new TextRun({
          text: ', click one of these styles:',
          size: 24
        })
      ],
      spacing: { after: 150 }
    }),

    // Style list
    new Paragraph({
      children: [
        new TextRun({
          text: '    \u2022 Unclassified',
          bold: true,
          color: CLEARANCE_STYLES.Unclassified.borderColor,
          size: 24
        }),
        new TextRun({
          text: ' - Public information',
          size: 24
        })
      ],
      spacing: { after: 50 }
    }),

    new Paragraph({
      children: [
        new TextRun({
          text: '    \u2022 Confidential',
          bold: true,
          color: CLEARANCE_STYLES.Confidential.borderColor,
          size: 24
        }),
        new TextRun({
          text: ' - Sensitive business info',
          size: 24
        })
      ],
      spacing: { after: 50 }
    }),

    new Paragraph({
      children: [
        new TextRun({
          text: '    \u2022 Secret',
          bold: true,
          color: CLEARANCE_STYLES.Secret.borderColor,
          size: 24
        }),
        new TextRun({
          text: ' - Highly restricted',
          size: 24
        })
      ],
      spacing: { after: 50 }
    }),

    new Paragraph({
      children: [
        new TextRun({
          text: '    \u2022 TopSecret',
          bold: true,
          color: CLEARANCE_STYLES.TopSecret.borderColor,
          size: 24
        }),
        new TextRun({
          text: ' - Maximum classification',
          size: 24
        })
      ],
      spacing: { after: 200 }
    }),

    // Tip
    new Paragraph({
      children: [
        new TextRun({
          text: 'TIP: ',
          bold: true,
          size: 22,
          color: '666666'
        }),
        new TextRun({
          text: 'If you don\'t see the styles in the gallery, click the small arrow at the bottom-right of the Styles section to expand the full list.',
          size: 22,
          italics: true,
          color: '666666'
        })
      ],
      spacing: { after: 300 }
    }),

    // Separator
    new Paragraph({
      children: [
        new TextRun({
          text: '\u2500'.repeat(70),
          color: 'CCCCCC'
        })
      ],
      alignment: AlignmentType.CENTER,
      spacing: { before: 200, after: 200 }
    }),

    // Delete notice
    new Paragraph({
      children: [
        new TextRun({
          text: '\u26A0 DELETE THESE INSTRUCTIONS BEFORE UPLOADING \u26A0',
          bold: true,
          color: 'CC0000',
          size: 26
        })
      ],
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 }
    }),

    // Separator
    new Paragraph({
      children: [
        new TextRun({
          text: '\u2500'.repeat(70),
          color: 'CCCCCC'
        })
      ],
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 }
    })
  ];
}

/**
 * Create example document with styled paragraphs
 */
function createExampleContent() {
  return [
    // Document title
    new Paragraph({
      children: [
        new TextRun({
          text: 'Q4 Financial Report - TechCorp',
          bold: true,
          size: 48,
          color: '333333'
        })
      ],
      heading: HeadingLevel.TITLE,
      spacing: { after: 400 }
    }),

    // Unclassified section header
    new Paragraph({
      children: [
        new TextRun({
          text: 'Public Metrics',
          bold: true,
          size: 28
        })
      ],
      style: 'Unclassified'
    }),

    new Paragraph({
      children: [
        new TextRun({
          text: 'This is public information that anyone can view.',
          size: 24
        })
      ],
      style: 'Unclassified'
    }),

    new Paragraph({
      children: [
        new TextRun({
          text: 'Total projects completed: 45 | Customer satisfaction: 92% | Employees: 250',
          size: 24
        })
      ],
      style: 'Unclassified'
    }),

    // Normal paragraph (space between sections)
    new Paragraph({
      text: '',
      spacing: { after: 200 }
    }),

    // Confidential section
    new Paragraph({
      children: [
        new TextRun({
          text: 'Financial Performance',
          bold: true,
          size: 28
        })
      ],
      style: 'Confidential'
    }),

    new Paragraph({
      children: [
        new TextRun({
          text: 'This requires CONFIDENTIAL clearance or higher to view.',
          size: 24
        })
      ],
      style: 'Confidential'
    }),

    new Paragraph({
      children: [
        new TextRun({
          text: 'Q4 Revenue: $2.3M (15% YoY) | Operating margin: 42% | Cash reserves: $4.2M',
          size: 24
        })
      ],
      style: 'Confidential'
    }),

    // Normal paragraph (space)
    new Paragraph({
      text: '',
      spacing: { after: 200 }
    }),

    // Secret section
    new Paragraph({
      children: [
        new TextRun({
          text: 'Strategic Initiatives',
          bold: true,
          size: 28
        })
      ],
      style: 'Secret'
    }),

    new Paragraph({
      children: [
        new TextRun({
          text: 'This requires SECRET clearance or higher to view.',
          size: 24
        })
      ],
      style: 'Secret'
    }),

    new Paragraph({
      children: [
        new TextRun({
          text: 'M&A target: ACME Corporation | Expected value: $15M | Timeline: Q1 2026',
          size: 24
        })
      ],
      style: 'Secret'
    }),

    // Normal paragraph (space)
    new Paragraph({
      text: '',
      spacing: { after: 200 }
    }),

    // Top Secret section
    new Paragraph({
      children: [
        new TextRun({
          text: 'Board-Level Strategy',
          bold: true,
          size: 28
        })
      ],
      style: 'TopSecret'
    }),

    new Paragraph({
      children: [
        new TextRun({
          text: 'This requires TOP SECRET clearance to view.',
          size: 24
        })
      ],
      style: 'TopSecret'
    }),

    new Paragraph({
      children: [
        new TextRun({
          text: 'Authorization code: ALPHA-7392 | Project: Operation Phoenix | Budget: $5M',
          size: 24
        })
      ],
      style: 'TopSecret'
    }),

    // Final note
    new Paragraph({
      text: '',
      spacing: { after: 400 }
    }),

    new Paragraph({
      children: [
        new TextRun({
          text: 'End of Document',
          italics: true,
          size: 20,
          color: '999999'
        })
      ],
      alignment: AlignmentType.CENTER
    })
  ];
}

/**
 * Generate the complete template
 */
async function generateTemplate() {
  const doc = new Document({
    title: 'Classified Document Template',
    description: 'Template with clearance paragraph styles for easy classification',
    creator: 'Company Admin Portal',
    styles: {
      paragraphStyles: buildParagraphStyles()
    },
    sections: [
      {
        properties: {},
        children: [
          ...createInstructions(),
          ...createExampleContent()
        ]
      }
    ]
  });

  return doc;
}

/**
 * Main function
 */
async function main() {
  console.log('Generating Word template with PARAGRAPH STYLES (user-friendly approach)...\n');

  try {
    const doc = await generateTemplate();

    // Ensure templates directory exists
    const outputDir = path.join(__dirname, '..', 'public', 'templates');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const outputPath = path.join(outputDir, 'classified-document-template.docx');
    const buffer = await Packer.toBuffer(doc);
    fs.writeFileSync(outputPath, buffer);

    console.log('\u2705 Template generated successfully!');
    console.log(`   Output: ${outputPath}`);
    console.log(`   Size: ${Math.round(buffer.length / 1024)} KB\n`);

    console.log('Included clearance styles:');
    console.log('   \u2022 Unclassified (green)  - Level 1 - Public info');
    console.log('   \u2022 Confidential (blue)   - Level 2 - Sensitive business info');
    console.log('   \u2022 Secret (orange)       - Level 3 - Highly restricted');
    console.log('   \u2022 TopSecret (red)       - Level 4 - Maximum classification\n');

    console.log('How users apply styles:');
    console.log('   1. Open this template in Microsoft Word');
    console.log('   2. Write or paste document content');
    console.log('   3. Select paragraph(s) to classify');
    console.log('   4. Click style name in Home tab > Styles gallery');
    console.log('   5. Upload to Employee Portal\n');

  } catch (error) {
    console.error('Error generating template:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { generateTemplate };
