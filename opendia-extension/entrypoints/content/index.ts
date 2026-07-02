// Phase 1 WXT content-script entrypoint. Preserves the pre-migration
// wiring: polyfill → snapshot → content, at document_idle, all frames.
import { defineContentScript } from 'wxt/utils/define-content-script';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — legacy JS with no types.
import '../../src/polyfill/browser-polyfill.min.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import '../../src/content/snapshot.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import '../../src/content/content.js';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  allFrames: true,
  main() {},
});
