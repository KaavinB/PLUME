"use client";

import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useSyncExternalStore, type ReactNode } from "react";

import { apiGet, apiPost, setToken, TOKEN_STORAGE_KEY } from "./api";
import { useStoredValue } from "./storage";
import type { Meta, User } from "./types";

let browserClient: QueryClient | undefined;
function getQueryClient() {
  if (typeof window === "undefined") return new QueryClient();
  browserClient ??= new QueryClient({
    defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: false, retry: 1 } },
  });
  return browserClient;
}

interface SessionValue {
  user: User | null;
  ready: boolean;
  loginAs: (persona: string) => Promise<void>;
  logout: () => void;
}

const SessionContext = createContext<SessionValue>({ user: null, ready: false, loginAs: async () => {}, logout: () => {} });

function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [token] = useStoredValue(TOKEN_STORAGE_KEY);
  const me = useQuery({
    queryKey: ["me", token],
    queryFn: async () => {
      try {
        return await apiGet<User>("/auth/me");
      } catch (e) {
        setToken(null); // expired or unknown: fall back to guest
        throw e;
      }
    },
    enabled: !!token,
    retry: 0,
    staleTime: Infinity,
  });
  const user = token ? (me.data ?? null) : null;
  const ready = !token || !me.isPending;

  const loginAs = useCallback(
    async (persona: string) => {
      const res = await apiPost<{ token: string; user: User }>("/auth/demo-login", { persona });
      qc.setQueryData(["me", res.token], res.user);
      setToken(res.token);
      await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "me" });
    },
    [qc],
  );

  const logout = useCallback(() => {
    setToken(null);
    void qc.invalidateQueries();
  }, [qc]);

  return <SessionContext.Provider value={{ user, ready, loginAs, logout }}>{children}</SessionContext.Provider>;
}

const noopSubscribe = () => () => {};

/** True only after hydration. Every page is driven by client-side API data and browser state
 *  (persona token, cached queries), so content renders after hydration to avoid mismatches. */
export function useHydrated(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

function ClientGate({ children }: { children: ReactNode }) {
  const hydrated = useHydrated();
  return hydrated ? children : <div className="h-dvh bg-bg" aria-busy="true" />;
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={getQueryClient()}>
      <ClientGate>
        <SessionProvider>{children}</SessionProvider>
      </ClientGate>
    </QueryClientProvider>
  );
}

export function useSession() {
  return useContext(SessionContext);
}

export function useMeta() {
  return useQuery({ queryKey: ["meta"], queryFn: () => apiGet<Meta>("/meta"), refetchInterval: 20_000 });
}
