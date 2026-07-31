import { useEffect, useState } from 'react';
import { useMountedApp } from '../reducers/store';
// Photo caches were raw localStorage — i.e. shared with v1 on this origin.
import { getItem, setItem, removeItem } from '@/utils/prefixedStorage';

// Two-tier cache:
//   DID → endpoint URL  (short TTL — picks up DID document updates quickly)
//   iagonFileId → dataUrl  (long TTL — avoids re-downloading unchanged images)
const DID_ENDPOINT_PREFIX = 'photo-did-endpoint-';
const IMAGE_DATA_PREFIX = 'photo-image-data-';
const DID_ENDPOINT_TTL_MS = 60 * 60 * 1000;        // 1 hour
const IMAGE_DATA_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const CA_PHOTO_CURRENT_BASE = 'https://identuslabel.cz/ca/photo-current/';

interface EndpointCacheEntry {
  endpointUrl: string;
  cachedAt: number;
}

interface ImageCacheEntry {
  dataUrl: string;
  cachedAt: number;
}

function readEndpointCache(photoDID: string): string | null {
  try {
    const raw = getItem(DID_ENDPOINT_PREFIX + photoDID);
    if (!raw) return null;
    const entry: EndpointCacheEntry = JSON.parse(raw);
    if (Date.now() - entry.cachedAt > DID_ENDPOINT_TTL_MS) {
      removeItem(DID_ENDPOINT_PREFIX + photoDID);
      return null;
    }
    return entry.endpointUrl;
  } catch {
    return null;
  }
}

function writeEndpointCache(photoDID: string, endpointUrl: string): void {
  try {
    const entry: EndpointCacheEntry = { endpointUrl, cachedAt: Date.now() };
    setItem(DID_ENDPOINT_PREFIX + photoDID, entry);
  } catch {
    // ignore quota errors
  }
}

function readImageCache(cacheKey: string): string | null {
  try {
    const raw = getItem(IMAGE_DATA_PREFIX + cacheKey);
    if (!raw) return null;
    const entry: ImageCacheEntry = JSON.parse(raw);
    if (Date.now() - entry.cachedAt > IMAGE_DATA_TTL_MS) {
      removeItem(IMAGE_DATA_PREFIX + cacheKey);
      return null;
    }
    return entry.dataUrl;
  } catch {
    return null;
  }
}

function writeImageCache(cacheKey: string, dataUrl: string): void {
  try {
    const entry: ImageCacheEntry = { dataUrl, cachedAt: Date.now() };
    setItem(IMAGE_DATA_PREFIX + cacheKey, entry);
  } catch {
    // ignore quota errors
  }
}

/**
 * Resolves a photo field value to a displayable URL.
 *
 * When uniqueId is provided (from RealPersonIdentity credentialSubject), the CA's
 * /photo-current/:uniqueId endpoint is used directly — same as the employee dashboard.
 * This gives immediate updates after a photo change with no PRISM on-chain delay.
 * X-Photo-Cache-Key header carries the iagonFileId; a new ID on update busts the cache.
 *
 * Without uniqueId, falls back to DID resolution via Castor (short-form for on-chain
 * lookup, long-form fallback if not published).
 */
export function usePhotoDID(photoValue: string | null | undefined, uniqueId?: string): string | null {
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(() => {
    // Eagerly resolve from cache on first render (synchronous)
    if (!photoValue) return null;
    if (photoValue.startsWith('data:image/')) return photoValue;
    if (photoValue.startsWith('did:')) {
      const cachedEndpoint = readEndpointCache(photoValue);
      if (cachedEndpoint) return readImageCache(cachedEndpoint);
    }
    return null;
  });

  // Resolution used to be one-shot: every failure path below either returned silently or
  // only console.warn'd, and nothing ever retried, so a single transient failure left the
  // card stuck on the "DID linked" placeholder until the component happened to remount.
  // That is exactly what happened on 2026-07-31 — the CA's /photo-current hit a 60s Iagon
  // download timeout for one request, and the photo then never appeared again even though
  // the endpoint recovered seconds later and served the image in 0.3s.
  const [attempt, setAttempt] = useState(0);

  // A different credential (or a photo change) is a fresh problem — don't let it inherit an
  // already-exhausted retry budget from the previous value.
  useEffect(() => { setAttempt(0); }, [photoValue, uniqueId]);

  const { agent } = useMountedApp();

  useEffect(() => {
    if (!photoValue) {
      setResolvedUrl(null);
      return;
    }

    // Legacy base64 — use directly
    if (photoValue.startsWith('data:image/')) {
      setResolvedUrl(photoValue);
      return;
    }

    // DID reference
    if (!photoValue.startsWith('did:')) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    // Backoff for transient upstream failures (Iagon download timeouts, CA restart, an
    // in-place photo DID update that hasn't reached PRISM yet). Bounded on purpose: this
    // hook renders in credential lists and connection avatars, so an unbounded retry would
    // become a request storm across every visible card.
    const RETRY_DELAYS_MS = [2000, 6000, 18000];
    const shortId = photoValue.substring(0, 48);
    function retryOrGiveUp(reason: string) {
      if (cancelled) return;
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        console.warn(`[usePhotoDID] Gave up after ${attempt + 1} attempts (${reason}) for ${shortId}`);
        return;
      }
      console.warn(`[usePhotoDID] ${reason} — retry ${attempt + 1}/${RETRY_DELAYS_MS.length} in ${delay}ms for ${shortId}`);
      retryTimer = setTimeout(() => setAttempt(a => a + 1), delay);
    }

    // --- Path 1: CA stable endpoint (when uniqueId is available) ---
    // Bypasses DID resolution entirely. The CA returns the current photo regardless
    // of PRISM on-chain state, identical to how the employee dashboard works.
    // X-Photo-Cache-Key = iagonFileId; changes on each photo update → cache busted.
    const cleanUniqueId = uniqueId && uniqueId !== 'N/A' ? uniqueId : null;
    if (cleanUniqueId) {
      (async () => {
        try {
          const resp = await fetch(CA_PHOTO_CURRENT_BASE + encodeURIComponent(cleanUniqueId));
          if (cancelled) return;
          if (resp.ok) {
            const cacheKey = resp.headers.get('X-Photo-Cache-Key') || cleanUniqueId;
            const cachedImage = readImageCache(cacheKey);
            if (cachedImage) {
              if (!cancelled) setResolvedUrl(cachedImage);
              return;
            }
            const blob = await resp.blob();
            if (cancelled) return;
            const reader = new FileReader();
            reader.onload = () => {
              const dataUrl = reader.result as string;
              writeImageCache(cacheKey, dataUrl);
              if (!cancelled) setResolvedUrl(dataUrl);
            };
            reader.readAsDataURL(blob);
            return;
          }
          // Non-2xx (e.g. the CA's 500 when its own Iagon download times out) is transient,
          // not a reason to stop — record it so the DID path failing too still gets a retry.
          console.warn(`[usePhotoDID] /photo-current returned ${resp.status} for ${cleanUniqueId}`);
        } catch (e) {
          // Was a bare silent catch — a network failure here looked identical to "no photo".
          console.warn('[usePhotoDID] /photo-current fetch failed:', (e as Error)?.message);
        }
        if (!cancelled) fallbackToDID();
      })();
    } else {
      fallbackToDID();
    }

    // --- Path 2: DID resolution via Castor ---
    function fallbackToDID() {
      const agentInstance = agent?.instance;
      if (!agentInstance) {
        // Cards can render before the agent finishes starting. This used to return silently
        // and never come back, so a photo whose Path 1 also failed stayed blank for the whole
        // session. `agent` is in the dep array, so a retry here bridges the gap either way.
        retryOrGiveUp('agent not ready');
        return;
      }

      (async () => {
        try {
          // Short-form DID forces on-chain lookup, picking up DID document updates.
          // Long-form resolves from the embedded genesis document — never reflects updates.
          const shortFormDid = photoValue.startsWith('did:prism:') && photoValue.split(':').length > 3
            ? photoValue.split(':').slice(0, 3).join(':')
            : photoValue;

          let didDoc: any;
          try {
            didDoc = await agentInstance.castor.resolveDID(shortFormDid);
          } catch {
            // Not yet published — fall back to local genesis resolution
            didDoc = await agentInstance.castor.resolveDID(photoValue);
          }
          if (cancelled) return;

          const services: any[] = (didDoc as any).services ?? [];
          const photoService = services.find(
            (s: any) => typeof s.id === 'string' &&
              (s.id === 'photo' || s.id === '#photo' || s.id.endsWith('#photo'))
          );
          if (!photoService) {
            // An in-place photo DID update that hasn't reached PRISM yet resolves to a
            // document without the new service — retry rather than give up immediately.
            retryOrGiveUp('no #photo service in DID document');
            return;
          }

          const endpoint = photoService.serviceEndpoint;
          const rawEndpoint = Array.isArray(endpoint) ? endpoint[0] : endpoint;
          const proxyUrl = typeof rawEndpoint === 'string' ? rawEndpoint : rawEndpoint?.uri;
          if (!proxyUrl) {
            retryOrGiveUp('#photo service has no endpoint URL');
            return;
          }

          writeEndpointCache(photoValue, proxyUrl);

          const cachedImage = readImageCache(proxyUrl);
          if (cachedImage) {
            if (!cancelled) setResolvedUrl(cachedImage);
            return;
          }

          const resp = await fetch(proxyUrl);
          if (cancelled) return;
          if (!resp.ok) {
            retryOrGiveUp(`photo proxy fetch failed (${resp.status})`);
            return;
          }

          const blob = await resp.blob();
          if (cancelled) return;

          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            writeImageCache(proxyUrl, dataUrl);
            if (!cancelled) setResolvedUrl(dataUrl);
          };
          reader.readAsDataURL(blob);
        } catch (e) {
          if (!cancelled) {
            retryOrGiveUp(`DID resolution failed (${(e as Error)?.message})`);
          }
        }
      })();
    }

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [photoValue, uniqueId, agent, attempt]);

  return resolvedUrl;
}
