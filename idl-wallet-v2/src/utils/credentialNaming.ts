import { getCredentialSubject } from './credentialTypeDetector';

/**
 * Extracts a user-friendly display name from a credential
 * Now includes credential type and expiration date for better UX
 *
 * Priority order:
 * 1. firstName + lastName + credentialType + expiration
 * 2. holderName + credentialType + expiration (SecurityClearance)
 * 3. uniqueId + credentialType
 * 4. Subject ID (shortened)
 * 5. Issuer DID (shortened)
 * 6. "Unnamed Credential"
 */
export function extractCredentialDisplayName(credential: any): string {
  try {
    let displayName = '';
    let credentialType = '';
    let expiryInfo = '';

    // Use getCredentialSubject to handle all credential formats:
    // - SDK JWTCredential with properties Map
    // - Direct credentialSubject property
    // - claims array
    // - vc.credentialSubject
    const subject = getCredentialSubject(credential);

    if (subject) {

      // Extract credential type if available
      if (subject.credentialType) {
        // Format credential type for display
        if (subject.credentialType === 'RealPersonIdentity') {
          credentialType = ' (ID)';
        } else if (subject.credentialType === 'SecurityClearance') {
          // Show clearance level instead of generic "(Clearance)"
          if (subject.clearanceLevel) {
            credentialType = ` (${subject.clearanceLevel})`;
          } else {
            credentialType = ' (Clearance)';
          }
        } else {
          credentialType = ` (${subject.credentialType})`;
        }
      }

      // Extract expiration date if available
      if (subject.expiryDate) {
        try {
          const expiry = new Date(subject.expiryDate);
          const now = new Date();
          const daysUntilExpiry = Math.floor((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

          // Show expiration in different formats based on urgency
          if (daysUntilExpiry < 0) {
            expiryInfo = ' [EXPIRED]';
          } else if (daysUntilExpiry < 30) {
            expiryInfo = ` [Exp: ${daysUntilExpiry}d]`;
          } else if (daysUntilExpiry < 365) {
            const monthsUntilExpiry = Math.floor(daysUntilExpiry / 30);
            expiryInfo = ` [Exp: ${monthsUntilExpiry}mo]`;
          } else {
            const yearsUntilExpiry = Math.floor(daysUntilExpiry / 365);
            expiryInfo = ` [Exp: ${yearsUntilExpiry}yr]`;
          }
        } catch (dateError) {
          // If date parsing fails, show raw date
          expiryInfo = ` [Exp: ${subject.expiryDate}]`;
        }
      }

      // Priority 1: Full name with type and expiration
      if (subject.firstName && subject.lastName) {
        displayName = `${subject.firstName} ${subject.lastName}`;
        return `${displayName}${credentialType}${expiryInfo}`;
      }

      // Priority 2: First name only
      if (subject.firstName) {
        displayName = subject.firstName;
        return `${displayName}${credentialType}${expiryInfo}`;
      }

      // Priority 2.5: holderName (used in SecurityClearance)
      if (subject.holderName) {
        displayName = subject.holderName;
        return `${displayName}${credentialType}${expiryInfo}`;
      }

      // Priority 3: uniqueId with type
      if (subject.uniqueId) {
        return `ID: ${subject.uniqueId}${credentialType}${expiryInfo}`;
      }

      // Priority 4: Subject ID (shortened)
      if (subject.id) {
        const id = typeof subject.id === 'string' ? subject.id : String(subject.id);
        if (id.length > 30) {
          displayName = `${id.substring(0, 15)}...${id.substring(id.length - 10)}`;
        } else {
          displayName = id;
        }
        return `${displayName}${credentialType}${expiryInfo}`;
      }
    }

    // Check claims array (SDK format)
    if (credential.claims && Array.isArray(credential.claims)) {
      for (const claim of credential.claims) {
        // Extract credential type from claims
        if (claim.credentialType && !credentialType) {
          if (claim.credentialType === 'RealPersonIdentity') {
            credentialType = ' (ID)';
          } else if (claim.credentialType === 'SecurityClearance') {
            // For SecurityClearance, show the clearance level instead of generic "(Clearance)"
            if (claim.clearanceLevel) {
              credentialType = ` (${claim.clearanceLevel})`;
            } else {
              credentialType = ' (Clearance)';
            }
          } else {
            credentialType = ` (${claim.credentialType})`;
          }
        }

        // Extract expiration from claims
        if (claim.expiryDate && !expiryInfo) {
          try {
            const expiry = new Date(claim.expiryDate);
            const now = new Date();
            const daysUntilExpiry = Math.floor((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

            if (daysUntilExpiry < 0) {
              expiryInfo = ' [EXPIRED]';
            } else if (daysUntilExpiry < 30) {
              expiryInfo = ` [Exp: ${daysUntilExpiry}d]`;
            } else if (daysUntilExpiry < 365) {
              const monthsUntilExpiry = Math.floor(daysUntilExpiry / 30);
              expiryInfo = ` [Exp: ${monthsUntilExpiry}mo]`;
            } else {
              const yearsUntilExpiry = Math.floor(daysUntilExpiry / 365);
              expiryInfo = ` [Exp: ${yearsUntilExpiry}yr]`;
            }
          } catch (dateError) {
            expiryInfo = ` [Exp: ${claim.expiryDate}]`;
          }
        }

        // Extract name from claims
        if (claim.firstName && claim.lastName) {
          displayName = `${claim.firstName} ${claim.lastName}`;
          return `${displayName}${credentialType}${expiryInfo}`;
        }
        if (claim.firstName) {
          displayName = claim.firstName;
          return `${displayName}${credentialType}${expiryInfo}`;
        }
        // Check holderName (used in SecurityClearance)
        if (claim.holderName) {
          displayName = claim.holderName;
          return `${displayName}${credentialType}${expiryInfo}`;
        }
        if (claim.uniqueId) {
          return `ID: ${claim.uniqueId}${credentialType}${expiryInfo}`;
        }
      }
    }

    // Fallback: Issuer DID (shortened)
    if (credential.issuer) {
      const issuer = typeof credential.issuer === 'string' ? credential.issuer : String(credential.issuer);
      if (issuer.length > 30) {
        displayName = `Issued by: ...${issuer.substring(issuer.length - 15)}`;
      } else {
        displayName = `Issued by: ${issuer}`;
      }
      return `${displayName}${credentialType}${expiryInfo}`;
    }

    // Final fallback
    return 'Unnamed Credential';
  } catch (error) {
    console.error('[credentialNaming] Error extracting name:', error);
    return 'Unnamed Credential';
  }
}
