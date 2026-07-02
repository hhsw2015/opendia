// OpenDia WS-bridge loader for the merged Cebian + OpenDia service worker.
// Cebian's background/index.ts runs its own agent + MCP + recorder pipelines
// via defineBackground(). This module re-executes the pre-merge OpenDia
// background.js verbatim inside the same SW so its 164-tool WebSocket bridge,
// chrome.debugger dispatch table, and Phase 4 chat store all coexist with
// Cebian's runtime.
//
// Kept as a side-effect import: OpenDia registers its listeners at module
// load, exactly like it did before the merge. Cebian's own listeners
// register from index.ts — chrome.runtime.onConnect / onMessage are additive
// so both worlds see every port and message. The two never share state
// beyond browser.storage.local, and their storage keyspaces are disjoint
// (OpenDia uses safetyMode/lastPorts/OPENDIA_*, Cebian uses cebian:*).
//
// See docs/specs/opendia-cebian-merge.md §Phase 3 for the merge invariant.

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — legacy JS with no types.
import '../../src/background/background.js';

export {};
