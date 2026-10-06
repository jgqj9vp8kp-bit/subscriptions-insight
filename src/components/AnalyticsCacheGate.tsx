// Bootstraps analytics cache persistence for Cohorts, Users, and Payment Pass
// Analytics. Mounted high in the tree, inside the auth, access and query
// providers. Once the signed-in user's access has resolved it restores that
// access partition's persisted analytics cache and starts saving changes, and it
// publishes the partition / raw-access flag the IndexedDB dataset caches check.
//
// Clearing is NOT done here: the access layer runs the session purge registry on
// sign-out, account switch and access change (AccessProvider), and the cache
// owners' handlers drop the in-memory cache (App.tsx), the persisted envelopes
// (analyticsCachePersistence) and the IndexedDB datasets — once, before the new
// partition is published. Until access resolves the partition is "" and nothing
// is restored, persisted or read.

import { useEffect, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useOptionalAccess } from "@/hooks/useAccess";
import {
  setActiveCacheAccess,
  WAREHOUSE_ANALYTICS_INVALIDATED_EVENT,
  WAREHOUSE_DEPENDENT_ROOTS,
  WAREHOUSE_VERSION_KEY,
} from "@/services/analyticsCache";
import { restoreAnalyticsCache, startAnalyticsCachePersistence } from "@/services/analyticsCachePersistence";
import { traceEvent, traceMark, traceMeasure } from "@/services/performanceTrace";

export function AnalyticsCacheGate({ children = null }: { children?: ReactNode }): ReactNode {
  const client = useQueryClient();
  const access = useOptionalAccess();
  // buildAccessValue already yields "" for every state that may not load data
  // (loading, signed out, no membership, disabled, error); no provider at all
  // fails closed the same way.
  const partition = access && !access.loading ? access.partition : "";
  const rawAccess = Boolean(partition) && access?.rawAccess === true;
  const partitionRef = useRef(partition);
  partitionRef.current = partition;
  const restoredPartitionRef = useRef<string | null>(null);
  const mountedRef = useRef(false);

  if (!mountedRef.current) {
    mountedRef.current = true;
    traceMark("analytics_cache_gate.mounted");
  }

  // Published during render (idempotent) so the dataset caches see it before
  // any route child — SavedDataAutoLoader, Import — can call them.
  setActiveCacheAccess({ partition, rawAccess });

  // Hydrate synchronously during render, before route children create their
  // queries. This keeps persisted aggregate snapshots visible on the first
  // protected-route render instead of waiting for a post-render effect.
  if (!partition) {
    restoredPartitionRef.current = null;
  } else if (restoredPartitionRef.current !== partition) {
    traceMark("analytics_cache.persisted_read_started", { scope: "authenticated" });
    const restored = restoreAnalyticsCache(client, partition);
    traceMark("analytics_cache.persisted_read_completed", { restored });
    traceMeasure("analytics_cache.persisted_read_duration", "analytics_cache.persisted_read_started", "analytics_cache.persisted_read_completed", { restored });
    restoredPartitionRef.current = partition;
  }

  useEffect(() => {
    if (!partition) return undefined;
    traceEvent("analytics_cache.persistence_started", { scope: "authenticated" });
    return startAnalyticsCachePersistence(client, () => partitionRef.current);
  }, [client, partition]);

  useEffect(() => {
    if (!partition) return undefined;
    const onWarehouseAnalyticsInvalidated = () => {
      void client.invalidateQueries({ queryKey: WAREHOUSE_VERSION_KEY });
      for (const root of WAREHOUSE_DEPENDENT_ROOTS) {
        void client.invalidateQueries({ queryKey: [root] });
      }
      traceEvent("analytics_cache.external_invalidation", { scope: "authenticated" });
    };
    window.addEventListener(WAREHOUSE_ANALYTICS_INVALIDATED_EVENT, onWarehouseAnalyticsInvalidated);
    return () => window.removeEventListener(WAREHOUSE_ANALYTICS_INVALIDATED_EVENT, onWarehouseAnalyticsInvalidated);
  }, [client, partition]);

  return children;
}
