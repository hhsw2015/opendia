// OpenDia + Cebian merged WXT config. Cebian's full agentic sidepanel
// (chat / providers / MCP / recorder / VFS / skills / memory / backup)
// stacks on top of OpenDia's 164-tool browser bridge. Every entrypoint
// Cebian ships is included; OpenDia's own background + content scripts
// coexist alongside them.
//
// Rollback switches:
//   OPENDIA_LEGACY_POPUP=1  restores the pre-merge action popup
//   OPENDIA_CHAT_UI=0       (runtime, chrome.storage.local) hides sidepanel
//
// Vite plugins mirror Cebian upstream — the two pi-ai OAuth transforms are
// mandatory for Chrome Web Store review (obfuscated-code detector).
import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

const LEGACY_POPUP = process.env.OPENDIA_LEGACY_POPUP === '1';
// WXT `-b firefox` sets this at runtime; wxt.config.ts is evaluated once
// per build so we can key filterEntrypoints on it.
const IS_FIREFOX_BUILD = process.argv.includes('firefox');

const CEBIAN_PERMS = [
  'sidePanel', 'activeTab', 'tabs', 'scripting', 'storage', 'alarms',
  'offscreen', 'debugger', 'webNavigation',
  'bookmarks', 'history', 'cookies', 'topSites', 'sessions',
  'downloads', 'notifications',
  'clipboardRead',
  // Right-click context menu entry so Arc users (where the toolbar-icon
  // click is intercepted) still have a working way to open the sidebar.
  'contextMenus',
];

// OpenDia additions that Cebian's baseline lacks. `webRequest` is required
// by CDP network tools; `tabGroups` powers OBU tab grouping.
const OPENDIA_EXTRA_PERMS = ['webRequest', 'tabGroups'];

const CHROME_PERMS = Array.from(new Set([...CEBIAN_PERMS, ...OPENDIA_EXTRA_PERMS]));

// Firefox MV2 preserves the pre-migration OpenDia set (webRequestBlocking
// gated by MV2 only; Chrome MV3 rejects it). No Cebian-specific perms yet
// because Cebian ships MV3-only; the Firefox target here is OpenDia's
// existing MV2 build parity.
const FIREFOX_PERMS = [
  'tabs', 'activeTab', 'storage', 'webNavigation', 'webRequest',
  'notifications', 'bookmarks', 'history', 'webRequestBlocking',
  'cookies', 'downloads', '<all_urls>',
];

// WXT MV3 sandbox CSP — verbatim from Cebian. MCP App sandbox iframes need
// to load remote scripts; the strict per-app boundary lives in the inner
// meta CSP built by mcp-app.sandbox/main.ts.
const SANDBOX_CSP =
  "sandbox allow-scripts allow-forms allow-popups allow-modals; " +
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https: data: blob:; " +
  "style-src 'self' 'unsafe-inline' https: data:; " +
  "connect-src 'self' https: wss: data: blob:; " +
  "img-src 'self' data: blob: https:; " +
  "font-src 'self' data: https:; " +
  "media-src 'self' data: blob: https:; " +
  "child-src 'self' data: blob:; " +
  "base-uri *;";

export default defineConfig({
  srcDir: '.',
  entrypointsDir: 'entrypoints',
  publicDir: 'public',
  outDir: 'dist',
  // Match the pre-merge OpenDia build layout (dist/chrome, dist/firefox)
  // so users who already loaded the extension from that path can just hit
  // Chrome's "reload" button on chrome://extensions instead of re-picking
  // the directory after every rebuild.
  outDirTemplate: '{{browser}}',
  modules: ['@wxt-dev/module-react', '@wxt-dev/i18n/module'],
  dev: {
    server: { port: 3210 },
  },
  // Silence known-safe Firefox build warnings:
  //  - firefoxDataCollection: we declare no data collection in
  //    browser_specific_settings.gecko.data_collection_permissions below
  //    (required: ['none']), which is the ext-workshop-blessed opt-out.
  //  - firefoxExtensionId: not applicable, we set the gecko id explicitly.
  suppressWarnings: {
    firefoxDataCollection: true,
  },
  manifest: ({ browser }) => {
    const isFirefox = browser === 'firefox';
    return {
      name: 'OpenDia',
      version: '1.1.0',
      description: 'Connect your browser to AI models',
      default_locale: 'en',
      ...(isFirefox
        ? {
            browser_specific_settings: {
              gecko: {
                id: 'opendia@aaronjmars.com',
                strict_min_version: '109.0',
                // Explicit opt-out of Firefox's built-in data-consent flow
                // (mandatory for new extensions after 2025-11-03). "none"
                // is the extension-workshop-blessed value declaring the
                // extension performs no data collection at all.
                data_collection_permissions: {
                  required: ['none'],
                },
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
      // Keyboard shortcut redundant entry — user binds their key of choice
      // in chrome://extensions/shortcuts. We don't hard-code a suggested
      // key because Cmd/Ctrl+Shift+O collides with common built-ins.
      commands: {
        'open-sidepanel': {
          description: 'Open OpenDia sidebar',
        },
      },
      web_accessible_resources: [
        {
          resources: ['src/polyfill/browser-polyfill.min.js'],
          matches: ['<all_urls>'],
        },
      ],
      ...(isFirefox ? {} : { content_security_policy: { sandbox: SANDBOX_CSP } }),
    };
  },
  filterEntrypoints: [
    // OpenDia core
    'background', 'content', 'react-hook-inject', 'sidepanel',
    ...(LEGACY_POPUP ? ['popup'] : []),
    // Cebian entrypoints. Sandbox pages + offscreen documents don't exist
    // on Firefox MV2, so exclude them from that build to silence WXT's
    // "Sandboxed pages not supported by Firefox" warning.
    // filterEntrypoints uses the WXT-normalised name (suffixes like
    // `.sandbox` / `.content` are stripped): `mcp-app.sandbox/` → `mcp-app`.
    ...(IS_FIREFOX_BUILD
      ? ['user-permission', 'vfs', 'settings', 'recorder']
      : ['offscreen', 'sandbox', 'mcp-app',
         'user-permission', 'vfs', 'settings', 'recorder']),
  ],
  vite: () => ({
    plugins: [
      // pi-ai internal `./anthropic.js` -> local no-op shim. Cebian doesn't
      // use Anthropic OAuth; the upstream module contains a base64 client
      // ID that trips Chrome Web Store obfuscated-code review.
      {
        name: 'cebian:stub-pi-ai-anthropic',
        enforce: 'pre' as const,
        resolveId(id: string, importer: string | undefined) {
          if (id !== './anthropic.js' || !importer) return null;
          const normalized = importer.replace(/\\/g, '/');
          if (!normalized.includes('/@earendil-works/pi-ai/dist/utils/oauth/')) return null;
          return path.resolve(__dirname, 'lib/shims/pi-ai-anthropic.js');
        },
      },
      // pi-ai GitHub Copilot OAuth: rewrite the `atob(base64)` client-ID
      // pattern to a plain-text literal so the bundle passes obfuscation
      // review. Fail-loud throw when upstream changes shape.
      {
        name: 'cebian:depobfuscate-pi-ai-copilot',
        enforce: 'pre' as const,
        transform(code: string, id: string) {
          const normalized = id.replace(/\\/g, '/').split('?')[0];
          if (!normalized.endsWith('/@earendil-works/pi-ai/dist/utils/oauth/github-copilot.js')) {
            return null;
          }
          const OBFUSCATED =
            'const decode = (s) => atob(s);\n' +
            'const CLIENT_ID = decode("SXYxLmI1MDdhMDhjODdlY2ZlOTg=");';
          const REPLACEMENT = 'const CLIENT_ID = "Iv1.b507a08c87ecfe98";';
          if (!code.includes(OBFUSCATED)) {
            throw new Error(
              '[cebian:depobfuscate-pi-ai-copilot] pi-ai github-copilot.js no longer ' +
              'contains the expected atob pattern. Update wxt.config.ts before shipping.',
            );
          }
          return { code: code.replace(OBFUSCATED, REPLACEMENT), map: null };
        },
      },
      tailwindcss(),
    ],
    server: {
      // Sandbox pages have origin: null — permissive CORS in dev.
      cors: true,
    },
    define: {
      // pi-ai openai-codex / anthropic modules read this at module load in a
      // Node-only branch that never runs in a service worker. Inlining a
      // literal keeps the SW from throwing on `process is not defined`.
      'process.env.PI_OAUTH_CALLBACK_HOST': JSON.stringify('127.0.0.1'),
    },
    resolve: {
      alias: {
        // isomorphic-textencoder crashes in MV3 SW strict mode; shim to
        // native TextEncoder/TextDecoder.
        'isomorphic-textencoder': path.resolve(__dirname, 'lib/shims/isomorphic-textencoder.js'),
      },
    },
  }),
});
