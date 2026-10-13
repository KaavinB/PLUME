import { useCallback, useSyncExternalStore } from "react";

const EVENT = "plume-storage";

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable (private mode / blocked): value lasts for this page only */
  }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

/** localStorage-backed value that is SSR-safe (server snapshot = `serverValue`). */
export function useStoredValue(key: string, serverValue: string | null = null): [string | null, (v: string | null) => void] {
  const value = useSyncExternalStore(subscribe, () => read(key), () => serverValue);
  const set = useCallback((v: string | null) => writeStorage(key, v), [key]);
  return [value, set];
}
