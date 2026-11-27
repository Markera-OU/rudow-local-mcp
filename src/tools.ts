// Tool definitions for the Rudow local MCP server.
//
// Names and input shapes mirror the hosted Rudow MCP server
// (https://mcp.rudow.ai/mcp) wherever the concept applies to local files.
// The hosted server takes a `project_id`; this server takes a `source`
// instead, which names one of the configured log files (see list_sources).
// Hosted-only tools are not listed here: semantic_search needs
// embeddings, and the setup and incident-action tools (create_project,
// resolve_incident, request_postmortem and friends) belong to hosted
// Rudow. list_sources replaces list_projects.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const SOURCE_PROP = {
  type: "string",
  description: "Source name from list_sources, e.g. 'app'. Omit to use all sources.",
};

const MINUTES_PROP = {
  type: "integer",
  maximum: 43200,
  description:
    "Window size in minutes (default 60). Measured back from the newest entry in the loaded files.",
};

export const TOOLS: Tool[] = [
  {
    name: "list_sources",
    description:
      "List the configured log files: name, path, format, entry count and time range. Call this first to get a source name to pass to the other tools.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "query_logs",
    description:
      "Fetch matching log entries, newest first. Use to inspect specific errors or recent activity. Call this when you need the actual log lines.",
    inputSchema: {
      type: "object",
      properties: {
        level: {
          type: "string",
          enum: ["debug", "info", "warn", "error", "fatal"],
          description: "Filter by severity level.",
        },
        source: SOURCE_PROP,
        text: {
          type: "string",
          description: "Case-insensitive substring match on the message.",
        },
        minutes: MINUTES_PROP,
        before_iso: {
          type: "string",
          description: "Only entries before this ISO timestamp (cursor pagination).",
        },
        limit: {
          type: "integer",
          description: "Max rows to return (default 50, max 200).",
        },
      },
    },
  },
  {
    name: "query_logs_batched",
    description:
      "Fetch a time-bucketed sample over a larger window. Useful when logs are high-volume: returns a balanced slice across time buckets instead of only the very latest lines.",
    inputSchema: {
      type: "object",
      properties: {
        source: SOURCE_PROP,
        text: {
          type: "string",
          description: "Optional substring filter across message and raw line.",
        },
        minutes: {
          type: "integer",
          maximum: 43200,
          description: "Window size in minutes (default 60).",
        },
        bucket_minutes: {
          type: "integer",
          description: "Bucket width in minutes (default 5).",
        },
        per_bucket: {
          type: "integer",
          description: "Max rows per bucket (default 20).",
        },
        limit: {
          type: "integer",
          description: "Total max rows returned (default 400).",
        },
      },
    },
  },
  {
    name: "aggregate_logs",
    description:
      "Count log entries grouped by a dimension over a recent window. Call this to spot trends, e.g. error rate or status-code distribution.",
    inputSchema: {
      type: "object",
      properties: {
        group_by: {
          type: "string",
          enum: ["level", "source", "status", "route"],
          description: "Dimension to group counts by.",
        },
        source: SOURCE_PROP,
        minutes: MINUTES_PROP,
      },
      required: ["group_by"],
    },
  },
  {
    name: "metrics_summary",
    description:
      "Computed health overview from the loaded logs: volume, error rate, average and p95 latency where parseable, top routes by traffic and errors, and top error groups. Call this to answer how the app is performing or whether it is healthy.",
    inputSchema: {
      type: "object",
      properties: {
        source: SOURCE_PROP,
        minutes: MINUTES_PROP,
      },
    },
  },
  {
    name: "metrics_overview",
    description:
      "Overview section of metrics: total requests, error count and rate, average and p95 latency, and top error routes. Use this for a quick health snapshot focused on request volume and performance.",
    inputSchema: {
      type: "object",
      properties: {
        source: SOURCE_PROP,
        minutes: MINUTES_PROP,
      },
    },
  },
  {
    name: "metrics_trends",
    description:
      "Trends section: request volume, error rate, and latency over time in bucketed intervals. Call this to understand how performance has changed and spot degradation or recovery patterns.",
    inputSchema: {
      type: "object",
      properties: {
        source: SOURCE_PROP,
        minutes: MINUTES_PROP,
      },
    },
  },
  {
    name: "metrics_distributions",
    description:
      "Response time distribution: histogram showing the spread of latencies (p50, p75, p90, p95, p99). Use this to understand if latency is consistent or if there are outliers and slow queries.",
    inputSchema: {
      type: "object",
      properties: {
        source: SOURCE_PROP,
        minutes: MINUTES_PROP,
      },
    },
  },
  {
    name: "metrics_routes",
    description:
      "Top routes by request volume and error count. Shows which endpoints are getting the most traffic and which are failing most often. Use this to identify hot spots and problem areas.",
    inputSchema: {
      type: "object",
      properties: {
        source: SOURCE_PROP,
        minutes: MINUTES_PROP,
      },
    },
  },
  {
    name: "metrics_levels",
    description:
      "Distribution of log levels: count and percentage of debug, info, warn, error, and fatal entries. Use this to understand the severity profile of logs and if error rates are elevated.",
    inputSchema: {
      type: "object",
      properties: {
        source: SOURCE_PROP,
        minutes: MINUTES_PROP,
      },
    },
  },
  {
    name: "route_drilldown",
    description:
      "Deep dive into a specific route: request count, error rate, average and p95 latency, errors by status code. Call this after seeing a problematic route in metrics_routes to get details.",
    inputSchema: {
      type: "object",
      properties: {
        route: {
          type: "string",
          description: "The route path to drill down into, e.g. '/api/checkout'.",
        },
        source: SOURCE_PROP,
        minutes: MINUTES_PROP,
      },
      required: ["route"],
    },
  },
  {
    name: "fetch_window",
    description:
      "Fetch the log entries immediately before and after a timestamp, to see the context around a specific event.",
    inputSchema: {
      type: "object",
      properties: {
        around_iso: {
          type: "string",
          description: "ISO-8601 timestamp to center the window on.",
        },
        n: {
          type: "integer",
          description: "Entries on each side (default 10, max 50).",
        },
        source: SOURCE_PROP,
      },
      required: ["around_iso"],
    },
  },
  {
    name: "list_incidents",
    description:
      "List incidents detected in the local log files (newest first). Detection is deterministic: an error-rate spike against the surrounding baseline, with new error strings, latency rise and traffic drop as supporting signals. Use to answer what broke recently.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["open", "resolved"],
          description: "Locally detected incidents are always open; 'resolved' returns none.",
        },
        source: SOURCE_PROP,
      },
    },
  },
  {
    name: "get_incident",
    description:
      "Full detail of one incident: why it fired (signals with observed vs usual), top error groups, timeline.",
    inputSchema: {
      type: "object",
      properties: {
        incident_id: { type: "string" },
        source: SOURCE_PROP,
      },
      required: ["incident_id"],
    },
  },
];
