import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

type Kind = "incidents" | "investigations" | "projects" | "receipts";

/**
 * Pre-rendered ids for the static GitHub Pages build (from frontend/snapshot/index.json, written by
 * scripts/export_static_snapshot.py). In the normal server build this returns [] and pages render on demand.
 */
export function staticParams<K extends string>(kind: Kind, param: K): Record<K, string>[] {
  if (process.env.NEXT_PUBLIC_STATIC_SNAPSHOT !== "1") return [];
  const file = path.join(process.cwd(), "snapshot", "index.json");
  if (!existsSync(file)) throw new Error("snapshot/index.json missing — run scripts/export_static_snapshot.py first");
  const ids: string[] = JSON.parse(readFileSync(file, "utf8"))[kind];
  return ids.map((id) => ({ [param]: id }) as Record<K, string>);
}
