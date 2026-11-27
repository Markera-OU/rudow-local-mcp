// Metrics computed from parsed log entries.
//
// Everything here is arithmetic over the loaded entries: counts, rates,
// latency percentiles, and per-route breakdowns. Latency and status
// figures only cover the entries that actually carry those fields;
// the result says how many that was, so a file without latency data
// reports "not available" instead of inventing a number.

import type { LogEntry } from "./parser.js";

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

export function round(n: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

export function isError(entry: LogEntry): boolean {
  return entry.level === "error" || entry.level === "fatal";
}

export function errorRate(entries: LogEntry[]): number {
  if (entries.length === 0) return 0;
  return entries.filter(isError).length / entries.length;
}

export interface LatencyStats {
  count: number;
  averageMs: number | null;
  p50Ms: number | null;
  p75Ms: number | null;
  p90Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

export function latencyStats(entries: LogEntry[]): LatencyStats {
  const values = entries
    .map((e) => e.latencyMs)
    .filter((v): v is number => v !== undefined)
    .sort((a, b) => a - b);
  if (values.length === 0) {
    return { count: 0, averageMs: null, p50Ms: null, p75Ms: null, p90Ms: null, p95Ms: null, p99Ms: null };
  }
  const average = values.reduce((a, b) => a + b, 0) / values.length;
  return {
    count: values.length,
    averageMs: round(average),
    p50Ms: round(percentile(values, 50) as number),
    p75Ms: round(percentile(values, 75) as number),
    p90Ms: round(percentile(values, 90) as number),
    p95Ms: round(percentile(values, 95) as number),
    p99Ms: round(percentile(values, 99) as number),
  };
}

export interface RouteStats {
  route: string;
  requests: number;
  errors: number;
  errorRate: number;
  averageLatencyMs: number | null;
  p95LatencyMs: number | null;
}

export function routeStats(entries: LogEntry[]): RouteStats[] {
  const byRoute = new Map<string, LogEntry[]>();
  for (const entry of entries) {
    if (!entry.route) continue;
    const list = byRoute.get(entry.route) ?? [];
    list.push(entry);
    byRoute.set(entry.route, list);
  }
  const out: RouteStats[] = [];
  for (const [route, list] of byRoute) {
    const lat = latencyStats(list);
    out.push({
      route,
      requests: list.length,
      errors: list.filter(isError).length,
      errorRate: round(errorRate(list), 4),
      averageLatencyMs: lat.averageMs,
      p95LatencyMs: lat.p95Ms,
    });
  }
  out.sort((a, b) => b.requests - a.requests);
  return out;
}

/**
 * Collapse a message into an error group key: numbers, hex ids, UUIDs and
 * quoted values are replaced so the same failure with different ids lands
 * in one group.
 */
export function normalizeMessage(message: string): string {
  return message
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<id>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/"[^"]*"/g, '"<v>"')
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export interface ErrorGroup {
  message: string;
  count: number;
}

export function topErrors(entries: LogEntry[], limit = 10): ErrorGroup[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (!isError(entry)) continue;
    const key = normalizeMessage(entry.message);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([message, count]) => ({ message, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export function levelCounts(entries: LogEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    counts[entry.level] = (counts[entry.level] ?? 0) + 1;
  }
  return counts;
}

export function statusCounts(entries: LogEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    if (entry.status === undefined) continue;
    const key = String(entry.status);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export interface TrendBucket {
  bucketStart: string;
  bucketEnd: string;
  total: number;
  errors: number;
  errorRate: number;
  averageLatencyMs: number | null;
  p95LatencyMs: number | null;
}

/** Split timestamped entries into equal time buckets across their span. */
export function trends(entries: LogEntry[], bucketCount = 12): TrendBucket[] {
  const stamped = entries.filter((e) => e.timestamp !== null);
  if (stamped.length === 0) return [];
  const times = stamped.map((e) => (e.timestamp as Date).getTime());
  const start = Math.min(...times);
  const end = Math.max(...times);
  const span = Math.max(end - start, 1);
  const width = span / bucketCount;
  const buckets: TrendBucket[] = [];
  for (let i = 0; i < bucketCount; i += 1) {
    const bucketStart = start + i * width;
    const bucketEnd = i === bucketCount - 1 ? end + 1 : start + (i + 1) * width;
    const inBucket = stamped.filter((e) => {
      const t = (e.timestamp as Date).getTime();
      return t >= bucketStart && t < bucketEnd;
    });
    const lat = latencyStats(inBucket);
    buckets.push({
      bucketStart: new Date(bucketStart).toISOString(),
      bucketEnd: new Date(bucketEnd).toISOString(),
      total: inBucket.length,
      errors: inBucket.filter(isError).length,
      errorRate: round(errorRate(inBucket), 4),
      averageLatencyMs: lat.averageMs,
      p95LatencyMs: lat.p95Ms,
    });
  }
  return buckets;
}

export interface LatencyHistogramBucket {
  upToMs: number;
  count: number;
}

export function latencyHistogram(entries: LogEntry[]): LatencyHistogramBucket[] {
  const values = entries
    .map((e) => e.latencyMs)
    .filter((v): v is number => v !== undefined);
  const edges = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
  const buckets: LatencyHistogramBucket[] = edges.map((upToMs) => ({ upToMs, count: 0 }));
  buckets.push({ upToMs: Number.POSITIVE_INFINITY, count: 0 });
  for (const value of values) {
    const bucket = buckets.find((b) => value <= b.upToMs) as LatencyHistogramBucket;
    bucket.count += 1;
  }
  return buckets.map((b) => ({
    upToMs: Number.isFinite(b.upToMs) ? b.upToMs : -1,
    count: b.count,
  }));
}
