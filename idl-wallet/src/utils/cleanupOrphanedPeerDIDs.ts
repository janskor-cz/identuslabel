/**
 * Cleanup Utility for Orphaned Peer DIDs
 *
 * Purpose: Remove peer DIDs that are registered with the mediator but have no active
 * DIDComm connection or missing private keys, preventing message queue flooding.
 *
 * What are Orphaned Peer DIDs?
 * - Peer DIDs created during failed connection attempts
 * - DIDs with no corresponding DIDPair in Pluto database
 * - DIDs registered with mediator but never completed handshake
 *
 * Why This Matters:
 * - Orphaned DIDs receive messages from mediator indefinitely
 * - These messages cannot be decrypted (missing keys)
 * - Causes console flooding with PickupRunner warnings
 * - Wastes bandwidth and processing resources
 *
 * Usage:
 * 1. Open browser console at https://identuslabel.cz/alice
 * 2. Import this module (if available in browser build)
 * 3. Run: await cleanupOrphanedPeerDIDs()
 * 4. Or integrate into Advanced tab UI
 *
 * @module cleanupOrphanedPeerDIDs
 * @since 2025-11-16
 */

import SDK from '@hyperledger/identus-edge-agent-sdk';

/**
 * Get agent instance from window (set by Agent component after initialization)
 */
function getAgent() {
  if (typeof window === 'undefined') {
    throw new Error('Window not available (server-side rendering)');
  }

  const agent = (window as any).agent;

  if (!agent) {
    throw new Error('Agent not initialized. Please start the wallet first.');
  }

  return agent;
}

/**
 * Diagnostic report of orphaned peer DIDs found in the wallet
 */
export interface OrphanedDIDReport {
  /** Total peer DIDs registered */
  totalPeerDIDs: number;
  /** Active connections (has DIDPair) */
  activeConnections: number;
  /** Orphaned DIDs (no DIDPair, no connection) */
  orphanedDIDs: string[];
  /** DIDs with missing private keys */
  missingKeys: string[];
  /** Recommended action */
  recommendation: string;
}

/**
 * Scan wallet for orphaned peer DIDs without removing them
 *
 * @returns Diagnostic report of orphaned DIDs
 */
export async function scanOrphanedPeerDIDs(): Promise<OrphanedDIDReport> {
  const agent = getAgent();

  if (!agent) {
    throw new Error('Agent not initialized. Start wallet first.');
  }

  console.log('🔍 [Cleanup] Scanning for orphaned peer DIDs...');

  // Get all DIDs from Pluto
  const allDIDs = await agent.pluto.getDIDs();

  // Filter to peer DIDs only
  const peerDIDs = allDIDs.filter(did => did.method === 'peer');

  // Get all active connections (DIDPairs)
  const allPairs = await agent.pluto.getAllDidPairs();

  // Extract all DIDs that are part of active connections
  const activeDIDs = new Set<string>();
  for (const pair of allPairs) {
    activeDIDs.add(pair.host.toString());
    activeDIDs.add(pair.receiver.toString());
  }

  // Identify orphaned DIDs (peer DIDs not in any active connection)
  const orphanedDIDs: string[] = [];
  const missingKeys: string[] = [];

  for (const did of peerDIDs) {
    const didString = did.toString();

    // Check if DID is part of an active connection
    if (!activeDIDs.has(didString)) {
      orphanedDIDs.push(didString);

      // Check if we have private keys for this DID
      try {
        const privateKeys = await agent.pluto.getDIDPrivateKeys(did);
        if (!privateKeys || privateKeys.length === 0) {
          missingKeys.push(didString);
        }
      } catch (error) {
        // Error retrieving keys = likely missing
        missingKeys.push(didString);
      }
    }
  }

  const report: OrphanedDIDReport = {
    totalPeerDIDs: peerDIDs.length,
    activeConnections: allPairs.length,
    orphanedDIDs,
    missingKeys,
    recommendation: orphanedDIDs.length > 0
      ? `Found ${orphanedDIDs.length} orphaned peer DID(s). Run cleanupOrphanedPeerDIDs() to remove them.`
      : 'No orphaned peer DIDs found. Wallet is clean!'
  };

  console.log('📊 [Cleanup] Scan complete:');
  console.log(`   Total Peer DIDs: ${report.totalPeerDIDs}`);
  console.log(`   Active Connections: ${report.activeConnections}`);
  console.log(`   Orphaned DIDs: ${report.orphanedDIDs.length}`);
  console.log(`   Missing Keys: ${report.missingKeys.length}`);
  console.log(`   Recommendation: ${report.recommendation}`);

  return report;
}

/**
 * Remove orphaned peer DIDs from wallet and mediator key list
 *
 * This will:
 * 1. Scan for orphaned peer DIDs (no active connection)
 * 2. Remove them from Pluto database
 * 3. Update mediator key list to stop receiving messages for them
 *
 * @param dryRun - If true, only scan and report, don't delete (default: false)
 * @returns Report of cleanup operation
 */
export async function cleanupOrphanedPeerDIDs(dryRun: boolean = false): Promise<OrphanedDIDReport> {
  const agent = getAgent();

  if (!agent) {
    throw new Error('Agent not initialized. Start wallet first.');
  }

  // First, scan to identify orphaned DIDs
  const report = await scanOrphanedPeerDIDs();

  if (report.orphanedDIDs.length === 0) {
    console.log('✅ [Cleanup] No orphaned peer DIDs to clean up');
    return report;
  }

  if (dryRun) {
    console.log('🔍 [Cleanup] DRY RUN - Would delete these DIDs:');
    report.orphanedDIDs.forEach((did, index) => {
      console.log(`   ${index + 1}. ${did.substring(0, 50)}...`);
    });
    return report;
  }

  console.log(`🧹 [Cleanup] Removing ${report.orphanedDIDs.length} orphaned peer DID(s)...`);

  let removedCount = 0;
  const errors: string[] = [];

  for (const didString of report.orphanedDIDs) {
    try {
      const did = SDK.Domain.DID.fromString(didString);

      // Remove DID from Pluto database
      await agent.pluto.deletePeerDID(did);

      console.log(`✅ [Cleanup] Removed orphaned DID: ${didString.substring(0, 50)}...`);
      removedCount++;
    } catch (error: any) {
      const errorMsg = `Failed to remove ${didString}: ${error.message}`;
      console.error(`❌ [Cleanup] ${errorMsg}`);
      errors.push(errorMsg);
    }
  }

  // After removing orphaned DIDs, update mediator key list
  // This ensures mediator stops sending messages for those DIDs
  try {
    console.log('🔄 [Cleanup] Updating mediator key list...');

    // Get current active DIDs (excluding the ones we just removed)
    const updatedDIDs = await agent.pluto.getDIDs();
    const activePeerDIDs = updatedDIDs.filter(did => did.method === 'peer');

    // Update mediator with only active DIDs
    if (agent.connectionManager && agent.connectionManager.mediationHandler) {
      await agent.connectionManager.mediationHandler.updateKeyListWithDIDs(activePeerDIDs);
      console.log('✅ [Cleanup] Mediator key list updated');
    } else {
      console.warn('⚠️ [Cleanup] Could not update mediator key list (mediator not available)');
    }
  } catch (error: any) {
    console.error(`❌ [Cleanup] Failed to update mediator key list: ${error.message}`);
    errors.push(`Mediator update failed: ${error.message}`);
  }

  console.log('🎉 [Cleanup] Cleanup complete:');
  console.log(`   Removed: ${removedCount}/${report.orphanedDIDs.length} orphaned DIDs`);
  if (errors.length > 0) {
    console.log(`   Errors: ${errors.length}`);
    errors.forEach(err => console.log(`     - ${err}`));
  }

  return {
    ...report,
    recommendation: removedCount > 0
      ? `Successfully removed ${removedCount} orphaned peer DID(s). Log flooding should stop.`
      : 'Cleanup encountered errors. Check console for details.'
  };
}

/**
 * Interactive cleanup prompt for browser console
 *
 * Asks user for confirmation before removing orphaned DIDs
 *
 * @returns Report of cleanup operation
 */
export async function interactiveCleanup(): Promise<OrphanedDIDReport> {
  console.log('🔍 [Interactive Cleanup] Starting scan...');

  // First, scan for orphaned DIDs
  const report = await scanOrphanedPeerDIDs();

  if (report.orphanedDIDs.length === 0) {
    console.log('✅ [Interactive Cleanup] No orphaned peer DIDs found. Wallet is clean!');
    return report;
  }

  console.log('⚠️ [Interactive Cleanup] Found orphaned DIDs:');
  report.orphanedDIDs.forEach((did, index) => {
    const hasKeys = !report.missingKeys.includes(did);
    console.log(`   ${index + 1}. ${did.substring(0, 50)}... ${hasKeys ? '(has keys)' : '(MISSING KEYS)'}`);
  });

  console.log('');
  console.log('To remove these orphaned DIDs, run:');
  console.log('  cleanupOrphanedPeerDIDs()');
  console.log('');
  console.log('To preview without deleting, run:');
  console.log('  cleanupOrphanedPeerDIDs(true)');

  return report;
}

/**
 * Export cleanup functions to browser console (for manual use)
 *
 * Usage in browser console:
 * ```
 * // Scan for orphaned DIDs
 * await window.scanOrphanedPeerDIDs();
 *
 * // Preview cleanup (dry run)
 * await window.cleanupOrphanedPeerDIDs(true);
 *
 * // Perform cleanup
 * await window.cleanupOrphanedPeerDIDs();
 *
 * // Interactive prompt
 * await window.interactiveCleanup();
 * ```
 */
if (typeof window !== 'undefined') {
  (window as any).scanOrphanedPeerDIDs = scanOrphanedPeerDIDs;
  (window as any).cleanupOrphanedPeerDIDs = cleanupOrphanedPeerDIDs;
  (window as any).interactiveCleanup = interactiveCleanup;

  console.log('🔧 [Cleanup Utility] Functions exported to window:');
  console.log('   - window.scanOrphanedPeerDIDs()');
  console.log('   - window.cleanupOrphanedPeerDIDs(dryRun?)');
  console.log('   - window.interactiveCleanup()');
}
