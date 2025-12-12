/**
 * generateDocxTemplate.js
 *
 * Generates a Microsoft Word template with pre-configured Content Controls
 * for clearance-level document creation.
 *
 * Run: node scripts/generateDocxTemplate.js
 */

const {
  Document,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  ShadingType,
  AlignmentType,
  Packer
} = require('docx');
const fs = require('fs');
const path = require('path');

// Clearance level colors (RGB values for Word)
const COLORS = {
  UNCLASSIFIED: { bg: 'E8F5E9', text: '1B5E20', label: '4CAF50' },
  CONFIDENTIAL: { bg: 'E3F2FD', text: '0D47A1', label: '2196F3' },
  SECRET: { bg: 'FFF3E0', text: 'E65100', label: 'FF9800' },
  TOP_SECRET: { bg: 'FFEBEE', text: 'B71C1C', label: 'F44336' }
};

/**
 * Create a clearance section with styled content
 * Note: True Content Controls (SDTs) require direct XML manipulation
 * This creates visually styled sections with instructions for manual SDT creation
 */
function createClearanceSection(level, title, contentParagraphs) {
  const color = COLORS[level];

  const paragraphs = [
    // Section header with clearance label
    new Paragraph({
      children: [
        new TextRun({
          text: `[${level}] `,
          bold: true,
          color: color.label,
          size: 20
        }),
        new TextRun({
          text: title,
          bold: true,
          size: 28,
          color: color.text
        })
      ],
      shading: {
        type: ShadingType.SOLID,
        color: color.bg
      },
      spacing: { before: 400, after: 200 }
    })
  ];

  // Add content paragraphs
  for (const content of contentParagraphs) {
    paragraphs.push(
      new Paragraph({
        children: [
          new TextRun({
            text: content,
            size: 24
          })
        ],
        shading: {
          type: ShadingType.SOLID,
          color: color.bg
        },
        spacing: { after: 100 }
      })
    );
  }

  // Add spacing after section
  paragraphs.push(
    new Paragraph({
      text: '',
      spacing: { after: 200 }
    })
  );

  return paragraphs;
}

/**
 * Create the instructions section
 */
function createInstructions() {
  return [
    new Paragraph({
      children: [
        new TextRun({
          text: 'HOW TO USE THIS TEMPLATE',
          bold: true,
          size: 32,
          color: '666666'
        })
      ],
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 200, after: 200 }
    }),

    new Paragraph({
      children: [
        new TextRun({
          text: 'This template demonstrates section-level security classification for documents.',
          size: 24
        })
      ],
      spacing: { after: 200 }
    }),

    new Paragraph({
      children: [
        new TextRun({
          text: 'To Create Content Controls with Clearance Tags:',
          bold: true,
          size: 24
        })
      ],
      spacing: { before: 200, after: 100 }
    }),

    new Paragraph({
      children: [
        new TextRun({ text: '1. Enable Developer Tab: File > Options > Customize Ribbon > Check "Developer"', size: 22 })
      ],
      spacing: { after: 50 }
    }),

    new Paragraph({
      children: [
        new TextRun({ text: '2. Select the content you want to classify', size: 22 })
      ],
      spacing: { after: 50 }
    }),

    new Paragraph({
      children: [
        new TextRun({ text: '3. Developer Tab > Rich Text Content Control', size: 22 })
      ],
      spacing: { after: 50 }
    }),

    new Paragraph({
      children: [
        new TextRun({ text: '4. Click Properties > Set Tag to: clearance:LEVEL', size: 22 })
      ],
      spacing: { after: 50 }
    }),

    new Paragraph({
      children: [
        new TextRun({ text: '   Example tags: clearance:UNCLASSIFIED, clearance:CONFIDENTIAL, clearance:SECRET, clearance:TOP_SECRET', size: 20, italics: true })
      ],
      spacing: { after: 200 }
    }),

    new Paragraph({
      children: [
        new TextRun({
          text: 'Clearance Levels (from lowest to highest):',
          bold: true,
          size: 24
        })
      ],
      spacing: { before: 200, after: 100 }
    }),

    // Clearance level descriptions
    new Paragraph({
      children: [
        new TextRun({ text: 'UNCLASSIFIED', bold: true, color: COLORS.UNCLASSIFIED.label }),
        new TextRun({ text: ' - Public information, no restrictions', size: 22 })
      ],
      spacing: { after: 50 }
    }),

    new Paragraph({
      children: [
        new TextRun({ text: 'CONFIDENTIAL', bold: true, color: COLORS.CONFIDENTIAL.label }),
        new TextRun({ text: ' - Sensitive business information', size: 22 })
      ],
      spacing: { after: 50 }
    }),

    new Paragraph({
      children: [
        new TextRun({ text: 'SECRET', bold: true, color: COLORS.SECRET.label }),
        new TextRun({ text: ' - Highly restricted information', size: 22 })
      ],
      spacing: { after: 50 }
    }),

    new Paragraph({
      children: [
        new TextRun({ text: 'TOP_SECRET', bold: true, color: COLORS.TOP_SECRET.label }),
        new TextRun({ text: ' - Classified information (highest restriction)', size: 22 })
      ],
      spacing: { after: 200 }
    }),

    // Separator
    new Paragraph({
      children: [
        new TextRun({
          text: '═══════════════════════════════════════════════════════════════════',
          color: '999999'
        })
      ],
      alignment: AlignmentType.CENTER,
      spacing: { before: 400, after: 400 }
    }),

    new Paragraph({
      children: [
        new TextRun({
          text: 'DELETE THE INSTRUCTIONS ABOVE BEFORE UPLOADING',
          bold: true,
          color: 'CC0000',
          size: 24
        })
      ],
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 }
    }),

    // Another separator
    new Paragraph({
      children: [
        new TextRun({
          text: '═══════════════════════════════════════════════════════════════════',
          color: '999999'
        })
      ],
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 }
    })
  ];
}

/**
 * Create the example document content
 */
function createExampleContent() {
  const sections = [];

  // Document title
  sections.push(
    new Paragraph({
      children: [
        new TextRun({
          text: 'Q4 Financial Report - TechCorp',
          bold: true,
          size: 48
        })
      ],
      heading: HeadingLevel.TITLE,
      spacing: { after: 400 }
    })
  );

  // UNCLASSIFIED section
  sections.push(...createClearanceSection(
    'UNCLASSIFIED',
    'Public Metrics',
    [
      'This section contains publicly available information that anyone can view.',
      'Total projects completed: 45',
      'Customer satisfaction rating: 92%',
      'Employee count: 250',
      'Office locations: 3 (Prague, Berlin, London)'
    ]
  ));

  // CONFIDENTIAL section
  sections.push(...createClearanceSection(
    'CONFIDENTIAL',
    'Financial Performance',
    [
      'This section requires CONFIDENTIAL clearance or higher to view.',
      'Q4 Revenue: $2.3M (15% increase YoY)',
      'Operating margin: 42%',
      'EBITDA: $980K',
      'Cash reserves: $4.2M'
    ]
  ));

  // SECRET section
  sections.push(...createClearanceSection(
    'SECRET',
    'Strategic Initiatives',
    [
      'This section requires SECRET clearance or higher to view.',
      'M&A discussions with ACME Corporation are in advanced stages.',
      'Expected acquisition value: $15M',
      'Due diligence completion: Q1 2026',
      'Regulatory approval timeline: 6-9 months'
    ]
  ));

  // TOP_SECRET section
  sections.push(...createClearanceSection(
    'TOP_SECRET',
    'Board-Level Strategy',
    [
      'This section requires TOP_SECRET clearance to view.',
      'Executive authorization code: ALPHA-7392',
      'Classified project: Operation Phoenix',
      'Special budget allocation: $5M (separate accounting)'
    ]
  ));

  // Example table
  sections.push(
    new Paragraph({
      children: [
        new TextRun({
          text: 'Department Budgets',
          bold: true,
          size: 32
        })
      ],
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 400, after: 200 }
    })
  );

  // Create table
  const table = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      // Header row
      new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: 'Department', bold: true })] })],
            shading: { type: ShadingType.SOLID, color: 'F5F5F5' }
          }),
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: 'Budget', bold: true })] })],
            shading: { type: ShadingType.SOLID, color: 'F5F5F5' }
          }),
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: 'Classification', bold: true })] })],
            shading: { type: ShadingType.SOLID, color: 'F5F5F5' }
          })
        ]
      }),
      // Data rows
      new TableRow({
        children: [
          new TableCell({ children: [new Paragraph('Marketing')] }),
          new TableCell({ children: [new Paragraph('$500K')] }),
          new TableCell({ children: [new Paragraph('Public')] })
        ]
      }),
      new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph('R&D')],
            shading: { type: ShadingType.SOLID, color: COLORS.CONFIDENTIAL.bg }
          }),
          new TableCell({
            children: [new Paragraph('$1.2M')],
            shading: { type: ShadingType.SOLID, color: COLORS.CONFIDENTIAL.bg }
          }),
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: 'CONFIDENTIAL', color: COLORS.CONFIDENTIAL.label })] })],
            shading: { type: ShadingType.SOLID, color: COLORS.CONFIDENTIAL.bg }
          })
        ]
      }),
      new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph('Special Projects')],
            shading: { type: ShadingType.SOLID, color: COLORS.SECRET.bg }
          }),
          new TableCell({
            children: [new Paragraph('$3.5M')],
            shading: { type: ShadingType.SOLID, color: COLORS.SECRET.bg }
          }),
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: 'SECRET', color: COLORS.SECRET.label })] })],
            shading: { type: ShadingType.SOLID, color: COLORS.SECRET.bg }
          })
        ]
      }),
      new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph('Black Ops')],
            shading: { type: ShadingType.SOLID, color: COLORS.TOP_SECRET.bg }
          }),
          new TableCell({
            children: [new Paragraph('$5M')],
            shading: { type: ShadingType.SOLID, color: COLORS.TOP_SECRET.bg }
          }),
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: 'TOP_SECRET', color: COLORS.TOP_SECRET.label })] })],
            shading: { type: ShadingType.SOLID, color: COLORS.TOP_SECRET.bg }
          })
        ]
      })
    ]
  });

  sections.push(table);

  sections.push(
    new Paragraph({
      children: [
        new TextRun({
          text: 'Note: To properly classify table rows, wrap each row content in a Content Control with the appropriate tag.',
          italics: true,
          size: 20,
          color: '666666'
        })
      ],
      spacing: { before: 100, after: 400 }
    })
  );

  return sections;
}

/**
 * Generate the complete template document
 */
async function generateTemplate() {
  const doc = new Document({
    title: 'Classified Document Template',
    description: 'Template for creating documents with section-level security classification',
    creator: 'Company Admin Portal',
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
  console.log('Generating Word template with clearance sections...');

  try {
    const doc = await generateTemplate();

    const outputPath = path.join(__dirname, '..', 'public', 'templates', 'classified-document-template.docx');

    const buffer = await Packer.toBuffer(doc);
    fs.writeFileSync(outputPath, buffer);

    console.log(`Template generated successfully: ${outputPath}`);
    console.log(`File size: ${Math.round(buffer.length / 1024)} KB`);

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
