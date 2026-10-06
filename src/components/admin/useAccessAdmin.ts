// React Query wiring of the Admin → Access pages.
//
// Keys start with ACCESS_ADMIN_QUERY_ROOT and the server-issued access
// partition (plan §20), so an entry fetched under one principal / access
// version is never served to another; the app-wide "react-query" purge handler
// clears them on sign-out, account switch and access change anyway.
//
// Mutations run through useMutation so a refused call (401 invalid_session,
// 403 permission_denied, ...) reaches the AccessErrorBridge through the
// MutationCache, exactly like a refused analytics query.

import { useCallback, useEffect, useRef } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useAccess } from "@/hooks/useAccess";
import {
  AccessAdminRequestError,
  describeAccessAdminError,
  fetchAccessCatalog,
  fetchMemberEffectiveAccess,
  listAccessAudit,
  listAccessFunnels,
  listAccessMembers,
  listAccessRoles,
  type AuditPage,
  type AuditQuery,
} from "@/services/accessAdminClient";

export const ACCESS_ADMIN_QUERY_ROOT = "access-admin";
export const AUDIT_PAGE_SIZE = 50;

/** Retry once, and only for failures that are not a decision about the caller:
 * no HTTP answer, or a 5xx. Access refusals (4xx) are final (plan §27 R12). */
export function retryAccessAdminQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= 1) return false;
  if (error instanceof AccessAdminRequestError) return error.status === 0 || error.status >= 500;
  return true;
}

/** Admin data loads only for a resolved, non-legacy member with a partition. */
function useAdminQueryScope() {
  const access = useAccess();
  const ready = access.status === "ok" && !access.legacy && Boolean(access.partition);
  return { partition: access.partition, ready };
}

const FIVE_MINUTES = 5 * 60 * 1000;
const THIRTY_SECONDS = 30 * 1000;

export function useAccessCatalog(enabled = true) {
  const { partition, ready } = useAdminQueryScope();
  return useQuery({
    queryKey: [ACCESS_ADMIN_QUERY_ROOT, partition, "catalog"],
    queryFn: fetchAccessCatalog,
    enabled: ready && enabled,
    staleTime: FIVE_MINUTES,
    retry: retryAccessAdminQuery,
  });
}

export function useAccessMembers(enabled = true) {
  const { partition, ready } = useAdminQueryScope();
  return useQuery({
    queryKey: [ACCESS_ADMIN_QUERY_ROOT, partition, "members"],
    queryFn: listAccessMembers,
    enabled: ready && enabled,
    staleTime: THIRTY_SECONDS,
    retry: retryAccessAdminQuery,
  });
}

export function useAccessRoles(enabled = true) {
  const { partition, ready } = useAdminQueryScope();
  return useQuery({
    queryKey: [ACCESS_ADMIN_QUERY_ROOT, partition, "roles"],
    queryFn: listAccessRoles,
    enabled: ready && enabled,
    staleTime: THIRTY_SECONDS,
    retry: retryAccessAdminQuery,
  });
}

export function useAccessFunnels(enabled = true) {
  const { partition, ready } = useAdminQueryScope();
  return useQuery({
    queryKey: [ACCESS_ADMIN_QUERY_ROOT, partition, "funnels"],
    queryFn: listAccessFunnels,
    enabled: ready && enabled,
    staleTime: FIVE_MINUTES,
    retry: retryAccessAdminQuery,
  });
}

export function useMemberEffectiveAccess(memberId: string | null, enabled = true) {
  const { partition, ready } = useAdminQueryScope();
  return useQuery({
    queryKey: [ACCESS_ADMIN_QUERY_ROOT, partition, "effective", memberId ?? ""],
    queryFn: () => fetchMemberEffectiveAccess(memberId as string),
    enabled: ready && enabled && Boolean(memberId),
    staleTime: THIRTY_SECONDS,
    retry: retryAccessAdminQuery,
  });
}

export function useAccessAudit(filters: Pick<AuditQuery, "event" | "outcome">, enabled = true) {
  const { partition, ready } = useAdminQueryScope();
  return useInfiniteQuery({
    queryKey: [ACCESS_ADMIN_QUERY_ROOT, partition, "audit", filters.event ?? "", filters.outcome ?? ""],
    queryFn: ({ pageParam }) =>
      listAccessAudit({ limit: AUDIT_PAGE_SIZE, before_id: pageParam, event: filters.event, outcome: filters.outcome }),
    initialPageParam: null as number | null,
    getNextPageParam: (last: AuditPage) => last.next_before_id ?? null,
    enabled: ready && enabled,
    staleTime: THIRTY_SECONDS,
    retry: retryAccessAdminQuery,
  });
}

/** Toasts a load failure once per error object (pages also show it inline). */
export function useAccessAdminErrorToast(title: string, error: unknown) {
  const { toast } = useToast();
  const shown = useRef<unknown>(null);
  useEffect(() => {
    if (!error || shown.current === error) return;
    shown.current = error;
    toast({ title, description: describeAccessAdminError(error), variant: "destructive" });
  }, [error, title, toast]);
}

/** Runs one admin mutation (any client call) through the MutationCache, then
 * refreshes every admin query (members, roles, effective access, audit). */
export function useAccessAdminMutation() {
  const queryClient = useQueryClient();
  const mutation = useMutation<unknown, Error, () => Promise<unknown>>({ mutationFn: (task) => task() });
  const { mutateAsync } = mutation;
  const run = useCallback(
    async <T,>(task: () => Promise<T>): Promise<T> => {
      try {
        return (await mutateAsync(task)) as T;
      } finally {
        void queryClient.invalidateQueries({ queryKey: [ACCESS_ADMIN_QUERY_ROOT] });
      }
    },
    [mutateAsync, queryClient],
  );
  return { run, pending: mutation.isPending };
}
