# Rudow Local MCP Server

Let your AI coding agent read your own log files. Ask things like:

- "Why is checkout failing right now?"
- "What is our p95 latency on `/api/checkout`?"
- "Show me the errors around 09:15 today."
- "Are there any incidents in these logs?"

This server runs entirely on your machine. It reads the log files you point it at, parses them in memory, and answers over MCP. No account, no cloud, no network calls, nothing leaves the machine.

It is the free, standalone, local-first sibling of [Rudow](https://rudow.ai), the hosted log observability product. It mirrors the read tools of Rudow's hosted MCP server, with one change: the hosted server takes a `project_id`, this one takes a `source`, which names one of your configured log files.

## Try it in one command

```sh
npx -y rudow-local-mcp
```

With no arguments it loads `examples/sample.log` from the package, a small app log with a baked-in incident: a deploy at 09:15 followed by a database error spike on `/api/checkout`. Point any MCP client at it and ask what broke.

## Install

Requires Node.js 18 or later.

```sh
npm install
npm run build
```

Run it:

```sh
# One file
node dist/index.js /var/log/myapp/app.log

# Several files
node dist/index.js /var/log/myapp/app.log /var/log/myapp/worker.log

# Or with npm start
npm start -- /var/log/myapp/app.log
```

## Configure your log files

Four ways, highest priority first:

1. **Command line arguments.** Paths, or `--log <path>` (repeatable).
2. **Environment variable.** `RUDOW_LOCAL_LOG_PATHS`, comma separated:
   ```sh
   RUDOW_LOCAL_LOG_PATHS=/var/log/myapp/app.log,/var/log/nginx/access.log node dist/index.js
   ```
3. **JSON config file.** `--config <path>`, `RUDOW_LOCAL_CONFIG`, or `./rudow-local.json`:
   ```json
   {
     "sources": [
       { "name": "app", "path": "/var/log/myapp/app.log" },
       { "name": "web", "path": "/var/log/nginx/access.log" }
     ]
   }
   ```
   A plain list works too: `{ "logPaths": ["/var/log/myapp/app.log"] }`.
4. **Fallback.** With nothing configured, the server loads the bundled `examples/sample.log` so it works out of the box.

A source name defaults to the file name without its extension. Files are re-read when they change, so a growing log is picked up on the next tool call without restarting the server.

## Connect your editor

**Claude Code**

```sh
claude mcp add rudow-local --env RUDOW_LOCAL_LOG_PATHS=/var/log/myapp/app.log -- npx -y rudow-local-mcp
```

Or add it to `.mcp.json` in your project:

```json
{
  "mcpServers": {
    "rudow-local": {
      "command": "npx",
      "args": ["-y", "rudow-local-mcp"],
      "env": { "RUDOW_LOCAL_LOG_PATHS": "/var/log/myapp/app.log" }
    }
  }
}
```

**Cursor** (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "rudow-local": {
      "command": "npx",
      "args": ["-y", "rudow-local-mcp"],
      "env": { "RUDOW_LOCAL_LOG_PATHS": "/var/log/myapp/app.log" }
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`):

```json
{
  "servers": {
    "rudow-local": {
      "command": "npx",
      "args": ["-y", "rudow-local-mcp"],
      "env": { "RUDOW_LOCAL_LOG_PATHS": "/var/log/myapp/app.log" }
    }
  }
}
```

**Windsurf** (`~/.codeium/windsurf/mcp_config.json`):

```json
{
  "mcpServers": {
    "rudow-local": {
      "command": "npx",
      "args": ["-y", "rudow-local-mcp"],
      "env": { "RUDOW_LOCAL_LOG_PATHS": "/var/log/myapp/app.log" }
    }
  }
}
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "rudow-local": {
      "command": "npx",
      "args": ["-y", "rudow-local-mcp"],
      "env": { "RUDOW_LOCAL_LOG_PATHS": "/var/log/myapp/app.log" }
    }
  }
}
```

## Supported log formats

The parser auto-detects the format per file, and per line where a file mixes formats:

- **JSON lines**, with `level`, `message`, `timestamp`, `status`, `route`, `method` and latency fields where present. Alternate field names are accepted (`msg` for message, `time` or `ts` for timestamp, `severity` for level, `duration_ms` for latency).
- **Apache / Nginx combined access logs.** The level is derived from the status code (5xx is error, 4xx is warn).
- **Plain text with timestamps.** ISO (`2026-11-27T09:15:00Z`), `YYYY-MM-DD HH:MM:SS`, or syslog style (`Nov 27 09:15:00`), with an optional level token and request details in the rest of the line.

Lines that do not parse are kept as unparsed entries. They still count, and they are still searchable as raw text. `list_sources` reports how many lines per file were unparsed.

## Tools

All tools take an optional `source` (a name from `list_sources`). Omit it to use all sources. Time windows (`minutes`, default 60) are measured back from the newest entry in the loaded files, not from wall-clock time, because local log files are often older than the moment you read them.

| Tool | What it does |
|---|---|
| `list_sources` | Lists the configured log files: name, path, format, entry count, time range, unparsed count. Call this first. |
| `query_logs` | Log entries filtered by level, source, text substring and time window. Newest first. Default 50 rows, max 200. |
| `query_logs_batched` | A time-balanced sample over a larger window, instead of only the latest lines. |
| `aggregate_logs` | Counts grouped by `level`, `source`, `status` or `route`. |
| `metrics_summary` | Health overview: volume, error rate, average and p95 latency where parseable, top routes, top errors. |
| `metrics_overview` | Requests, error count and rate, average and p95 latency, top error routes. |
| `metrics_trends` | Volume, error rate and latency over time in 12 buckets. |
| `metrics_distributions` | Latency percentiles (p50 to p99) and a histogram. |
| `metrics_routes` | Top routes by volume and error count. |
| `metrics_levels` | Breakdown of log levels with counts and shares. |
| `route_drilldown` | Deep dive into one route: requests, error rate, latency, errors by status. |
| `fetch_window` | The log entries just before and after a timestamp. |
| `list_incidents` | Incidents detected in the local logs, newest first. |
| `get_incident` | Why an incident fired (signals with observed vs usual), top error groups, timeline. |

### Incident detection

Detection is deterministic, with no model and no network. Log entries are grouped into time buckets. A bucket fires when it holds at least 3 errors, at least a 25% error rate, and at least twice the baseline error rate (the median of the other buckets). Neighbouring firing buckets merge into one incident. Supporting signals are reported alongside the spike:

- **new_error**: error messages in the window that never appeared earlier in the file.
- **latency_rise**: p95 latency at least twice the baseline.
- **traffic_drop**: volume per bucket at most 40% of the usual volume.

Locally detected incidents are always `open`. There is no resolve action here; that belongs to hosted Rudow.

### Out of scope

- **`semantic_search` is not implemented.** It needs embeddings and a vector store, which do not fit a local, no-network tool. Use `query_logs` with a text substring instead.
- **Hosted setup and incident-action tools are not implemented.** `create_project`, `create_ingest_key`, `check_ingestion`, `resolve_incident`, `request_postmortem` and `update_postmortem` belong to hosted Rudow, where projects, teams and post-mortems live.

## Privacy

Everything runs locally. The server reads only the log files you configure, parses them in memory on your machine, and answers MCP tool calls over stdio. It makes no network calls at all: it imports no HTTP client, needs no account, no API key and no sign-in, and it sends your logs nowhere. Your logs never leave the machine. The only files it reads are the ones you point it at.

## Tests

```sh
npm test
```

This builds the project and runs the test suite: unit tests for parsing, aggregation and incident detection, plus integration tests that spawn the server over stdio and call tools through a real MCP client.

## Going further with Rudow

This tool covers your own log files on your own machine. Hosted [Rudow](https://rudow.ai) adds what a local file reader cannot: live log ingest from your running apps, teams and shared projects, history beyond what is on disk, alerting, automatic incident detection and post-mortems from live logs, and semantic search across everything you have logged. Same idea, same read-only approach, for production systems.

## License

MIT. See [LICENSE](LICENSE).
