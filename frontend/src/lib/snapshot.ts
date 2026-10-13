/**
 * Static snapshot mode (GitHub Pages build, NEXT_PUBLIC_STATIC_SNAPSHOT=1).
 *
 * Reads are served from files exported verbatim from a running local PLUME API by
 * scripts/export_static_snapshot.py. Writes are refused: there is no backend, no database and no chain
 * behind a static site, so nothing is simulated in the browser. The UI labels the mode everywhere.
 */
import type { IncidentSummary } from "./types";

export const STATIC_SNAPSHOT = process.env.NEXT_PUBLIC_STATIC_SNAPSHOT === "1";
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
export const SNAPSHOT_DATE = process.env.NEXT_PUBLIC_SNAPSHOT_DATE ?? "";
export const REPO_URL = "https://github.com/KaavinB/PLUME";
export const VIDEO_URL = `${BASE_PATH}/demo/plume-demo-final.mp4`;

export const READ_ONLY_MESSAGE =
  "This is a read-only static snapshot hosted on GitHub Pages: there is no backend, database or blockchain behind it, so actions are disabled. Run PLUME locally for the interactive app.";

/** Must match key() in scripts/export_static_snapshot.py. */
export function snapshotKey(path: string): string {
  return path.replace(/^\//, "").replace(/[^A-Za-z0-9._-]+/g, "_") || "_root";
}

export class SnapshotMissing extends Error {}

const cache = new Map<string, Promise<unknown>>();
function load<T>(file: string): Promise<T> {
  if (!cache.has(file)) {
    cache.set(
      file,
      fetch(`${BASE_PATH}/snapshot/${file}`).then((r) => {
        if (!r.ok) throw new SnapshotMissing("Not included in this static snapshot.");
        return r.json();
      }),
    );
  }
  return cache.get(file) as Promise<T>;
}

/** GET /incidents?… is answered from the full exported summary list, with the backend's filter and sort rules. */
async function listIncidents(qs: URLSearchParams) {
  const all = await load<IncidentSummary[]>("api/incidents_all.json");
  const sectors = qs.getAll("sector");
  const q = qs.get("q")?.trim().toLowerCase();
  const sort = qs.get("sort") ?? "priority";
  const limit = Math.min(Number(qs.get("limit") ?? 50), 500);
  const offset = Number(qs.get("offset") ?? 0);
  let rows = all.filter((i) => (!sectors.length || sectors.includes(i.sector ?? "")) && (!q || i.code.toLowerCase().includes(q)));
  const desc = (a: number | null | undefined, b: number | null | undefined) => (b ?? -Infinity) - (a ?? -Infinity);
  const by: Record<string, (a: IncidentSummary, b: IncidentSummary) => number> = {
    priority: (a, b) => desc(a.priority_score, b.priority_score),
    recent: (a, b) => b.last_observed_at.localeCompare(a.last_observed_at),
    rate: (a, b) => desc(a.median_rate_kg_h, b.median_rate_kg_h),
    detections: (a, b) => desc(a.detection_date_count, b.detection_date_count),
  };
  rows = [...rows].sort((a, b) => by[sort](a, b) || a.code.localeCompare(b.code));
  return { total: rows.length, items: rows.slice(offset, offset + limit) };
}

export async function snapshotGet<T>(path: string): Promise<T> {
  const [p, query] = path.split("?");
  if (p === "/incidents" && query !== undefined) return (await listIncidents(new URLSearchParams(query))) as T;
  return load<T>(`api/${snapshotKey(path)}.json`);
}

/** Binary resources (plume rasters, evidence files) keep their API path under snapshot/files/. */
export function snapshotAsset(path: string): string {
  return `${BASE_PATH}/snapshot/files${decodeURIComponent(path)}`;
}

export interface RecordedProof {
  recorded_at: string;
  rpc: string;
  state: string;
  round: number;
  amount: string;
  evidenceHash: string;
  termsHash: string;
  lastDecisionDigest: string;
  provider: string;
  settlement: { status: string; blockNumber: string; gasUsed: string } | null;
}

export function recordedProof(receiptId: string): Promise<RecordedProof> {
  return load<RecordedProof>(`api/chain-proof/${receiptId}.json`);
}
