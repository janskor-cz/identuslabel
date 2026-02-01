/**
 * Populate Sample Documents
 *
 * Creates sample UNCLASSIFIED and CONFIDENTIAL documents in the running
 * Company Admin Portal server via API calls.
 *
 * This script creates documents that will persist in the server's in-memory
 * DocumentRegistry until the server restarts.
 *
 * Usage: node populate-sample-documents.js
 */

const EnterpriseDocumentManager = require('./lib/EnterpriseDocumentManager');
const DocumentRegistry = require('./lib/DocumentRegistry');

// Configuration
const ENTERPRISE_CLOUD_AGENT_URL = 'http://91.99.4.54:8300';

// Department API Keys (from server.js)
const DEPARTMENT_API_KEYS = {
  HR: '2c1c82a0028bda281454b1a3d1b20aab0e3a0879954eb68c467a5d867d12283c',
  IT: '63ca7582205fff117077caef24978d157f1c34dc8dbfcd9a3f42769d9ce7af52',
  Security: '23ce715f58f9b9055de5502cc31de1910b320707dfbf28f81acec2b641c73288'
};

// Company issuerDID mappings
const COMPANY_ISSUER_DIDS = {
  'TechCorp Corporation': 'did:prism:6ee757c2913a76aa4eb2f09e9cd3cc40ead73cfaffc7d712c303ee5bc38f21bf',
  'ACME Corporation': 'did:prism:474c91516a875ba9af9f39a3b9747cb70ad7684f0b3fb8ee2b7b145efac286b9'
};

// Sample documents to create
const SAMPLE_DOCUMENTS = [
  // UNCLASSIFIED Documents (accessible to all employees)
  {
    department: 'HR',
    classificationLevel: 'UNCLASSIFIED',
    title: 'Company Handbook 2025',
    description: 'General company policies and procedures for all employees',
    releasableTo: ['TechCorp Corporation'],
    metadata: {
      category: 'HR',
      version: '2025.1',
      author: 'HR Department'
    }
  },
  {
    department: 'HR',
    classificationLevel: 'UNCLASSIFIED',
    title: 'Employee Benefits Guide',
    description: 'Comprehensive guide to employee benefits and perks',
    releasableTo: ['TechCorp Corporation'],
    metadata: {
      category: 'HR',
      version: '2025.1',
      author: 'HR Department'
    }
  },
  {
    department: 'IT',
    classificationLevel: 'UNCLASSIFIED',
    title: 'IT Support Guide',
    description: 'How to request IT support and common troubleshooting steps',
    releasableTo: ['TechCorp Corporation'],
    metadata: {
      category: 'IT',
      version: '2025.1',
      author: 'IT Department'
    }
  },

  // CONFIDENTIAL Documents (requires CONFIDENTIAL clearance)
  {
    department: 'HR',
    classificationLevel: 'CONFIDENTIAL',
    title: 'Executive Compensation Report',
    description: 'Confidential executive salary and bonus information',
    releasableTo: ['TechCorp Corporation'],
    metadata: {
      category: 'HR',
      version: '2025.Q4',
      author: 'HR Department'
    }
  },
  {
    department: 'HR',
    classificationLevel: 'CONFIDENTIAL',
    title: 'Performance Review Guidelines',
    description: 'Internal guidelines for conducting employee performance reviews',
    releasableTo: ['TechCorp Corporation'],
    metadata: {
      category: 'HR',
      version: '2025.1',
      author: 'HR Department'
    }
  },

  // SECRET Documents (requires SECRET clearance)
  {
    department: 'Security',
    classificationLevel: 'SECRET',
    title: 'Security Incident Response Plan',
    description: 'Classified procedures for responding to security incidents',
    releasableTo: ['TechCorp Corporation'],
    metadata: {
      category: 'Security',
      version: '2025.1',
      author: 'Security Team'
    }
  }
];

async function createDocument(docSpec) {
  console.log(`\n[${docSpec.classificationLevel}] Creating: ${docSpec.title}`);

  try {
    // Step 1: Create document DID via Enterprise Cloud Agent
    const documentManager = new EnterpriseDocumentManager(
      ENTERPRISE_CLOUD_AGENT_URL,
      DEPARTMENT_API_KEYS[docSpec.department]
    );

    const documentDID = await documentManager.createDocumentDID(docSpec.department, {
      title: docSpec.title,
      description: docSpec.description,
      classificationLevel: docSpec.classificationLevel,
      createdBy: `${docSpec.department.toLowerCase()}@techcorp.com`,
      createdByDID: `did:prism:${docSpec.department.toLowerCase()}-dept`
    });

    console.log(`   ✅ DID created: ${documentDID.substring(0, 60)}...`);

    // Step 2: Register document in DocumentRegistry
    const releasableToIssuerDIDs = docSpec.releasableTo.map(
      companyName => COMPANY_ISSUER_DIDS[companyName]
    );

    await DocumentRegistry.registerDocument({
      documentDID,
      title: docSpec.title,
      classificationLevel: docSpec.classificationLevel,
      releasableTo: releasableToIssuerDIDs,
      contentEncryptionKey: 'mock-abe-encrypted-key',
      metadata: docSpec.metadata
    });

    console.log(`   ✅ Registered in DocumentRegistry`);

    return {
      success: true,
      documentDID,
      title: docSpec.title,
      classificationLevel: docSpec.classificationLevel
    };

  } catch (error) {
    console.error(`   ❌ Failed: ${error.message}`);
    return {
      success: false,
      title: docSpec.title,
      error: error.message
    };
  }
}

async function main() {
  console.log('\n' + '='.repeat(70));
  console.log('📝 Populating Sample Documents');
  console.log('='.repeat(70));
  console.log(`\nCreating ${SAMPLE_DOCUMENTS.length} sample documents...`);

  const results = [];

  for (const docSpec of SAMPLE_DOCUMENTS) {
    const result = await createDocument(docSpec);
    results.push(result);

    // Small delay between documents to avoid overwhelming the API
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Display summary
  console.log('\n' + '='.repeat(70));
  console.log('📊 Summary');
  console.log('='.repeat(70));

  const successCount = results.filter(r => r.success).length;
  const failCount = results.filter(r => !r.success).length;

  console.log(`\n✅ Successfully created: ${successCount} documents`);
  console.log(`❌ Failed: ${failCount} documents`);

  // Show what was created by classification level
  const byClassification = {};
  results.filter(r => r.success).forEach(r => {
    if (!byClassification[r.classificationLevel]) {
      byClassification[r.classificationLevel] = [];
    }
    byClassification[r.classificationLevel].push(r.title);
  });

  console.log('\nDocuments by classification level:');
  Object.entries(byClassification).forEach(([level, titles]) => {
    console.log(`\n  ${level} (${titles.length}):`);
    titles.forEach(title => {
      console.log(`    - ${title}`);
    });
  });

  // Show DocumentRegistry statistics
  const stats = DocumentRegistry.getStatistics();
  console.log('\nDocumentRegistry Statistics:');
  console.log(`  Total documents: ${stats.totalDocuments}`);
  console.log(`  By classification:`);
  Object.entries(stats.byClassification).forEach(([level, count]) => {
    if (count > 0) {
      console.log(`    - ${level}: ${count}`);
    }
  });

  console.log('\n' + '='.repeat(70));
  console.log('✅ Document population complete!');
  console.log('='.repeat(70));
  console.log('\nDocuments are now available in the Employee Portal.');
  console.log('Employees will see documents based on their clearance level:');
  console.log('  - No clearance: UNCLASSIFIED only');
  console.log('  - CONFIDENTIAL: UNCLASSIFIED + CONFIDENTIAL');
  console.log('  - SECRET: UNCLASSIFIED + CONFIDENTIAL + SECRET');
  console.log('  - TOP_SECRET: All documents\n');
}

main().catch(error => {
  console.error('\n❌ Fatal error:', error.message);
  console.error('Stack trace:', error.stack);
  process.exit(1);
});
