// Bootstraps analytics cache persistence for Cohorts, Users, and Payment Pass
// Analytics. Mounted high in the tree (inside auth + query providers). On the
// authenticated user becoming known it restores that user's persisted analytics
// cache and starts saving changes; on an account change or logout it clears the
// previous user's persisted AND in-memory analytics cache so one user can never
// see another user's cached analytics.

import { useEffect, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import {
  hashUserScope,
  WAREHOUSE_ANALYTICS_INVALIDATED_EVENT,
  WAREHOUSE_DEPENDENT_ROOTS,
  WAREHOUSE_VERSION_KEY,
} from "@/services/analyticsCache";
import {
  clearPersistedAnalyticsCache,
  restoreAnalyticsCache,
  startAnalyticsCachePersistence,
} from "@/services/analyticsCachePersistence";
import { traceEvent, traceMark, traceMeasure } from "@/services/performanceTrace";

export function AnalyticsCacheGate({ children = null }: { children?: ReactNode }): ReactNode {
  const client = useQueryClient();
  const { user, loading } = useAuth();
  const scope = user?.id ? hashUserScope(user.id) : null;
  const scopeRef = useRef<string | null>(scope);
  scopeRef.current = scope;
  const prevScopeRef = useRef<string | null>(null);
  const restoredScopeRef = useRef<string | null>(null);
  const mountedRef = useRef(false);

  if (!mountedRef.current) {
    mountedRef.current = true;
    traceMark("analytics_cache_gate.mounted");
  }

  // Hydrate synchronously during render, before route children create their
  // queries. This keeps persisted aggregate snapshots visible on the first
  // protected-route render instead of waiting for a post-render effect.
  if (!loading) {
    if (scope && restoredScopeRef.current !== scope) {
      if (prevScopeRef.current !== null && prevScopeRef.current !== scope) {
        clearPersistedAnalyticsCache();
        for (const root of WAREHOUSE_DEPENDENT_ROOTS) client.removeQueries({ queryKey: [root] });
        client.removeQueries({ queryKey: [...WAREHOUSE_VERSION_KEY] });
        traceEvent("analytics_cache.account_scope_cleared", { previous_scope: "previous_user", next_scope: "next_user" });
      }

      traceMark("analytics_cache.persisted_read_started", { scope: "authenticated" });
      const restored = restoreAnalyticsCache(client, scope);
      traceMark("analytics_cache.persisted_read_completed", { restored });
      traceMeasure("analytics_cache.persisted_read_duration", "analytics_cache.persisted_read_started", "analytics_cache.persisted_read_completed", { restored });
      restoredScopeRef.current = scope;
      prevScopeRef.current = scope;
    } else if (!scope && prevScopeRef.current !== null) {
      clearPersistedAnalyticsCache();
      for (const root of WAREHOUSE_DEPENDENT_ROOTS) client.removeQueries({ queryKey: [root] });
      client.removeQueries({ queryKey: [...WAREHOUSE_VERSION_KEY] });
      restoredScopeRef.current = null;
      prevScopeRef.current = null;
      traceEvent("analytics_cache.logout_cleared");
    }
  }

  useEffect(() => {
    if (loading || !scope) return undefined;
    traceEvent("analytics_cache.persistence_started", { scope: "authenticated" });
    return startAnalyticsCachePersistence(client, () => scopeRef.current ?? "");
  }, [client, loading, scope]);

  useEffect(() => {
    if (loading || !scope) return undefined;
    const onWarehouseAnalyticsInvalidated = () => {
      void client.invalidateQueries({ queryKey: WAREHOUSE_VERSION_KEY });
      for (const root of WAREHOUSE_DEPENDENT_ROOTS) {
        void client.invalidateQueries({ queryKey: [root] });
      }
      traceEvent("analytics_cache.external_invalidation", { scope: "authenticated" });
    };
    window.addEventListener(WAREHOUSE_ANALYTICS_INVALIDATED_EVENT, onWarehouseAnalyticsInvalidated);
    return () => window.removeEventListener(WAREHOUSE_ANALYTICS_INVALIDATED_EVENT, onWarehouseAnalyticsInvalidated);
  }, [client, loading, scope]);

  return children;
}
