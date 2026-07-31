/**
 * Certification Authority Configuration
 *
 * This configuration provides the well-known endpoint for the Certification Authority
 * that issues RealPerson and Security Clearance credentials.
 *
 * The well-known endpoint returns the current valid invitation, which survives CA restarts
 * because it's dynamically generated based on the current CA DID.
 */

export interface CertificationAuthorityConfig {
  name: string;
  baseUrl: string;
  wellKnownInvitationEndpoint: string;
  getInvitationEndpoint(): string;
}

export const CERTIFICATION_AUTHORITY: CertificationAuthorityConfig = {
  /**
   * Display name of the Certification Authority
   */
  name: "Certification Authority",

  /**
   * Base URL of the Certification Authority server
   * Uses HTTPS domain to avoid Mixed Content errors when wallet is accessed via HTTPS
   */
  baseUrl: "https://identuslabel.cz/ca",

  /**
   * Well-known endpoint path that returns the current valid invitation
   * This endpoint:
   * - Returns invitation with current CA DID
   * - Survives CA restarts (regenerates invitation)
   * - Caches invitation for efficiency
   */
  wellKnownInvitationEndpoint: "/api/well-known/invitation",

  /**
   * Helper method to get the full invitation endpoint URL
   * @returns Full URL to fetch the well-known invitation
   */
  getInvitationEndpoint(): string {
    return `${this.baseUrl}${this.wellKnownInvitationEndpoint}`;
  }
};
