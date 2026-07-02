// Phase 1 WXT config for OpenDia. Mirrors manifest-chrome.json and
// manifest-firefox.json field-for-field so the built extension is
// behaviourally identical to today's build.js output.
//
// Phase 2 adds a Chrome MV3 side_panel entry + sidePanel permission gated
// by the OPENDIA_CHAT_UI kill switch (checked at runtime — the manifest
// entry stays, but background can skip opening it).
//
// See docs/specs/opendia-cebian-merge.md §Phase 1–2 for guardrails.
import { defineConfig } from 'wxt';

// Phase 3 rollback: set OPENDIA_LEGACY_POPUP=1 to re-include the pre-Cebian
// action popup entrypoint. Default (unset) drops the popup — toolbar click
// falls through to chrome.action.onClicked → chrome.sidePanel.open(). This
// matches SPEC §2 Invariants "OPENDIA_LEGACY_POPUP=1 restores popup.html".
const LEGACY_POPUP = process.env.OPENDIA_LEGACY_POPUP === '1';

const CHROME_PERMS = [
  'tabs',
  'activeTab',
  'storage',
  'scripting',
  'webNavigation',
  'webRequest',
  'notifications',
  'bookmarks',
  'history',
  'debugger',
  'cookies',
  'downloads',
  'tabGroups',
  // Phase 2: sidepanel opened via chrome.sidePanel.open().
  'sidePanel',
];

// Firefox MV2 pre-migration set — matches manifest-firefox.json exactly.
// `<all_urls>` was listed under permissions in the legacy MV2 manifest; WXT
// keeps host_permissions in the same array for MV2.
const FIREFOX_PERMS = [
  'tabs',
  'activeTab',
  'storage',
  'webNavigation',
  'webRequest',
  'notifications',
  'bookmarks',
  'history',
  'webRequestBlocking',
  'cookies',
  'downloads',
  '<all_urls>',
];

// Entrypoint list. Popup joins only when the rollback env is set — Phase 3
// otherwise removes it from the manifest so chrome.action.onClicked fires
// on toolbar clicks (WXT auto-registers default_popup when an entrypoint
// named "popup" exists).
const ENTRYPOINTS = [
  'background',
  'content',
  'react-hook-inject',
  'sidepanel',
  ...(LEGACY_POPUP ? ['popup'] : []),
];

export default defineConfig({
  srcDir: '.',
  entrypointsDir: 'entrypoints',
  publicDir: 'public',
  outDir: 'dist',
  modules: ['@wxt-dev/module-react'],
  filterEntrypoints: ENTRYPOINTS,
  manifest: ({ browser }) => {
    const isFirefox = browser === 'firefox';
    return {
      name: 'OpenDia',
      version: '1.1.0',
      description: 'Connect your browser to AI models',
      ...(isFirefox
        ? {
            browser_specific_settings: {
              gecko: {
                id: 'opendia@aaronjmars.com',
                strict_min_version: '109.0',
              },
            },
          }
        : {}),
      icons: {
        16: '/icons/icon-16.png',
        32: '/icons/icon-32.png',
        48: '/icons/icon-48.png',
        128: '/icons/icon-128.png',
      },
      permissions: isFirefox ? FIREFOX_PERMS : CHROME_PERMS,
      ...(isFirefox ? {} : { host_permissions: ['<all_urls>'] }),
      incognito: 'split',
      action: { default_title: 'OpenDia' },
      web_accessible_resources: [
        {
          resources: ['src/polyfill/browser-polyfill.min.js'],
          matches: ['<all_urls>'],
        },
      ],
    };
  },
});
