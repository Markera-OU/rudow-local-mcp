// Log line parsing.
//
// Each line of a log file is turned into a LogEntry. Three shapes are
// recognised, tried in this order:
//   1. JSON lines, with level, message, timestamp, status and route fields
//      where present.
//   2. Apache / Nginx combined access log lines.
//   3. Plain text lines that start with a timestamp (ISO, "YYYY-MM-DD
//      HH:MM:SS", or syslog style), with an optional level token and
//      request details in the rest of the line.
// Lines that match none of these are kept as unparsed entries: they still
// count, and they are still searchable as raw text.

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal" | "unknown";

export type LineFormat = "json" | "access" | "text" | "unparsed";

export interface LogEntry {
  index: number;
  source: string;
  timestamp: Date | null;
  timestampRaw: string | null;
  level: LogLevel;
  message: string;
  raw: string;
  status?: number;
  route?: string;
  method?: string;
  latencyMs?: number;
  parsed: boolean;
  format: LineFormat;
}

const LEVEL_WORDS: Record<string, LogLevel> = {
  debug: "debug",
  info: "info",
  warn: "warn",
  warning: "warn",
  error: "error",
  err: "error",
  fatal: "fatal",
  critical: "fatal",
};

export function normalizeLevel(value: unknown): LogLevel {
  if (typeof value !== "string") return "unknown";
  const lower = value.trim().toLowerCase();
  return LEVEL_WORDS[lower] ?? "unknown";
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

function parseTimestamp(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    // Seconds or milliseconds since the epoch.
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

const ISO_STAMP =
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/;
const DATE_TIME_STAMP = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/;
const SYSLOG_MONTHS =
  "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";

// Apache / Nginx combined log format:
// 203.0.113.10 - - [27/Nov/2026:09:00:00 +0000] "GET /api/orders HTTP/1.1" 200 1234
const ACCESS_RE =
  /^(\S+) \S+ \S+ \[([^\]]+)\] "(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) ([^"\s?]+)(?:\?[^"]*)? [^"]*" (\d{3}) (\S+)(?: "([^"]*)" "([^"]*)")?/;

const ACCESS_MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

function parseAccessTimestamp(raw: string): Date | null {
  const m = /^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})$/.exec(raw);
  if (!m) return null;
  const month = ACCESS_MONTHS[m[2]];
  if (month === undefined) return null;
  const offset = m[7];
  const sign = offset[0] === "-" ? "-" : "+";
  const iso =
    `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[1]}T${m[4]}:${m[5]}:${m[6]}` +
    `${sign}${offset.slice(1, 3)}:${offset.slice(3, 5)}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function levelFromStatus(status: number): LogLevel {
  if (status >= 500) return "error";
  if (status >= 400) return "warn";
  return "info";
}

function tryJson(raw: string, source: string, index: number): LogEntry | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;

  const level = normalizeLevel(obj.level ?? obj.severity ?? obj.lvl);
  const message =
    asString(obj.message) ??
    asString(obj.msg) ??
    asString(obj.log) ??
    asString(obj.error) ??
    trimmed;
  const timestamp = parseTimestamp(
    obj.timestamp ?? obj.time ?? obj.ts ?? obj["@timestamp"] ?? obj.date,
  );
  const status = asNumber(obj.status ?? obj.status_code ?? obj.statusCode);
  const route = asString(obj.route ?? obj.path ?? obj.url);
  const method = asString(obj.method);
  const latencyMs = asNumber(
    obj.latency_ms ?? obj.duration_ms ?? obj.response_time_ms ?? obj.durationMs,
  );

  return {
    index,
    source,
    timestamp,
    timestampRaw: timestamp ? timestamp.toISOString() : null,
    level,
    message,
    raw,
    status,
    route,
    method,
    latencyMs,
    parsed: true,
    format: "json",
  };
}

function tryAccess(raw: string, source: string, index: number): LogEntry | null {
  const m = ACCESS_RE.exec(raw);
  if (!m) return null;
  const timestamp = parseAccessTimestamp(m[2]);
  const status = Number(m[5]);
  const method = m[3];
  const route = m[4];
  return {
    index,
    source,
    timestamp,
    timestampRaw: timestamp ? timestamp.toISOString() : null,
    level: levelFromStatus(status),
    message: `${method} ${route} ${status}`,
    raw,
    status,
    route,
    method,
    parsed: true,
    format: "access",
  };
}

const LEVEL_TOKEN = /\b(FATAL|ERROR|ERR|WARN|WARNING|INFO|DEBUG|TRACE)\b/i;
const LATENCY_RE = /(?:latency|duration)[=: ]?\s*(\d+(?:\.\d+)?)\s?ms/i;
const BARE_LATENCY_RE = /\b(\d+(?:\.\d+)?)\s?ms\b/;
const STATUS_RE = /\bstatus[=: ]?(\d{3})\b/i;
const REQUEST_RE = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^\s"'?]*)/;

function tryText(raw: string, source: string, index: number): LogEntry | null {
  let stamp: string | null = null;
  let rest = raw;
  const iso = ISO_STAMP.exec(raw);
  if (iso) {
    stamp = iso[0];
    rest = raw.slice(iso.index + iso[0].length);
  } else {
    const dt = DATE_TIME_STAMP.exec(raw);
    if (dt) {
      stamp = dt[0];
      rest = raw.slice(dt.index + dt[0].length);
    } else {
      const syslog = new RegExp(
        `^${SYSLOG_MONTHS} \\s*\\d{1,2} \\d{2}:\\d{2}:\\d{2}`,
      ).exec(raw);
      if (syslog) {
        const year = new Date().getUTCFullYear();
        stamp = `${syslog[0]} ${year}`;
        rest = raw.slice(syslog[0].length);
      }
    }
  }
  if (stamp === null) return null;

  const timestamp = parseTimestamp(stamp.replace(" ", "T")) ?? parseTimestamp(stamp);
  const levelMatch = LEVEL_TOKEN.exec(rest);
  const level = levelMatch ? normalizeLevel(levelMatch[1]) : "unknown";
  const latencyMatch = LATENCY_RE.exec(rest) ?? BARE_LATENCY_RE.exec(rest);
  const statusMatch = STATUS_RE.exec(rest);
  const requestMatch = REQUEST_RE.exec(rest);

  let message = rest.trim().replace(/^[:\-|\]]\s*/, "").trim();
  if (message === "") message = raw.trim();

  return {
    index,
    source,
    timestamp,
    timestampRaw: timestamp ? timestamp.toISOString() : null,
    level,
    message,
    raw,
    status: statusMatch ? Number(statusMatch[1]) : undefined,
    route: requestMatch ? requestMatch[2] : undefined,
    method: requestMatch ? requestMatch[1] : undefined,
    latencyMs: latencyMatch ? Number(latencyMatch[1]) : undefined,
    parsed: true,
    format: "text",
  };
}

export function parseLine(raw: string, source: string, index: number): LogEntry {
  const line = raw.replace(/\r$/, "");
  const entry =
    tryJson(line, source, index) ??
    tryAccess(line, source, index) ??
    tryText(line, source, index);
  if (entry) return entry;
  return {
    index,
    source,
    timestamp: null,
    timestampRaw: null,
    level: "unknown",
    message: line,
    raw: line,
    parsed: false,
    format: "unparsed",
  };
}

/** Guess the dominant format of a file from a sample of its lines. */
export function detectFormat(lines: string[]): LineFormat {
  const counts: Record<LineFormat, number> = { json: 0, access: 0, text: 0, unparsed: 0 };
  for (const line of lines.slice(0, 100)) {
    if (line.trim() === "") continue;
    counts[parseLine(line, "", 0).format] += 1;
  }
  const order: LineFormat[] = ["json", "access", "text", "unparsed"];
  let best: LineFormat = "text";
  let bestCount = -1;
  for (const format of order) {
    if (counts[format] > bestCount) {
      best = format;
      bestCount = counts[format];
    }
  }
  return best;
}
