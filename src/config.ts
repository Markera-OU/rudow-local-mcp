// Where log files come from.
//
// Priority, highest first:
//   1. CLI arguments: positional paths, or --log <path> (repeatable).
//   2. RUDOW_LOCAL_LOG_PATHS env var, comma separated.
//   3. A JSON config file: --config <path>, RUDOW_LOCAL_CONFIG, or
//      ./rudow-local.json when it exists. The file may hold
//      { "sources": [{ "name": "...", "path": "..." }] } or
//      { "logPaths": ["...", "..."] }.
//   4. Fallback: examples/sample.log shipped with the package, when it
//      exists, so the server works out of the box for a first try.
//
// A source name defaults to the file name without its extension.

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface SourceConfig {
  name: string;
  path: string;
}

export function defaultSourceName(path: string): string {
  const base = basename(path);
  const ext = extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

function normalizePaths(paths: string[]): SourceConfig[] {
  const seen = new Set<string>();
  const out: SourceConfig[] = [];
  for (const raw of paths) {
    const path = resolve(raw.trim());
    if (path === "" || seen.has(path)) continue;
    seen.add(path);
    out.push({ name: defaultSourceName(path), path });
  }
  return out;
}

function readConfigFile(path: string): SourceConfig[] {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return [];
  const obj = data as Record<string, unknown>;
  if (Array.isArray(obj.sources)) {
    const out: SourceConfig[] = [];
    for (const item of obj.sources) {
      if (item !== null && typeof item === "object") {
        const entry = item as Record<string, unknown>;
        if (typeof entry.path === "string" && entry.path.trim() !== "") {
          const path = resolve(entry.path.trim());
          out.push({
            name:
              typeof entry.name === "string" && entry.name.trim() !== ""
                ? entry.name.trim()
                : defaultSourceName(path),
            path,
          });
        }
      }
    }
    return out;
  }
  const list = obj.logPaths ?? obj.paths;
  if (Array.isArray(list)) {
    return normalizePaths(list.filter((p): p is string => typeof p === "string"));
  }
  return [];
}

function parseCliArgs(argv: string[]): { paths: string[]; configPath: string | null } {
  const paths: string[] = [];
  let configPath: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--log" || arg === "--logs") {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        paths.push(next);
        i += 1;
      }
    } else if (arg.startsWith("--log=")) {
      paths.push(arg.slice("--log=".length));
    } else if (arg === "--config") {
      const next = argv[i + 1];
      if (next !== undefined) {
        configPath = next;
        i += 1;
      }
    } else if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
    } else if (!arg.startsWith("-")) {
      paths.push(arg);
    }
  }
  return { paths, configPath };
}

export function sampleLogPath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = join(here, "..", "examples", "sample.log");
  return existsSync(candidate) ? candidate : null;
}

export function resolveSources(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): SourceConfig[] {
  const { paths, configPath } = parseCliArgs(argv);
  if (paths.length > 0) return normalizePaths(paths);

  const envPaths = env.RUDOW_LOCAL_LOG_PATHS;
  if (envPaths && envPaths.trim() !== "") {
    return normalizePaths(envPaths.split(","));
  }

  const configCandidates: string[] = [];
  if (configPath) configCandidates.push(configPath);
  if (env.RUDOW_LOCAL_CONFIG) configCandidates.push(env.RUDOW_LOCAL_CONFIG);
  configCandidates.push(resolve("rudow-local.json"));
  for (const candidate of configCandidates) {
    if (!existsSync(candidate)) continue;
    const sources = readConfigFile(candidate);
    if (sources.length > 0) return sources;
  }

  const sample = sampleLogPath();
  if (sample) return [{ name: "sample", path: sample }];
  return [];
}
