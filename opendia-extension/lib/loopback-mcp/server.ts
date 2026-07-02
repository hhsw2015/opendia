// Phase 2 loopback MCP server-side stub. The actual dispatch table is
// implemented in src/background/background.js at the bottom of the file
// (browser.runtime.onConnect handler for port name "mcp-loopback"). That
// listener shares the getAvailableTools() and handleMCPRequest() functions
// with the WebSocket transport.
//
// This file exists so future phases (chat store frames, per-transport
// gating, message tracing) have an obvious home outside background.js.
// For now, importing it in an entrypoint is a no-op — it just documents
// the shared-handler-table contract from the SPEC (§Phase 2 acceptance).

/** Wire-name of the runtime port carrying MCP frames from the sidepanel. */
export const LOOPBACK_PORT = 'mcp-loopback';
