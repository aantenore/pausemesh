import type { JsonValue } from "./types.js";

function compareUtf16(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Deterministic JSON serialization for replay comparisons and content-addressed adapter receipts.
 * Object keys use locale-independent UTF-16 ordering, matching JSON canonicalization conventions.
 */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  const entries = Object.entries(value).sort(([left], [right]) => compareUtf16(left, right));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}
