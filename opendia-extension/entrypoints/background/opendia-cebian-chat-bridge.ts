// Bridge SPEC §5.1 chat_* frames to Cebian's Dexie-backed sessionStore so
// daemon-side Claude Code / Cursor callers see the same conversations the
// user is having in the sidepanel — not the standalone Phase 4 chat store.
//
// This overrides globalThis.__opendiaHandleChatFrame that OpenDia's
// pre-merge background.js installed. Frames arriving on either transport
// (WebSocket bridge or loopback runtime port) go through this handler
// FIRST; Cebian sessions become the source of truth.
//
// Wire → Cebian mapping:
//   chat_id      ↔ session.id (uuid v4 per SPEC §5.3, matches Cebian)
//   msg_id       ↔ index into session.messages (monotonic per session)
//   client_msg_id → tracked in a per-session Set for idempotency; not
//                  persisted (Cebian's AgentMessage lacks that field)
//   role/text    ↔ derived from AgentMessage.role + textual content
//   tool_call    ↔ AgentMessage.tool_calls[0] when role=assistant
//
// Push frames (chat_appended / chat_deleted) fan out on Cebian session
// mutations — hooked via a Dexie 'writing' table hook so agent-manager
// writes automatically reach subscribers.
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { listSessions, getSession, deleteSession, createSession } from '@/lib/persistence/db';
import { sessionStore } from './session-store';

interface Subscriber {
  chat_id: string;
  last_msg_id: number | null;
  emit: (frame: unknown) => void;
}

const wsSubs = new Map<string, Subscriber>();      // sub_id → daemon subscriber (WS)
const runtimeSubs = new Map<string, Subscriber>(); // sub_id → sidepanel subscriber (runtime port)
const seenClientMsgIds = new Map<string, Map<string, number>>(); // chat_id → (client_msg_id → msg_id)

const CHAT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function uuidv4(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16);
  (crypto?.getRandomValues ?? ((x: Uint8Array) => x.fill(0)))(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function extractText(msg: AgentMessage): string {
  const anyMsg = msg as any;
  const c = anyMsg?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((part: any) => (typeof part === 'string' ? part : part?.text ?? ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function extractToolCall(msg: AgentMessage): { name: string; args: unknown } | undefined {
  const anyMsg = msg as any;
  const tc = anyMsg?.tool_calls?.[0];
  if (!tc) return undefined;
  return { name: tc.function?.name ?? tc.name ?? '', args: tc.function?.arguments ?? tc.arguments ?? {} };
}

function messageToWireForm(msg: AgentMessage, index: number): {
  msg_id: number;
  client_msg_id: string;
  ts: number;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  tool_call?: { name: string; args: unknown };
} {
  const anyMsg = msg as any;
  const role = anyMsg?.role;
  const wireRole: 'user' | 'assistant' | 'tool' =
    role === 'user' ? 'user' : role === 'tool' || role === 'tool_result' ? 'tool' : 'assistant';
  return {
    msg_id: index + 1, // 1-indexed to keep since_msg_id=0 semantics simple
    client_msg_id: anyMsg?.id ?? `derived-${index}`,
    ts: typeof anyMsg?.timestamp === 'number' ? anyMsg.timestamp : Date.now(),
    role: wireRole,
    text: extractText(msg),
    ...(extractToolCall(msg) ? { tool_call: extractToolCall(msg)! } : {}),
  };
}

function agentMessageFromSend(role: 'user' | 'assistant' | 'tool', text: string, clientMsgId: string): AgentMessage {
  return {
    role,
    content: text,
    id: clientMsgId,
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

async function chatList() {
  const rows = await listSessions();
  return {
    chats: rows.map((r) => ({
      chat_id: r.id,
      title: r.title || 'Untitled',
      updated_at: r.updatedAt,
      message_count: r.messageCount,
    })),
  };
}

async function chatRead(params: { chat_id: string; since_msg_id?: number; limit?: number }) {
  if (!CHAT_ID_RE.test(params.chat_id)) throw new Error('CHAT_NOT_FOUND');
  const s = await getSession(params.chat_id);
  if (!s) throw new Error('CHAT_NOT_FOUND');
  const since = typeof params.since_msg_id === 'number' ? params.since_msg_id : 0;
  let msgs = s.messages.map((m, i) => messageToWireForm(m, i)).filter((m) => m.msg_id > since);
  if (typeof params.limit === 'number' && params.limit > 0) msgs = msgs.slice(0, params.limit);
  return { chat_id: params.chat_id, messages: msgs };
}

async function chatSend(params: {
  chat_id: string;
  client_msg_id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  tool_call?: { name: string; args: unknown };
  metadata?: Record<string, unknown>;
}) {
  if (!CHAT_ID_RE.test(params.chat_id ?? '')) throw new Error('CHAT_NOT_FOUND');
  if (!params.client_msg_id) throw new Error('INVALID_ROLE: client_msg_id required');
  if (!['user', 'assistant', 'tool'].includes(params.role)) {
    throw new Error(`INVALID_ROLE: ${params.role}`);
  }

  // Idempotency check against the in-memory seen map.
  const bucket = seenClientMsgIds.get(params.chat_id) ?? new Map();
  const existing = bucket.get(params.client_msg_id);
  const s = await getSession(params.chat_id);
  if (!s) throw new Error('CHAT_NOT_FOUND');
  if (existing != null) {
    const dup = s.messages[existing - 1];
    if (dup && extractText(dup) === params.text && (dup as any).role === params.role) {
      return { msg_id: existing, ts: (dup as any).timestamp ?? Date.now() };
    }
    throw new Error('IDEMPOTENCY_CONFLICT');
  }

  const newMsg = agentMessageFromSend(params.role, params.text, params.client_msg_id);
  const nextMessages = [...s.messages, newMsg];
  sessionStore.scheduleWrite(params.chat_id, nextMessages);
  await sessionStore.flush(params.chat_id);
  const msgId = nextMessages.length;
  bucket.set(params.client_msg_id, msgId);
  seenClientMsgIds.set(params.chat_id, bucket);

  const wireMsg = messageToWireForm(newMsg, msgId - 1);
  broadcastAppended(params.chat_id, wireMsg);
  return { msg_id: msgId, ts: wireMsg.ts };
}

async function chatCreate(params: { title?: string; tab_hint?: number }) {
  const chatId = uuidv4();
  const now = Date.now();
  await createSession({
    id: chatId,
    title: params.title || 'New chat',
    model: '',
    provider: '',
    userInstructions: '',
    thinkingLevel: 'medium',
    createdAt: now,
    updatedAt: now,
    messages: [],
    messageCount: 0,
  });
  return { chat_id: chatId };
}

async function chatDelete(params: { chat_id: string }) {
  if (!CHAT_ID_RE.test(params.chat_id ?? '')) throw new Error('CHAT_NOT_FOUND');
  await deleteSession(params.chat_id);
  seenClientMsgIds.delete(params.chat_id);
  broadcastDeleted(params.chat_id);
  return { ok: true };
}

function chatSubscribe(params: { chat_id: string; sub_id: string; since_msg_id?: number }) {
  if (!CHAT_ID_RE.test(params.chat_id ?? '')) throw new Error('CHAT_NOT_FOUND');
  if (!params.sub_id) throw new Error('INVALID_ROLE: sub_id required');
  wsSubs.set(params.sub_id, {
    chat_id: params.chat_id,
    last_msg_id: params.since_msg_id ?? null,
    emit: (frame) => {
      try {
        const bp: any = (globalThis as any).browser ?? (globalThis as any).chrome;
        // The WS bridge in OpenDia's background.js exposes connectionManager
        // through an internal reference; we push over the same window via
        // globalThis to avoid coupling.
        (globalThis as any).__opendiaConnectionSend?.(frame);
      } catch { /* WS closed */ }
    },
  });
  return { ok: true, sub_id: params.sub_id };
}

function chatUnsubscribe(params: { sub_id: string }) {
  wsSubs.delete(params.sub_id);
  runtimeSubs.delete(params.sub_id);
  return { ok: true };
}

function broadcastAppended(chat_id: string, msg: unknown) {
  for (const [sub_id, sub] of wsSubs) {
    if (sub.chat_id !== chat_id) continue;
    sub.emit({ type: 'chat_appended', sub_id, chat_id, msg });
  }
  for (const [sub_id, sub] of runtimeSubs) {
    if (sub.chat_id !== chat_id) continue;
    sub.emit({ type: 'chat_appended', sub_id, chat_id, msg });
  }
}

function broadcastDeleted(chat_id: string) {
  for (const [sub_id, sub] of wsSubs) {
    if (sub.chat_id !== chat_id) continue;
    sub.emit({ type: 'chat_deleted', sub_id, chat_id });
  }
  for (const [sub_id, sub] of runtimeSubs) {
    if (sub.chat_id !== chat_id) continue;
    sub.emit({ type: 'chat_deleted', sub_id, chat_id });
  }
}

// Wake daemon subscribers on Cebian agent-loop writes. sessionStore is the
// sole Dexie writer (see session-store.ts); its scheduleWrite receives every
// message the agent produces. Wrap it so we broadcast the delta after each
// call. This misses only the batched-flush edge case where a subscriber
// registered after messages were queued but before flush ran — daemon-side
// long-poll retries close that window.
const _origScheduleWrite = sessionStore.scheduleWrite.bind(sessionStore);
const _lastMsgLen = new Map<string, number>();
sessionStore.scheduleWrite = (id: string, messages: AgentMessage[]) => {
  const prev = _lastMsgLen.get(id) ?? 0;
  _origScheduleWrite(id, messages);
  if (messages.length > prev) {
    queueMicrotask(() => {
      for (let i = prev; i < messages.length; i++) {
        broadcastAppended(id, messageToWireForm(messages[i], i));
      }
    });
    _lastMsgLen.set(id, messages.length);
  }
};

const HANDLERS: Record<string, (params: any) => Promise<unknown> | unknown> = {
  chat_list: () => chatList(),
  chat_read: (p) => chatRead(p),
  chat_send: (p) => chatSend(p),
  chat_create: (p) => chatCreate(p),
  chat_delete: (p) => chatDelete(p),
  chat_subscribe: (p) => chatSubscribe(p),
  chat_unsubscribe: (p) => chatUnsubscribe(p),
};

// Override the OpenDia baseline handler installed by src/background/background.js
// so daemon frames land on Cebian sessions instead of the standalone Phase 4
// chrome.storage.local store. Runs once at module load.
(globalThis as any).__opendiaHandleChatFrame = async (
  message: { id?: string; method?: string; params?: any },
  replyTo?: (envelope: unknown) => void,
) => {
  const method = message?.method;
  if (!method || !HANDLERS[method]) return false;
  const emit = replyTo ?? ((m: unknown) => (globalThis as any).__opendiaConnectionSend?.(m));
  try {
    const result = await HANDLERS[method](message.params ?? {});
    emit({ id: message.id, result });
  } catch (err) {
    emit({ id: message.id, error: { message: (err as Error)?.message ?? String(err), code: -32603 } });
  }
  return true;
};

export {};
