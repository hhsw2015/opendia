#!/usr/bin/env node
// Phase 0 baseline: extract getAvailableTools() from background.js under a
// mocked chrome/browser env and dump one JSON entry per tool. Diffs against
// tests/opendia/baseline-tool-schemas.json prove non-regression.
//
// Runs in Node ≥18. No deps. Loads background.js verbatim, no build step.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const BG = resolve(HERE, '../../src/background/background.js');

function makeChromeStub() {
  const noopEvent = { addListener() {}, removeListener() {}, hasListener: () => false };
  const stub = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'runtime') {
        return new Proxy({
          getManifest: () => ({ version: '0.0.0-phase0' }),
          getURL: (p) => `chrome-extension://phase0/${p}`,
          id: 'phase0',
          lastError: null,
          onMessage: noopEvent,
          onConnect: noopEvent,
          onInstalled: noopEvent,
          onStartup: noopEvent,
          sendMessage: () => {},
          connect: () => ({ onMessage: noopEvent, onDisconnect: noopEvent, postMessage: () => {}, disconnect: () => {} }),
        }, { get(t, p) { return p in t ? t[p] : (() => undefined); } });
      }
      if (prop === 'storage') return { local: { get: (_k, cb) => cb && cb({}), set: (_v, cb) => cb && cb() }, session: { get: () => Promise.resolve({}), set: () => Promise.resolve() } };
      if (prop === 'tabs') return { query: () => Promise.resolve([]), get: () => Promise.resolve({}), onActivated: noopEvent, onUpdated: noopEvent, onRemoved: noopEvent };
      if (prop === 'debugger') return { attach: () => Promise.resolve(), detach: () => Promise.resolve(), sendCommand: () => Promise.resolve({}), onDetach: noopEvent, onEvent: noopEvent };
      if (prop === 'action') return { onClicked: noopEvent, setBadgeText: () => {}, setBadgeBackgroundColor: () => {} };
      if (prop === 'contextMenus') return { create: () => {}, onClicked: noopEvent, removeAll: () => Promise.resolve() };
      if (prop === 'webRequest') return { onBeforeSendHeaders: noopEvent, onCompleted: noopEvent };
      if (prop === 'commands') return { onCommand: noopEvent };
      if (prop === 'scripting') return { executeScript: () => Promise.resolve([]) };
      if (prop === 'sidePanel') return { open: () => Promise.resolve(), setOptions: () => Promise.resolve() };
      if (prop === 'cookies') return { get: () => Promise.resolve(null), getAll: () => Promise.resolve([]), set: () => Promise.resolve(), remove: () => Promise.resolve() };
      if (prop === 'downloads') return { download: () => Promise.resolve(0), search: () => Promise.resolve([]), onChanged: noopEvent };
      if (prop === 'windows') return { getCurrent: () => Promise.resolve({ id: 1 }), onFocusChanged: noopEvent };
      return noopEvent;
    },
  });
  return stub;
}

function loadBackground(source) {
  const chrome = makeChromeStub();
  const browserInfo = { isFirefox: false, isChrome: true, isServiceWorker: true };

  const ctx = {
    chrome,
    browser: chrome,
    globalThis: undefined,
    self: {},
    console,
    WebSocket: class { constructor() {} close() {} send() {} addEventListener() {} },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    crypto: globalThis.crypto,
    performance: globalThis.performance,
    browserInfo,
    __exports: {},
  };
  ctx.globalThis = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);

  // Extract the getAvailableTools function body directly and expose it,
  // sidestepping every side-effecting statement at module load. Background.js
  // is a plain script; grep it for the function's line range.
  const lines = source.split('\n');
  const startIdx = lines.findIndex((l) => /^function getAvailableTools\(\)/.test(l));
  if (startIdx < 0) throw new Error('getAvailableTools not found');
  // Walk until the matching closing brace at column 0 (function ends with `^}$`).
  let endIdx = -1;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i] === '}') { endIdx = i; break; }
  }
  if (endIdx < 0) throw new Error('getAvailableTools closing brace not found');
  const fnSource = lines.slice(startIdx, endIdx + 1).join('\n');

  const script = new vm.Script(`${fnSource}\n__exports.tools = getAvailableTools();`);
  script.runInContext(ctx);
  return ctx.__exports.tools;
}

function normalizeTool(t) {
  // Drop volatile fields (description text may drift), keep the wire-visible
  // schema. Sort keys so JSON diff is stable.
  return {
    name: t.name,
    inputSchema: sortObject(t.inputSchema ?? { type: 'object' }),
  };
}

function sortObject(v) {
  if (Array.isArray(v)) return v.map(sortObject);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortObject(v[k]);
    return out;
  }
  return v;
}

const source = readFileSync(BG, 'utf8');
const tools = loadBackground(source);
const normalized = tools.map(normalizeTool).sort((a, b) => a.name.localeCompare(b.name));

process.stdout.write(JSON.stringify({
  version: 1,
  captured_at: 'PHASE0_BASELINE',
  tool_count: normalized.length,
  tools: normalized,
}, null, 2));
process.stdout.write('\n');
