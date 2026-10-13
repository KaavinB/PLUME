import { READ_ONLY_MESSAGE, SnapshotMissing, STATIC_SNAPSHOT, snapshotAsset, snapshotGet } from "./snapshot";
import { writeStorage } from "./storage";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const TOKEN_KEY = "plume.token";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  writeStorage(TOKEN_KEY, token);
}

export const TOKEN_STORAGE_KEY = TOKEN_KEY;

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, detail);
  }
  return res.json() as Promise<T>;
}

function headers(extra?: HeadersInit): HeadersInit {
  const t = getToken();
  return { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(extra ?? {}) };
}

export async function apiGet<T>(path: string): Promise<T> {
  if (STATIC_SNAPSHOT) {
    try {
      return await snapshotGet<T>(path);
    } catch (e) {
      throw new ApiError(404, e instanceof SnapshotMissing ? e.message : String(e));
    }
  }
  const res = await fetch(`${API_URL}/api/v1${path}`, { headers: headers() });
  return parse<T>(res);
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  if (STATIC_SNAPSHOT) throw new ApiError(405, READ_ONLY_MESSAGE);
  const res = await fetch(`${API_URL}/api/v1${path}`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return parse<T>(res);
}

export async function apiPostForm<T>(path: string, form: FormData): Promise<T> {
  if (STATIC_SNAPSHOT) throw new ApiError(405, READ_ONLY_MESSAGE);
  const res = await fetch(`${API_URL}/api/v1${path}`, { method: "POST", headers: headers(), body: form });
  return parse<T>(res);
}

export function apiUrl(path: string): string {
  if (STATIC_SNAPSHOT) return snapshotAsset(path);
  return `${API_URL}/api/v1${path}`;
}
