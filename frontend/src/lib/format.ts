export function fmtNum(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtCompact(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(v);
}

export function fmtDate(v: string | number | null | undefined, withTime = false): string {
  if (v === null || v === undefined) return "—";
  const d = typeof v === "number" ? new Date(v * 1000) : new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  const date = d.toISOString().slice(0, 10);
  return withTime ? `${date} ${d.toISOString().slice(11, 16)} UTC` : date;
}

export function fmtEth(wei: string | number | null | undefined): string {
  if (wei === null || wei === undefined) return "—";
  const n = Number(BigInt(String(wei)) / 10n ** 12n) / 1e6;
  return `${n.toLocaleString("en-US", { maximumFractionDigits: 4 })} ETH`;
}

export function short(hash: string | null | undefined, n = 6): string {
  if (!hash) return "—";
  return hash.length > 2 * n + 2 ? `${hash.slice(0, n + 2)}…${hash.slice(-n)}` : hash;
}

export function fmtCoord(lat: number, lon: number): string {
  return `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? "E" : "W"}`;
}

export const INSTRUMENTS: Record<string, string> = {
  GAO: "GAO · airborne",
  ang: "AVIRIS-NG · airborne",
  av3: "AVIRIS-3 · airborne",
  emi: "EMIT · ISS",
  tan: "Tanager-1 · satellite",
  ssc: "SSC",
};

export const SECTORS: Record<string, string> = {
  "1B2": "Oil & gas",
  "6A": "Landfill",
  "6B": "Wastewater",
  "4B": "Livestock",
  "1B1a": "Coal mining",
  "1A1": "Power",
  none: "Not assigned",
};

export function sectorName(code: string | null | undefined): string {
  return SECTORS[code ?? "none"] ?? code ?? "Not assigned";
}
