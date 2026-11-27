// Local incident detection.
//
// Deterministic heuristics that mirror Rudow's hosted signals, computed
// only from the loaded log files:
//   - error-rate spike: a time bucket whose error rate is far above the
//     baseline of the buckets around it.
//   - new error strings: error messages in the bucket that never appeared
//     in earlier buckets.
//   - p95 latency rise: bucket p95 latency at least twice the baseline.
//   - traffic drop: bucket volume well below the usual volume.
// A bucket fires an incident when it has enough errors and its error
// rate clearly exceeds baseline. Neighbouring firing buckets merge
// into one incident. Nothing here calls a model or the network.

import type { LogEntry } from "./parser.js";
import {
  errorRate,
  isError,
  latencyStats,
  normalizeMessage,
  round,
  topErrors,
  type ErrorGroup,
} from "./metrics.js";

export interface IncidentSignal {
  signal: string;
  observed: number | string;
  usual: number | string;
  detail: string;
}

export interface IncidentTimelineBucket {
  bucketStart: string;
  bucketEnd: string;
  total: number;
  errors: number;
  errorRate: number;
}

export interface Incident {
  id: string;
  source: string;
  title: string;
  status: string;
  startedAt: string;
  endedAt: string;
  entryCount: number;
  signals: IncidentSignal[];
  topErrors: ErrorGroup[];
  timeline: IncidentTimelineBucket[];
}

interface Bucket {
  start: number;
  end: number;
  entries: LogEntry[];
  errors: LogEntry[];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function bucketWidthMs(spanMs: number): number {
  const target = spanMs / 12;
  const minute = 60_000;
  for (const width of [1, 2, 5, 10, 15, 30, 60, 120, 360, 1440]) {
    if (target <= width * minute) return width * minute;
  }
  return 1440 * minute;
}

function makeBuckets(entries: LogEntry[]): Bucket[] {
  const stamped = entries.filter((e) => e.timestamp !== null);
  if (stamped.length === 0) return [];
  const times = stamped.map((e) => (e.timestamp as Date).getTime());
  const start = Math.min(...times);
  const end = Math.max(...times);
  const width = bucketWidthMs(Math.max(end - start, 60_000));
  const buckets: Bucket[] = [];
  for (let t = start; t <= end; t += width) {
    buckets.push({ start: t, end: Math.min(t + width, end + 1), entries: [], errors: [] });
  }
  for (const entry of stamped) {
    const t = (entry.timestamp as Date).getTime();
    const bucket = buckets[Math.min(Math.floor((t - start) / width), buckets.length - 1)];
    bucket.entries.push(entry);
    if (isError(entry)) bucket.errors.push(entry);
  }
  return buckets;
}

function baselineRates(buckets: Bucket[], index: number): number[] {
  const rates: number[] = [];
  for (let i = 0; i < buckets.length; i += 1) {
    if (i === index) continue;
    if (buckets[i].entries.length >= 3) rates.push(errorRate(buckets[i].entries));
  }
  return rates;
}

function baselineVolumes(buckets: Bucket[], index: number): number[] {
  const volumes: number[] = [];
  for (let i = 0; i < buckets.length; i += 1) {
    if (i === index) continue;
    volumes.push(buckets[i].entries.length);
  }
  return volumes;
}

function baselineP95(buckets: Bucket[], index: number): number | null {
  const values: number[] = [];
  for (let i = 0; i < buckets.length; i += 1) {
    if (i === index) continue;
    const p95 = latencyStats(buckets[i].entries).p95Ms;
    if (p95 !== null) values.push(p95);
  }
  return values.length > 0 ? median(values) : null;
}

function detectForSource(source: string, entries: LogEntry[]): Incident[] {
  const buckets = makeBuckets(entries);
  if (buckets.length < 3) return [];

  const firing: boolean[] = buckets.map((bucket, i) => {
    if (bucket.errors.length < 3) return false;
    if (bucket.entries.length < 5) return false;
    const rate = errorRate(bucket.entries);
    if (rate < 0.25) return false;
    const baseline = Math.max(median(baselineRates(buckets, i)), 0.02);
    return rate >= 2 * baseline;
  });

  const incidents: Incident[] = [];
  let i = 0;
  while (i < buckets.length) {
    if (!firing[i]) {
      i += 1;
      continue;
    }
    let j = i;
    while (j + 1 < buckets.length && firing[j + 1]) j += 1;
    const group = buckets.slice(i, j + 1);
    const groupEntries = group.flatMap((b) => b.entries);
    const groupErrors = group.flatMap((b) => b.errors);
    const observedRate = errorRate(groupEntries);
    const baseline = Math.max(
      median(group.flatMap((_, k) => baselineRates(buckets, i + k))),
      0.02,
    );
    const usualVolume = median(baselineVolumes(buckets, i));
    const groupVolume = groupEntries.length / group.length;
    const groupP95 = latencyStats(groupEntries).p95Ms;
    const usualP95 = baselineP95(buckets, i);

    const signals: IncidentSignal[] = [
      {
        signal: "error_rate_spike",
        observed: round(observedRate, 4),
        usual: round(baseline, 4),
        detail: `${groupErrors.length} of ${groupEntries.length} entries in the window are errors, against a baseline error rate of ${round(baseline * 100, 1)}%.`,
      },
    ];

    const seenBefore = new Set<string>();
    for (let k = 0; k < i; k += 1) {
      for (const err of buckets[k].errors) seenBefore.add(normalizeMessage(err.message));
    }
    const newMessages = new Set<string>();
    for (const err of groupErrors) {
      const key = normalizeMessage(err.message);
      if (!seenBefore.has(key)) newMessages.add(key);
    }
    if (newMessages.size > 0) {
      signals.push({
        signal: "new_error",
        observed: newMessages.size,
        usual: 0,
        detail: `${newMessages.size} error message${newMessages.size === 1 ? "" : "s"} in the window never appeared earlier in the file.`,
      });
    }
    if (groupP95 !== null && usualP95 !== null && usualP95 > 0 && groupP95 >= 2 * usualP95) {
      signals.push({
        signal: "latency_rise",
        observed: groupP95,
        usual: usualP95,
        detail: `p95 latency in the window is ${groupP95} ms, against a baseline of ${usualP95} ms.`,
      });
    }
    if (usualVolume >= 10 && groupVolume <= 0.4 * usualVolume) {
      signals.push({
        signal: "traffic_drop",
        observed: round(groupVolume, 1),
        usual: round(usualVolume, 1),
        detail: `Average entries per bucket fell to ${round(groupVolume, 1)}, against a usual ${round(usualVolume, 1)}.`,
      });
    }

    const top = topErrors(groupEntries, 5);
    const startedAt = new Date(group[0].start).toISOString();
    const endedAt = new Date(group[group.length - 1].end).toISOString();
    const id = `inc-${source}-${group[0].start}`;
    incidents.push({
      id,
      source,
      title: top.length > 0 ? `Error spike: ${top[0].message}` : `Error spike in ${source}`,
      status: "open",
      startedAt,
      endedAt,
      entryCount: groupEntries.length,
      signals,
      topErrors: top,
      timeline: buckets.map((b) => ({
        bucketStart: new Date(b.start).toISOString(),
        bucketEnd: new Date(b.end).toISOString(),
        total: b.entries.length,
        errors: b.errors.length,
        errorRate: round(errorRate(b.entries), 4),
      })),
    });
    i = j + 1;
  }
  return incidents;
}

export function detectIncidents(entries: LogEntry[]): Incident[] {
  const bySource = new Map<string, LogEntry[]>();
  for (const entry of entries) {
    const list = bySource.get(entry.source) ?? [];
    list.push(entry);
    bySource.set(entry.source, list);
  }
  const out: Incident[] = [];
  for (const [source, list] of bySource) {
    out.push(...detectForSource(source, list));
  }
  out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return out;
}
