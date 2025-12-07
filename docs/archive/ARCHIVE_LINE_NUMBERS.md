# Archive Line Numbers for CLAUDE.md Cleanup

**Date**: 2025-11-15
**Purpose**: Line numbers for sections archived from `/root/CLAUDE.md`

---

## Sections to Remove from CLAUDE.md

### 1. DIDComm Label Transmission - FULLY OPERATIONAL
- **Start Line**: 597
- **End Line**: 769 (includes the `---` separator)
- **Total Lines**: 173
- **Archived To**: `/root/docs/archive/HISTORICAL_FIXES.md` (Section 1)
- **Reason**: Completed implementation from November 7, 2025 - now stable and part of production

### 2. HTTPS Migration Complete
- **Start Line**: 771
- **End Line**: 945 (includes the `---` separator)
- **Total Lines**: 175
- **Archived To**: `/root/docs/archive/HISTORICAL_FIXES.md` (Section 2)
- **Reason**: Completed migration from November 2, 2025 - now stable and part of production

### 3. X25519 Bidirectional Decryption Fix
- **Start Line**: 1078
- **End Line**: 1120 (includes the `---` separator)
- **Total Lines**: 43
- **Archived To**: `/root/docs/archive/HISTORICAL_FIXES.md` (Section 3)
- **Reason**: Completed fix from October 25, 2025 - now stable and part of production

### 4. SDK Attachment Validation Fix
- **Start Line**: 1122
- **End Line**: 1159 (includes the `---` separator)
- **Total Lines**: 38
- **Archived To**: `/root/docs/archive/HISTORICAL_FIXES.md` (Section 4)
- **Reason**: Completed fix from October 14, 2025 - now stable and part of production

### 5. Top-Level Issuer Infrastructure
- **Start Line**: 1723
- **End Line**: 1923 (includes the `---` separator)
- **Total Lines**: 201
- **Archived To**: `/root/docs/archive/TOP_LEVEL_ISSUER_HISTORICAL.md`
- **Reason**: Decommissioned on November 9, 2025 - replaced by Enterprise Cloud Agent multitenancy

---

## Removal Summary

**Total Lines to Remove**: 630 lines (approximately 20% of the document)

**Files Created**:
- `/root/docs/archive/TOP_LEVEL_ISSUER_HISTORICAL.md` (7.3 KB)
- `/root/docs/archive/HISTORICAL_FIXES.md` (19 KB)

**Remaining in CLAUDE.md**:
- Company Admin Portal (still active)
- Multitenancy Cloud Agent (still active)
- Enterprise Cloud Agent (still active)
- Phase 2 Client-Side Encryption (current implementation)
- StatusList2021 Credential Revocation Architecture (current implementation)
- Core features and API reference
- Quick reference tables and troubleshooting

---

## Removal Strategy

**Option 1: Manual Removal** (Recommended for precision)
1. Open `/root/CLAUDE.md` in editor
2. Remove lines 597-769 (DIDComm Label Transmission)
3. Remove lines 771-945 (HTTPS Migration) - **NOTE**: Line numbers shift after first removal
4. Remove lines 1078-1120 (X25519 Fix) - **NOTE**: Line numbers shift
5. Remove lines 1122-1159 (SDK Attachment Fix) - **NOTE**: Line numbers shift
6. Remove lines 1723-1923 (Top-Level Issuer) - **NOTE**: Line numbers shift
7. Add reference note in "Latest Updates" section pointing to archive files

**Option 2: Automated Removal** (Use with caution)
```bash
# NOT RECOMMENDED - line numbers shift after each deletion
# Manual removal is safer to avoid removing wrong sections
```

**Option 3: Create Clean Copy** (Safest)
1. Read entire CLAUDE.md
2. Extract all sections NOT in the archive list
3. Write to new file with archive references added
4. Backup original: `cp /root/CLAUDE.md /root/CLAUDE.md.backup`
5. Replace with clean copy

---

## Archive References to Add

Add the following section to the "Latest Updates" section in CLAUDE.md (near the top):

```markdown
---

## Archived Documentation

The following completed implementations and decommissioned infrastructure have been archived for historical reference:

### Historical Fixes (Completed & Stable)
- **DIDComm Label Transmission** (Nov 7, 2025) - ✅ Production Ready
- **HTTPS Migration** (Nov 2, 2025) - ✅ Fully Operational
- **X25519 Bidirectional Decryption Fix** (Oct 25, 2025) - ✅ Fully Operational
- **SDK Attachment Validation Fix** (Oct 14, 2025) - ✅ Fully Operational

**Archive Location**: `/root/docs/archive/HISTORICAL_FIXES.md`

### Decommissioned Infrastructure
- **Top-Level Issuer Infrastructure** (Decommissioned Nov 9, 2025)
  - Replaced by Enterprise Cloud Agent multitenancy solution

**Archive Location**: `/root/docs/archive/TOP_LEVEL_ISSUER_HISTORICAL.md`

---
```

---

## Notes

- **Line Number Shifts**: After removing each section, subsequent line numbers will shift up. Use an editor with line numbers for precision.
- **Backup First**: Always create a backup before major edits: `cp /root/CLAUDE.md /root/CLAUDE.md.backup.$(date +%Y%m%d)`
- **Archive Integrity**: Both archive files are complete and self-contained with all original content preserved
- **Cross-References**: Update any internal references in CLAUDE.md that point to archived sections

---

**Created By**: Archive automation script
**Date**: 2025-11-15
**Archive Version**: 1.0
