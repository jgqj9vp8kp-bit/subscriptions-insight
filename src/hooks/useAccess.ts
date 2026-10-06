import { useContext } from "react";
import { AccessContext, type AccessContextValue } from "@/contexts/accessContext";

/** The current user's workspace access (see AccessProvider). Throws outside the
 * provider, like useAuth — a missing provider is a wiring bug, not "no access". */
export function useAccess(): AccessContextValue {
  const context = useContext(AccessContext);
  if (!context) {
    throw new Error("useAccess must be used inside AccessProvider");
  }
  return context;
}

/** Same as useAccess but returns null outside the provider (components that
 * also render outside the protected tree, e.g. NoAccess). */
export function useOptionalAccess(): AccessContextValue | null {
  return useContext(AccessContext);
}

/** Shorthand for useAccess().can(key). */
export function useCan(key: string): boolean {
  return useAccess().can(key);
}
