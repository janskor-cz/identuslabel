/**
 * DBConnect Component - Transparent Wrapper
 *
 * Database connection UI has been moved to PageHeader (upper right corner).
 * This component is kept for backward compatibility with existing page structures.
 *
 * Auto-initialization flow (handled by index.tsx):
 * 1. User enters password in PageHeader
 * 2. Database connects
 * 3. Agent automatically initializes
 * 4. Agent automatically starts
 */
import React from "react";

export function DBConnect({ children }: { children: React.ReactNode }) {
  // Transparent wrapper - no UI
  // Database login now in PageHeader
  return <>{children}</>;
}
