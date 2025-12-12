# Classified Document Format Guide

This guide explains how to create and use classified documents with section-level clearance markings in the Company Admin Portal.

## Overview

The classified document system allows you to mark different sections of a document with different security clearance levels. When a user views the document, sections above their clearance level are automatically **redacted** (shown as black boxes).

### Clearance Levels

| Level | Name | Code | Description |
|-------|------|------|-------------|
| 1 | UNCLASSIFIED | `UNCLASSIFIED` | Public information, accessible to all |
| 2 | CONFIDENTIAL | `CONFIDENTIAL` | Sensitive business information |
| 3 | SECRET | `SECRET` | Highly restricted information |
| 4 | TOP_SECRET | `TOP_SECRET` | Classified information (highest) |

**Clearance Hierarchy**: Users with higher clearance can see all content at or below their level.
- TOP_SECRET users see everything
- SECRET users see SECRET, CONFIDENTIAL, and UNCLASSIFIED
- CONFIDENTIAL users see CONFIDENTIAL and UNCLASSIFIED
- UNCLASSIFIED users see only UNCLASSIFIED content

## Document Formats

### HTML Format (Recommended)

Use the `data-clearance` attribute on any HTML element to mark its clearance level.

#### Template Example

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="document-type" content="classified-document">
  <meta name="document-title" content="Your Document Title">
</head>
<body>
  <h1>Document Title</h1>

  <!-- UNCLASSIFIED - No attribute needed for public content -->
  <section>
    <h2>Public Information</h2>
    <p>This content is visible to everyone.</p>
  </section>

  <!-- CONFIDENTIAL section -->
  <section data-clearance="CONFIDENTIAL">
    <h2>Confidential Section</h2>
    <p>Only users with CONFIDENTIAL+ clearance can see this.</p>
  </section>

  <!-- SECRET section -->
  <section data-clearance="SECRET">
    <h2>Secret Information</h2>
    <p>Only users with SECRET+ clearance can see this.</p>
  </section>

  <!-- TOP_SECRET section -->
  <section data-clearance="TOP_SECRET">
    <h2>Top Secret Operations</h2>
    <p>Only TOP_SECRET clearance holders can see this.</p>
  </section>

</body>
</html>
```

#### Supported Elements

The `data-clearance` attribute can be applied to **any** HTML element:

| Element Type | Usage | Example |
|--------------|-------|---------|
| `<section>` | Large content blocks | Entire sections of the document |
| `<div>` | Content divisions | Grouped related content |
| `<p>` | Paragraphs | Individual paragraphs |
| `<span>` | Inline text | Words or phrases within paragraphs |
| `<table>` | Tables | Entire data tables |
| `<tr>` | Table rows | Specific rows of data |
| `<td>` | Table cells | Individual cells |
| `<ul>`, `<ol>` | Lists | Bullet or numbered lists |
| `<li>` | List items | Individual list items |

#### Inline Clearance Example

```html
<p>
  Company revenue this quarter: $2.5M
  <span data-clearance="CONFIDENTIAL">
    (Net profit: $450K, Operating margin: 18%)
  </span>
</p>
```

### Microsoft Word Format (DOCX)

For Word documents, use **Content Controls** with clearance tags.

#### How to Create in Word

1. **Enable Developer Tab**: File → Options → Customize Ribbon → Check "Developer"
2. **Select Content**: Highlight the text/content to classify
3. **Insert Content Control**: Developer → Rich Text Content Control
4. **Set Tag**: Click "Properties" → Set Tag to `clearance:LEVEL`

#### Tag Format

Use the format `clearance:LEVEL` where LEVEL is:
- `clearance:UNCLASSIFIED`
- `clearance:CONFIDENTIAL`
- `clearance:SECRET`
- `clearance:TOP_SECRET`

#### Template Download

Download the pre-configured Word template from the Employee Portal:
- Navigate to: Employee Portal → Create Classified Document
- Click: "Download Word Template (.docx)"

## Uploading Documents

### Step 1: Access Employee Portal

1. Log in to the Employee Portal with your credentials
2. Complete authentication via your wallet
3. Navigate to "Documents" section

### Step 2: Create Classified Document

1. Click "Create Classified Document"
2. Select your prepared HTML or DOCX file
3. Review the section analysis:
   - Total sections detected
   - Breakdown by clearance level
   - Overall document classification

### Step 3: Set Releasability

Choose which companies/organizations can access the document:
- Check the boxes for authorized companies
- Documents are encrypted per-company

### Step 4: Upload

Click "Upload Document" to:
1. Parse and validate the document
2. Encrypt sections with clearance-based keys
3. Store on Iagon decentralized storage
4. Create document DID
5. Register in DocumentRegistry

## Viewing Documents

### From Employee Portal

1. Navigate to Documents list
2. Click "View" on any document
3. Enter clearance verification if prompted
4. Document displays with appropriate redactions

### Download to Wallet

For time-limited secure viewing:

1. Click "To Wallet" button
2. Document is encrypted for your wallet
3. Ephemeral DID created with 1-hour TTL
4. Open document in wallet's "My Documents" page
5. Document auto-expires after TTL

### What You'll See

Based on your clearance level:

**If you have CONFIDENTIAL clearance viewing a document with all levels:**

```
┌─────────────────────────────────────────────────┐
│ Public Information                              │
│ This content is visible to everyone.            │
├─────────────────────────────────────────────────┤
│ Confidential Section                            │
│ Only CONFIDENTIAL+ clearance can see this.      │
├─────────────────────────────────────────────────┤
│ ████████████████████████████████████████████    │
│ █              REDACTED                    █    │
│ █       Requires: SECRET clearance         █    │
│ ████████████████████████████████████████████    │
├─────────────────────────────────────────────────┤
│ ████████████████████████████████████████████    │
│ █              REDACTED                    █    │
│ █     Requires: TOP_SECRET clearance       █    │
│ ████████████████████████████████████████████    │
└─────────────────────────────────────────────────┘
```

## Security Features

### Encryption

- **Per-Section Encryption**: Each section is encrypted with its own AES-256-GCM key
- **Clearance-Based Keys**: Master keys derived per clearance level
- **Key Hierarchy**: Higher clearance can derive lower clearance keys

### Redaction

- **Canvas Rendering**: Documents rendered as images, not text
- **No Download**: Native PDF controls disabled
- **No Print**: Print and save shortcuts blocked
- **Watermarks**: User identity embedded in view

### Time-Limited Access

- **Default TTL**: 1 hour
- **Ephemeral DID**: Each document copy gets unique identifier
- **Auto-Expiration**: Documents become inaccessible after TTL
- **View Tracking**: Access logged with timestamp

## Best Practices

### Document Structure

1. **Use semantic HTML**: Proper heading hierarchy (h1, h2, h3...)
2. **Group related content**: Use `<section>` for major divisions
3. **Avoid splitting classified content**: Keep clearance markers on container elements

### Clearance Assignment

1. **Minimum necessary**: Only mark content that needs protection
2. **Consistent levels**: Use same clearance for related information
3. **Consider context**: A single classified item can make surrounding context sensitive

### Unmarked Content

- Content **without** `data-clearance` attribute is treated as **UNCLASSIFIED**
- This is intentional: public content should be the default
- Always explicitly mark sensitive content

## Troubleshooting

### "Document failed to parse"

- Ensure valid HTML structure with `<html>`, `<head>`, `<body>`
- Check for `document-title` meta tag
- Verify `data-clearance` values are valid (UNCLASSIFIED, CONFIDENTIAL, SECRET, TOP_SECRET)

### "Clearance verification failed"

- Ensure your Security Clearance VC is valid and not revoked
- Verify clearance level matches or exceeds document classification
- Check wallet connection is active

### "Document expired"

- Request a new copy from the Employee Portal
- Each copy has a 1-hour TTL by design
- This is a security feature, not a bug

## API Reference

### Upload Endpoint

```
POST /api/classified-documents/upload
Content-Type: multipart/form-data

Parameters:
- file: HTML or DOCX file
- title: (optional) Document title override
- releasableTo: JSON array of company names

Response:
{
  "success": true,
  "documentDID": "did:prism:...",
  "sections": [...]
}
```

### Download Endpoint

```
POST /api/classified-documents/download
Content-Type: application/json

Body:
{
  "documentDID": "did:prism:...",
  "clearanceLevel": 2,
  "walletPublicKey": "base64-public-key"
}

Response:
{
  "success": true,
  "encryptedDocument": "base64...",
  "ephemeralDID": "did:ephemeral:...",
  "expiresAt": "2025-12-12T21:00:00Z",
  "sectionSummary": {
    "accessible": 3,
    "redacted": 2
  }
}
```

### Templates Endpoint

```
GET /api/classified-documents/templates

Response:
{
  "templates": [
    {
      "name": "HTML Template",
      "format": "html",
      "downloadUrl": "/templates/classified-document-template.html"
    },
    {
      "name": "Word Template",
      "format": "docx",
      "downloadUrl": "/templates/classified-document-template.docx"
    }
  ]
}
```

## Support

For questions or issues:
- Check the Employee Portal FAQ
- Contact your Security Administrator
- Review system logs for error details

---

*Document Version: 1.0*
*Last Updated: December 12, 2025*
