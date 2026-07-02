// Phase 1 WXT MAIN-world content script. Injected at document_start into
// every frame so the React devtools hook lands before app bootstrap. Kept
// as a separate entrypoint from `content/` because MAIN world scripts need
// their own registration.
import { defineContentScript } from 'wxt/utils/define-content-script';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — legacy JS with no types.
import '../src/content/react-hook-inject.js';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  allFrames: true,
  world: 'MAIN',
  // Firefox pre-migration manifest never registered this MAIN-world script;
  // preserve that so Phase 1 is a strict zero-diff. Chrome MV3 keeps it.
  include: ['chrome'],
  main() {},
});
