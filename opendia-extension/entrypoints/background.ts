// Phase 1 WXT background entrypoint. Zero behavioural change: we import
// the existing 5334-line background.js (still the source of truth for the
// Phase 0 baseline) and let its top-level side effects run. WXT bundles
// this file as a module SW in Chrome MV3 and a background script list in
// Firefox MV2.
//
// Guardrails: DO NOT rewrite the imported script. Phase 2+ may add new
// wiring alongside, but background.js's dispatch table, WebSocket URL,
// and chrome.debugger.attach sites stay put.
import { defineBackground } from 'wxt/utils/define-background';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — legacy JS with no types.
import '../src/background/background.js';

export default defineBackground({
  persistent: false,
  type: 'module',
  main() {
    // Intentionally empty. background.js registers listeners on import.
  },
});
