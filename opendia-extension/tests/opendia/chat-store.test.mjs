#!/usr/bin/env node
// Phase 4 extension-side chat-store unit test. Loads background.js in a vm
// context with a mocked chrome API; exercises the chat_* handlers through
// the CHAT_METHODS table so we're testing the exact code that runs in the
// service worker.
//
// Covers:
//   1. chat_create → chat_list roundtrip persists via storage
//   2. chat_send is idempotent on client_msg_id (returns existing msg_id)
//   3. chat_send with mismatched content + same client_msg_id → IDEMPOTENCY_CONFLICT
//   4. chat_send with an unknown role → INVALID_ROLE
//   5. chat_read since_msg_id filters strictly greater
//   6. chat_delete removes storage + index entries
//   7. chat_subscribe / chat_unsubscribe tracks state
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const BG = resolve(HERE, '../../src/background/background.js');

function makeStorage() {
  const store = new Map();
  return {
    local: {
      get(keys, cb) {
        const arr = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of arr) if (store.has(k)) out[k] = store.get(k);
        cb?.(out);
      },
      set(pairs, cb) { for (const k of Object.keys(pairs)) store.set(k, pairs[k]); cb?.(); },
      remove(keys, cb) {
        const arr = Array.isArray(keys) ? keys : [keys];
        for (const k of arr) store.delete(k);
        cb?.();
      },
    },
    _dump: () => Object.fromEntries(store),
  };
}

function makeChromeStub(storage) {
  const noopEvent = { addListener() {}, removeListener() {}, hasListener: () => false };
  const stub = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'runtime') {
        return new Proxy({
          getManifest: () => ({ version: '0.0.0-phase3-test' }),
          getURL: (p) => `chrome-extension://test/${p}`,
          id: 'test',
          lastError: null,
          onMessage: noopEvent,
          onConnect: noopEvent,
          onInstalled: noopEvent,
          onStartup: noopEvent,
          sendMessage: () => {},
          connect: () => ({ onMessage: noopEvent, onDisconnect: noopEvent, postMessage: () => {}, disconnect: () => {} }),
        }, { get(t, p) { return p in t ? t[p] : (() => undefined); } });
      }
      if (prop === 'storage') return storage;
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
  const storage = makeStorage();
  const chrome = makeChromeStub(storage);
  const browserInfo = { isFirefox: false, isChrome: true, isServiceWorker: true };
  const noopConnect = () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage: () => {}, disconnect: () => {} });
  const ctx = {
    chrome, browser: chrome, globalThis: undefined, self: {}, console,
    // Bypass WebSocket loop: bg's connectionManager will construct one, but
    // we short-circuit its .send() at runtime — the store handlers we care
    // about never touch the socket, they only optionally broadcast on it.
    WebSocket: class { constructor() {} close() {} send() {} addEventListener() {} },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, URL, URLSearchParams, TextEncoder, TextDecoder,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    crypto: globalThis.crypto,
    performance: globalThis.performance,
    browserInfo,
  };
  ctx.globalThis = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  // Run background.js as a bare script. Chrome extension APIs are all
  // mocked, connectionManager.send() is idempotent, so top-level side
  // effects (safety-mode load, WS connect) succeed without a real socket.
  new vm.Script(source).runInContext(ctx);
  return { ctx, storage };
}

const source = readFileSync(BG, 'utf8');
const { ctx, storage } = loadBackground(source);

// Access the chat handler table via the global hook installed at the tail
// of background.js. handleChatFrame(frame) → boolean.
const handleChatFrame = ctx.__opendiaHandleChatFrame;
assert.equal(typeof handleChatFrame, 'function', 'handleChatFrame hook installed');

async function call(method, params) {
  return new Promise((resolve) => {
    const replyTo = (envelope) => resolve(envelope);
    handleChatFrame({ id: `t-${Math.random()}`, method, params }, replyTo).catch((err) => {
      resolve({ error: { message: String(err) } });
    });
  });
}

(async () => {
  // 1. create + list
  const create = await call('chat_create', { title: 'hello' });
  assert.ok(create.result?.chat_id, 'chat_create returns chat_id');
  const chatId = create.result.chat_id;

  const list = await call('chat_list', {});
  assert.equal(list.result.chats.length, 1);
  assert.equal(list.result.chats[0].chat_id, chatId);

  // 2. idempotent send
  const cmid = '00000000-0000-4000-8000-000000000001';
  const first = await call('chat_send', { chat_id: chatId, client_msg_id: cmid, role: 'user', text: 'hi' });
  assert.ok(first.result?.msg_id, 'first send returns msg_id');
  const dup = await call('chat_send', { chat_id: chatId, client_msg_id: cmid, role: 'user', text: 'hi' });
  assert.equal(dup.result.msg_id, first.result.msg_id, 'dup returns same msg_id');

  // 3. idempotency conflict
  const conflict = await call('chat_send', { chat_id: chatId, client_msg_id: cmid, role: 'user', text: 'DIFFERENT' });
  assert.ok(conflict.error, 'mismatched content on same client_msg_id rejects');
  assert.match(conflict.error.message, /IDEMPOTENCY_CONFLICT/);

  // 4. invalid role
  const bad = await call('chat_send', {
    chat_id: chatId,
    client_msg_id: '00000000-0000-4000-8000-000000000002',
    role: 'system',
    text: 'nope',
  });
  assert.ok(bad.error, 'INVALID_ROLE surfaces as error');
  assert.match(bad.error.message, /INVALID_ROLE/);

  // 5. since_msg_id filter
  await call('chat_send', { chat_id: chatId, client_msg_id: '00000000-0000-4000-8000-000000000003', role: 'assistant', text: 'reply' });
  const readAll = await call('chat_read', { chat_id: chatId });
  assert.equal(readAll.result.messages.length, 2);
  const readTail = await call('chat_read', { chat_id: chatId, since_msg_id: 1 });
  assert.equal(readTail.result.messages.length, 1);
  assert.equal(readTail.result.messages[0].msg_id, 2);

  // 6. delete removes
  const del = await call('chat_delete', { chat_id: chatId });
  assert.equal(del.result.ok, true);
  const relist = await call('chat_list', {});
  assert.equal(relist.result.chats.length, 0);

  // 7. subscribe/unsubscribe state
  const sub = await call('chat_subscribe', { chat_id: '00000000-0000-4000-8000-000000000abc', sub_id: 'sub-1' });
  assert.equal(sub.result.ok, true);
  const unsub = await call('chat_unsubscribe', { sub_id: 'sub-1' });
  assert.equal(unsub.result.ok, true);

  console.log('ok — 7 chat-store assertions pass');
})();
