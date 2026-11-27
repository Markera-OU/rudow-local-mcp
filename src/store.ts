// Loading log files into memory and filtering them.
//
// Files are read fully and re-read whenever their modification time
// changes, so a growing log file is picked up on the next tool call
// without restarting the server. Local log files are small enough for
// this to stay fast; nothing is sent anywhere.

import { existsSync, readFileSync, statSync } from "node:fs";

import type { SourceConfig } from "./config.js";
import { detectFormat, parseLine, type LogEntry, type LogLevel } from "./parser.js";

export interface SourceInfo {
  name: string;
  path: string;
  format: string;
  entries: number;
  unparsed: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  exists: boolean;
  error?: string;
}

export interface QueryFilter {
  level?: LogLevel;
  source?: string;
  text?: string;
  minutes?: number;
  beforeIso?: string;
  limit?: number;
}

interface LoadedSource {
  config: SourceConfig;
  entries: LogEntry[];
  mtimeMs: number;
  format: string;
  error?: string;
}

export class LogStore {
  private sources: LoadedSource[] = [];

  constructor(private configs: SourceConfig[]) {}

  get sourceNames(): string[] {
    return this.configs.map((c) => c.name);
  }

  /** Load (or reload, when a file changed) every configured source. */
  load(): void {
    this.sources = this.configs.map((config) => {
      const previous = this.sources.find((s) => s.config.path === config.path);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(config.path).mtimeMs;
      } catch {
        return {
          config,
          entries: [],
          mtimeMs: 0,
          format: "unparsed",
          error: `Log file not found: ${config.path}`,
        };
      }
      if (previous && previous.mtimeMs === mtimeMs) return previous;
      const text = readFileSync(config.path, "utf-8");
      const lines = text.split("\n").filter((line) => line.trim() !== "");
      const format = detectFormat(lines);
      const entries = lines.map((line, i) => parseLine(line, config.name, i));
      return { config, entries, mtimeMs, format };
    });
  }

  listSources(): SourceInfo[] {
    return this.sources.map((s) => {
      const stamped = s.entries.filter((e) => e.timestamp !== null);
      const first = stamped.length > 0 ? stamped[0].timestamp : null;
      const last = stamped.length > 0 ? stamped[stamped.length - 1].timestamp : null;
      return {
        name: s.config.name,
        path: s.config.path,
        format: s.format,
        entries: s.entries.length,
        unparsed: s.entries.filter((e) => !e.parsed).length,
        firstTimestamp: first ? first.toISOString() : null,
        lastTimestamp: last ? last.toISOString() : null,
        exists: s.error === undefined,
        error: s.error,
      };
    });
  }

  sourceErrors(): string[] {
    return this.sources.filter((s) => s.error).map((s) => s.error as string);
  }

  /** All entries across sources, in file order. */
  allEntries(): LogEntry[] {
    const out: LogEntry[] = [];
    for (const s of this.sources) out.push(...s.entries);
    return out;
  }

  /** The newest timestamp across all loaded entries, or null. */
  newestTimestamp(): Date | null {
    let newest: Date | null = null;
    for (const entry of this.allEntries()) {
      if (entry.timestamp && (!newest || entry.timestamp > newest)) {
        newest = entry.timestamp;
      }
    }
    return newest;
  }

  /**
   * Filter entries. A `minutes` window is measured back from the newest
   * entry in the loaded files, not from wall-clock time: local log files
   * are often older than the moment you read them, and a window from now
   * would return nothing. Files without timestamps are ordered by file
   * position, so a minutes window keeps the tail of those files.
   */
  filter(options: QueryFilter): LogEntry[] {
    let entries = this.allEntries();
    if (options.source) {
      entries = entries.filter((e) => e.source === options.source);
    }
    if (options.level) {
      entries = entries.filter((e) => e.level === options.level);
    }
    if (options.text) {
      const needle = options.text.toLowerCase();
      entries = entries.filter(
        (e) =>
          e.message.toLowerCase().includes(needle) ||
          e.raw.toLowerCase().includes(needle),
      );
    }
    if (options.beforeIso) {
      const before = new Date(options.beforeIso);
      if (!Number.isNaN(before.getTime())) {
        entries = entries.filter((e) => e.timestamp !== null && e.timestamp < before);
      }
    }
    if (options.minutes !== undefined) {
      const newest = this.newestTimestamp();
      if (newest) {
        const cutoff = new Date(newest.getTime() - options.minutes * 60_000);
        entries = entries.filter(
          (e) => e.timestamp === null || e.timestamp >= cutoff,
        );
        // Entries without timestamps have no position in time. Keep only
        // the tail of them, in file order, so the window stays bounded.
        const stamped = entries.filter((e) => e.timestamp !== null);
        const unstamped = entries.filter((e) => e.timestamp === null);
        const keepUnstamped = Math.min(unstamped.length, 200);
        entries = [...stamped, ...unstamped.slice(-keepUnstamped)];
      }
    }
    return entries;
  }

  /** Newest first, capped at `limit`. */
  newestFirst(entries: LogEntry[], limit: number): LogEntry[] {
    const withTime = entries.filter((e) => e.timestamp !== null);
    const withoutTime = entries.filter((e) => e.timestamp === null);
    withTime.sort((a, b) => (b.timestamp as Date).getTime() - (a.timestamp as Date).getTime());
    // Timestamped entries first (newest first), then undated lines in
    // reverse file order so the most recent lines still come first.
    return [...withTime, ...withoutTime.reverse()].slice(0, limit);
  }

  /** Chronological order, for window and timeline views. */
  chronological(entries: LogEntry[]): LogEntry[] {
    const withTime = entries.filter((e) => e.timestamp !== null);
    const withoutTime = entries.filter((e) => e.timestamp === null);
    withTime.sort((a, b) => (a.timestamp as Date).getTime() - (b.timestamp as Date).getTime());
    return [...withTime, ...withoutTime];
  }

  hasSource(name: string): boolean {
    return this.configs.some((c) => c.name === name);
  }

  static exists(path: string): boolean {
    return existsSync(path);
  }
}
