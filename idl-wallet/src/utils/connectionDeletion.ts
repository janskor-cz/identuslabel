/**
 * Connection Deletion Utility for SDK v6.6.0
 *
 * Provides three deletion methods with fallback chain:
 * 1. Repository Pattern (cleanest, uses SDK's internal API)
 * 2. RxDB Collection Access (direct RxDB with correct collection name)
 * 3. Direct IndexedDB (fallback for maximum compatibility)
 *
 * Required because SDK Pluto class doesn't expose deleteDIDPair() method.
 */

import SDK from "@hyperledger/identus-edge-agent-sdk";

/**
 * Deletes a DIDPair connection using SDK's Repository pattern (PRIMARY METHOD - CLEANEST)
 *
 * @param db - The Pluto database instance
 * @param hostDID - The host DID string to delete
 * @returns Promise<boolean> - True if deletion successful
 */
export async function deleteConnectionUsingRepository(
    db: SDK.Domain.Pluto,
    hostDID: string
): Promise<boolean> {
    try {
        console.log('🗑️ [Repository] Starting Repository-based deletion for:', hostDID.substring(0, 50) + '...');

        // Get the connection details to find UUIDs
        const allConnections = await db.getAllDidPairs();
        const connectionToDelete = allConnections.find(c => c.host.toString() === hostDID);

        if (!connectionToDelete) {
            console.warn('⚠️ [Repository] Connection not found');
            return false;
        }

        const hostUUID = connectionToDelete.host.uuid;
        const receiverUUID = connectionToDelete.receiver.uuid;

        console.log('🔍 [Repository] Found connection details:', {
            name: connectionToDelete.name,
            hostUUID: hostUUID.substring(0, 20) + '...',
            receiverUUID: receiverUUID.substring(0, 20) + '...'
        });

        // Access the internal Repositories (cleanest approach)
        const didLinksRepo = (db as any).Repositories?.DIDLinks;

        if (!didLinksRepo) {
            console.error('❌ [Repository] Unable to access DIDLinks repository');
            return false;
        }

        console.log('✅ [Repository] Successfully accessed DIDLinks repository');

        // Query for DIDLink records with role=1 (pair) matching our DIDs
        const links = await didLinksRepo.getModels({
            selector: {
                role: 1, // pair type
                $or: [
                    { hostId: hostUUID },
                    { targetId: hostUUID }
                ]
            }
        });

        console.log(`🎯 [Repository] Found ${links.length} DIDLink records to delete`);

        if (links.length === 0) {
            console.warn('⚠️ [Repository] No DIDLink records found');
            return false;
        }

        // Delete each record using Repository's delete method
        for (const link of links) {
            await didLinksRepo.delete(link.uuid);
            console.log(`✅ [Repository] Deleted DIDLink: ${link.uuid}`);
        }

        console.log('✅ [Repository] All DIDLink records deleted successfully');

        // ========================================
        // ✅ NEW: DID Reference Checking & Cascade Deletion
        // ========================================
        console.log('🔍 [Repository] Checking if DIDs can be safely deleted...');

        // Get all remaining DIDLinks to check for references
        const allLinks = await didLinksRepo.getModels({
            selector: { role: 1 } // All pair-type links
        });

        console.log(`🔍 [Repository] Found ${allLinks.length} total DIDLink records remaining`);

        // Check if host DID is used by other connections
        const hostUsedElsewhere = allLinks.some(link =>
            link.hostId === hostUUID || link.targetId === hostUUID
        );

        // Check if receiver DID is used by other connections
        const receiverUsedElsewhere = allLinks.some(link =>
            link.hostId === receiverUUID || link.targetId === receiverUUID
        );

        console.log('🔍 [Repository] DID reference check:', {
            hostUUID: hostUUID.substring(0, 20) + '...',
            hostUsedElsewhere,
            receiverUUID: receiverUUID.substring(0, 20) + '...',
            receiverUsedElsewhere
        });

        // Access DID repository
        const didRepo = (db as any).Repositories?.DIDs;

        if (!didRepo) {
            console.warn('⚠️ [Repository] Unable to access DIDs repository, skipping DID deletion');
        } else {
            // Delete host DID only if not used elsewhere
            if (!hostUsedElsewhere) {
                try {
                    await didRepo.delete(hostUUID);
                    console.log(`✅ [Repository] Deleted host DID: ${hostUUID.substring(0, 20)}...`);
                } catch (error) {
                    console.error('❌ [Repository] Failed to delete host DID:', error);
                    throw new Error(`DID deletion failed for host ${hostUUID.substring(0, 20)}: ${error instanceof Error ? error.message : String(error)}`);
                }
            } else {
                console.log(`ℹ️ [Repository] Host DID still used by other connections, keeping: ${hostUUID.substring(0, 20)}...`);
            }

            // Delete receiver DID only if not used elsewhere
            if (!receiverUsedElsewhere) {
                try {
                    await didRepo.delete(receiverUUID);
                    console.log(`✅ [Repository] Deleted receiver DID: ${receiverUUID.substring(0, 20)}...`);
                } catch (error) {
                    console.error('❌ [Repository] Failed to delete receiver DID:', error);
                    throw new Error(`DID deletion failed for receiver ${receiverUUID.substring(0, 20)}: ${error instanceof Error ? error.message : String(error)}`);
                }
            } else {
                console.log(`ℹ️ [Repository] Receiver DID still used by other connections, keeping: ${receiverUUID.substring(0, 20)}...`);
            }
        }

        // ========================================
        // ✅ NEW: Optional Message Deletion
        // ========================================
        const messageRepo = (db as any).Repositories?.Messages;
        if (messageRepo) {
            try {
                console.log('🔍 [Repository] Checking for messages to delete...');

                const messages = await messageRepo.getModels({
                    selector: {
                        $or: [
                            { from: connectionToDelete.host.toString() },
                            { to: connectionToDelete.host.toString() },
                            { from: connectionToDelete.receiver.toString() },
                            { to: connectionToDelete.receiver.toString() }
                        ]
                    }
                });

                console.log(`🔍 [Repository] Found ${messages.length} messages to delete`);

                for (const msg of messages) {
                    await messageRepo.delete(msg.uuid);
                    console.log(`✅ [Repository] Deleted message: ${msg.uuid}`);
                }
            } catch (error) {
                console.error('❌ [Repository] Error deleting messages:', error);
            }
        } else {
            console.log('ℹ️ [Repository] Message repository not available, skipping message deletion');
        }

        console.log('✅ [Repository] Enhanced connection deletion completed successfully');
        return true;

    } catch (error) {
        console.error('❌ [Repository] Error:', error);
        return false;
    }
}

/**
 * Deletes a DIDPair connection using RxDB collections (FALLBACK METHOD 1)
 *
 * @param db - The Pluto database instance
 * @param hostDID - The host DID string to delete
 * @returns Promise<boolean> - True if deletion successful
 */
export async function deleteConnectionUsingRxDB(
    db: SDK.Domain.Pluto,
    hostDID: string
): Promise<boolean> {
    try {
        console.log('🗑️ [RxDB] Starting RxDB-based deletion for:', hostDID.substring(0, 50) + '...');

        // Get the connection details
        const allConnections = await db.getAllDidPairs();
        const connectionToDelete = allConnections.find(c => c.host.toString() === hostDID);

        if (!connectionToDelete) {
            console.warn('⚠️ [RxDB] Connection not found');
            return false;
        }

        const hostUUID = connectionToDelete.host.uuid;
        const receiverUUID = connectionToDelete.receiver.uuid;

        console.log('🔍 [RxDB] Found connection details:', {
            name: connectionToDelete.name,
            hostUUID: hostUUID.substring(0, 20) + '...',
            receiverUUID: receiverUUID.substring(0, 20) + '...'
        });

        // Access RxDB collections through the store
        const store = (db as any).store;

        if (!store || !store.db) {
            console.error('❌ [RxDB] Unable to access RxDB store');
            return false;
        }

        const rxDB = store.db;

        // ✅ CORRECT: Use "did-link" (with hyphen), NOT "didlinks"
        const didLinksCollection = rxDB.collections["did-link"];

        if (!didLinksCollection) {
            console.error('❌ [RxDB] did-link collection not found');
            console.log('🔍 [RxDB] Available collections:', Object.keys(rxDB.collections || {}));
            return false;
        }

        console.log('✅ [RxDB] Successfully accessed did-link collection');

        // Query for DIDLink records matching our connection
        const query = didLinksCollection.find({
            selector: {
                role: 1, // pair type
                $or: [
                    { hostId: hostUUID },
                    { targetId: hostUUID }
                ]
            }
        });

        const linksToDelete = await query.exec();
        console.log(`🎯 [RxDB] Found ${linksToDelete.length} DIDLink records to delete`);

        if (linksToDelete.length === 0) {
            console.warn('⚠️ [RxDB] No DIDLink records found');
            return false;
        }

        // Delete each record
        for (const link of linksToDelete) {
            await link.remove();
            console.log(`✅ [RxDB] Deleted DIDLink:`, link.uuid);
        }

        console.log('✅ [RxDB] All DIDLink records deleted successfully');
        return true;

    } catch (error) {
        console.error('❌ [RxDB] Error:', error);
        return false;
    }
}

/**
 * Deletes a DIDPair connection by directly accessing IndexedDB (FALLBACK METHOD 2)
 *
 * @param db - The Pluto database instance
 * @param hostDID - The host DID string to delete
 * @returns Promise<boolean> - True if deletion successful
 */
export async function deleteConnectionFromIndexedDB(
    db: SDK.Domain.Pluto,
    hostDID: string
): Promise<boolean> {
    try {
        console.log('🗑️ [IndexedDB] Starting direct IndexedDB deletion for:', hostDID.substring(0, 50) + '...');

        // First, get the connection to find both DIDs involved
        const allConnections = await db.getAllDidPairs();
        const connectionToDelete = allConnections.find(c => c.host.toString() === hostDID);

        if (!connectionToDelete) {
            console.warn('⚠️ [IndexedDB] Connection not found:', hostDID.substring(0, 50) + '...');
            return false;
        }

        const hostUUID = connectionToDelete.host.uuid;
        const receiverUUID = connectionToDelete.receiver.uuid;

        console.log('🔍 [IndexedDB] Found connection details:', {
            name: connectionToDelete.name,
            hostUUID: hostUUID.substring(0, 20) + '...',
            receiverUUID: receiverUUID.substring(0, 20) + '...'
        });

        // Determine database name dynamically (or use hardcoded for IDL wallet)
        const dbName = 'identus-wallet-idl';
        console.log('📦 [IndexedDB] Accessing database:', dbName);

        // Open IndexedDB connection directly
        return new Promise<boolean>((resolve, reject) => {
            const request = window.indexedDB.open(dbName);

            request.onsuccess = (event: any) => {
                const idb = event.target.result;
                console.log('✅ [IndexedDB] Opened IndexedDB connection');

                try {
                    // ✅ CORRECT: Use "did-link" (with hyphen) object store name
                    const transaction = idb.transaction(['did-link'], 'readwrite');
                    const objectStore = transaction.objectStore('did-link');

                    // Query for all DIDLink records
                    const getAllRequest = objectStore.getAll();

                    getAllRequest.onsuccess = async () => {
                        const allLinks = getAllRequest.result;
                        console.log(`🔍 [IndexedDB] Found ${allLinks.length} total DIDLink records`);

                        // Filter for records matching our connection (role=1 for pairs)
                        const linksToDelete = allLinks.filter((link: any) => {
                            return link.role === 1 && // role.pair = 1
                                   (link.hostId === hostUUID || link.targetId === hostUUID);
                        });

                        console.log(`🎯 [IndexedDB] Found ${linksToDelete.length} DIDLink records to delete`);

                        if (linksToDelete.length === 0) {
                            console.warn('⚠️ [IndexedDB] No DIDLink records found for this connection');
                            idb.close();
                            resolve(false);
                            return;
                        }

                        // Delete each matching DIDLink record using uuid as key
                        const deletePromises = linksToDelete.map((link: any) => {
                            return new Promise<void>((resolveDelete, rejectDelete) => {
                                // ✅ CORRECT: Use uuid as the primary key
                                const deleteRequest = objectStore.delete(link.uuid);
                                deleteRequest.onsuccess = () => {
                                    console.log(`✅ [IndexedDB] Deleted DIDLink record:`, link.uuid);
                                    resolveDelete();
                                };
                                deleteRequest.onerror = () => {
                                    console.error(`❌ [IndexedDB] Failed to delete DIDLink:`, link.uuid, deleteRequest.error);
                                    rejectDelete(deleteRequest.error);
                                };
                            });
                        });

                        try {
                            await Promise.all(deletePromises);
                            console.log('✅ [IndexedDB] All DIDLink records deleted successfully');
                            idb.close();
                            resolve(true);
                        } catch (error) {
                            console.error('❌ [IndexedDB] Error during DIDLink deletion:', error);
                            idb.close();
                            reject(error);
                        }
                    };

                    getAllRequest.onerror = () => {
                        console.error('❌ [IndexedDB] Failed to query DIDLinks:', getAllRequest.error);
                        idb.close();
                        reject(getAllRequest.error);
                    };
                } catch (error) {
                    console.error('❌ [IndexedDB] Transaction error:', error);
                    idb.close();
                    reject(error);
                }
            };

            request.onerror = () => {
                console.error('❌ [IndexedDB] Failed to open IndexedDB:', request.error);
                reject(request.error);
            };
        });

    } catch (error) {
        console.error('❌ [IndexedDB] Unexpected error:', error);
        return false;
    }
}
