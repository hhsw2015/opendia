// Bridge: expose selected OpenDia browser_* handlers to the Cebian
// sidebar agent as AgentTool[]. Runs in the same SW process — calls go
// through globalThis.__opendiaCallTool (installed by
// src/background/background.js) with zero MCP / WS / daemon involvement.
//
// Two tiers:
//   - CORE: 11 hand-picked tools that fill Cebian gaps and are always
//     visible to the agent. Total system-prompt cost ~3K tokens.
//   - LONG-TAIL: 150+ remaining tools, hidden by default. Reachable via
//     the two meta-tools opendia_list_tools + opendia_call_tool, mirroring
//     the daemon-side CoreToolGate strategy.
//
// User can toggle the whole surface off in Settings > OpenDia Bridge, or
// edit the whitelist to promote/demote tools.
import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { storage } from '#imports';

const OPENDIA_NATIVE_ENABLED_KEY = 'local:opendia:native:enabled';
const OPENDIA_NATIVE_WHITELIST_KEY = 'local:opendia:native:whitelist';

export const opendiaNativeEnabled = storage.defineItem<boolean>(
  OPENDIA_NATIVE_ENABLED_KEY,
  { fallback: true },
);

// Default core whitelist. Users can override via Settings; anything in
// this set is exposed as a first-class AgentTool. Everything else falls
// through to the meta-tool path.
const DEFAULT_CORE_TOOLS = [
  // Chrome data
  'get_bookmarks',
  'get_history',
  'get_cookies',
  'get_downloads',
  // Multi-tab
  'tab_list',
  'tab_switch',
  // Network + console (Cebian has no equivalent)
  'cdp_list_network_requests',
  'cdp_get_response_body',
  'cdp_list_console_messages',
  // React introspection
  'react_get_state',
  'react_find_component',
] as const;

export const opendiaNativeWhitelist = storage.defineItem<string[]>(
  OPENDIA_NATIVE_WHITELIST_KEY,
  { fallback: [...DEFAULT_CORE_TOOLS] },
);

interface OpendiaToolSpec {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

function callNative(name: string, args: unknown): Promise<unknown> {
  const fn = (globalThis as any).__opendiaCallTool as
    | ((n: string, a: unknown) => Promise<unknown>)
    | undefined;
  if (typeof fn !== 'function') {
    throw new Error('OpenDia native bridge unavailable (background not initialised)');
  }
  return fn(name, args);
}

function listNativeSpecs(): OpendiaToolSpec[] {
  const fn = (globalThis as any).__opendiaListTools as
    | (() => OpendiaToolSpec[])
    | undefined;
  if (typeof fn !== 'function') return [];
  try { return fn() ?? []; } catch { return []; }
}

// Convert an OpenDia JSON-schema object into a typebox schema. This is a
// narrow conversion: only the shapes the OpenDia tool set actually uses
// (object with property map + required[] + primitive types + string enums
// + array of primitives). Anything richer collapses to Type.Any() so we
// don't reject valid calls just because the schema is unusual.
function toTypebox(schema: OpendiaToolSpec['inputSchema']): any {
  if (!schema || schema.type !== 'object' || !schema.properties) {
    return Type.Object({});
  }
  const props: Record<string, any> = {};
  const required = new Set(schema.required ?? []);
  for (const [key, raw] of Object.entries(schema.properties)) {
    const p = raw as any;
    let field: any;
    switch (p?.type) {
      case 'string':
        field = Array.isArray(p.enum)
          ? Type.Union(p.enum.map((v: string) => Type.Literal(v)),
                       { description: p.description })
          : Type.String({ description: p.description });
        break;
      case 'number':
      case 'integer':
        field = Type.Number({ description: p.description });
        break;
      case 'boolean':
        field = Type.Boolean({ description: p.description });
        break;
      case 'array':
        field = Type.Array(Type.Any(), { description: p.description });
        break;
      case 'object':
        field = Type.Object({}, { description: p.description });
        break;
      default:
        field = Type.Any({ description: p.description });
    }
    props[key] = required.has(key) ? field : Type.Optional(field);
  }
  return Type.Object(props);
}

function makeAgentTool(spec: OpendiaToolSpec): AgentTool<any> {
  const schema = toTypebox(spec.inputSchema);
  const name = `browser_${spec.name}`;
  return {
    name,
    label: `Browser: ${spec.name}`,
    description: spec.description ?? `OpenDia browser tool: ${spec.name}`,
    parameters: schema,
    async execute(_toolCallId, params): Promise<AgentToolResult<{}>> {
      const raw = await callNative(spec.name, params ?? {});
      const text = typeof raw === 'string' ? raw : safeStringify(raw);
      return {
        content: [{ type: 'text', text }],
        details: {},
      };
    },
  };
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v, null, 2) ?? String(v); }
  catch { return String(v); }
}

// ─── Meta tools: gate to the long-tail surface ─────────────────────────

const ListToolsParameters = Type.Object({
  query: Type.Optional(Type.String({
    description:
      'Optional case-insensitive substring filter over tool name + description. ' +
      'Use to narrow the ~150 long-tail browser tools before calling one.',
  })),
  limit: Type.Optional(Type.Number({
    description: 'Max results (default 30, hard cap 100).',
  })),
});

const opendiaListToolsMeta: AgentTool<typeof ListToolsParameters> = {
  name: 'opendia_list_tools',
  label: 'Browser: search tool catalog',
  description:
    'Search the ~150 long-tail OpenDia browser tools that are hidden from the ' +
    'default tool list to save prompt tokens. Returns matching tool names + ' +
    'one-line descriptions. Follow with opendia_call_tool(name, args) to run one.',
  parameters: ListToolsParameters,
  async execute(_toolCallId, params): Promise<AgentToolResult<{}>> {
    const q = (params.query ?? '').trim().toLowerCase();
    const limit = Math.min(Math.max(1, params.limit ?? 30), 100);
    const specs = listNativeSpecs();
    const wl = new Set(await opendiaNativeWhitelist.getValue());
    const hits = specs
      .filter((s) => !wl.has(s.name)) // hide already-exposed core tools
      .filter((s) => {
        if (!q) return true;
        return s.name.toLowerCase().includes(q)
            || (s.description ?? '').toLowerCase().includes(q);
      })
      .slice(0, limit)
      .map((s) => ({ name: s.name, description: s.description ?? '' }));
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ total: hits.length, tools: hits }, null, 2),
      }],
      details: {},
    };
  },
};

const CallToolParameters = Type.Object({
  name: Type.String({
    description:
      'Exact tool name from opendia_list_tools (without the browser_ prefix).',
  }),
  args: Type.Optional(Type.Object({}, {
    description: 'Arguments object matching the tool inputSchema. Empty if none.',
  })),
});

const opendiaCallToolMeta: AgentTool<typeof CallToolParameters> = {
  name: 'opendia_call_tool',
  label: 'Browser: invoke tool by name',
  description:
    'Invoke any long-tail OpenDia browser tool discovered via opendia_list_tools. ' +
    'Prefer the direct core browser_* tools when available. Returns the tool ' +
    'result verbatim as JSON text.',
  parameters: CallToolParameters,
  async execute(_toolCallId, params): Promise<AgentToolResult<{}>> {
    const raw = await callNative(params.name, params.args ?? {});
    const text = typeof raw === 'string' ? raw : safeStringify(raw);
    return {
      content: [{ type: 'text', text }],
      details: {},
    };
  },
};

// ─── Public: compose the AgentTool[] the sidebar agent should merge ────

/**
 * Build the OpenDia native surface. Returns [] when the toggle is off or
 * the background bridge isn't installed (e.g. running in a test harness).
 * Whitelisted tools are materialised as first-class AgentTool; everything
 * else stays reachable via the two meta-tools.
 */
export async function buildOpendiaNativeTools(): Promise<AgentTool<any>[]> {
  const enabled = await opendiaNativeEnabled.getValue();
  if (!enabled) return [];
  const specs = listNativeSpecs();
  if (specs.length === 0) return [];
  const whitelist = new Set(await opendiaNativeWhitelist.getValue());
  const specByName = new Map(specs.map((s) => [s.name, s]));
  const core: AgentTool<any>[] = [];
  for (const name of whitelist) {
    const spec = specByName.get(name);
    if (spec) core.push(makeAgentTool(spec));
  }
  return [...core, opendiaListToolsMeta, opendiaCallToolMeta];
}

export const OPENDIA_NATIVE_DEFAULT_CORE = DEFAULT_CORE_TOOLS;
