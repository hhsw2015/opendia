// Phase 3 sidepanel chat client. Talks to the background chat store via a
// runtime port named "cebian-chat" (defined in src/background/background.js).
// The wire format matches SPEC §5.1 chat_* frames plus a runtime-only
// {type:'subscribe'|'unsubscribe'} pair for push routing to this panel.
export interface ChatMessage {
  msg_id: number;
  client_msg_id: string;
  ts: number;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  tool_call?: { name: string; args: unknown };
  metadata?: Record<string, unknown>;
}

export interface ChatSummary {
  chat_id: string;
  title: string;
  updated_at: number;
  message_count: number;
}

export type ChatEvent =
  | { type: 'chat_appended'; sub_id: string; chat_id: string; msg: ChatMessage }
  | { type: 'chat_deleted'; sub_id: string; chat_id: string };

export interface ChatClient {
  list(): Promise<ChatSummary[]>;
  create(title?: string, tab_hint?: number): Promise<string>;
  read(chat_id: string, since_msg_id?: number, limit?: number): Promise<ChatMessage[]>;
  send(
    chat_id: string,
    role: 'user' | 'assistant' | 'tool',
    text: string,
    opts?: { tool_call?: { name: string; args: unknown }; metadata?: Record<string, unknown> },
  ): Promise<{ msg_id: number; ts: number }>;
  del(chat_id: string): Promise<void>;
  subscribe(chat_id: string, onEvent: (e: ChatEvent) => void): Promise<{ unsubscribe: () => void }>;
  disconnect(): void;
}

export function connectChatClient(): ChatClient {
  const bp: any = (globalThis as any).browser ?? (globalThis as any).chrome;
  const port = bp.runtime.connect({ name: 'cebian-chat' });
  const waiters = new Map<string, (r: any) => void>();
  const subs = new Map<string, (e: ChatEvent) => void>();
  let counter = 0;

  port.onMessage.addListener((frame: any) => {
    if (frame?.type === 'chat_appended' || frame?.type === 'chat_deleted') {
      const cb = subs.get(frame.sub_id);
      cb?.(frame);
      return;
    }
    if (frame?.type === 'subscribed') {
      const cb = waiters.get(`sub:${frame.chat_id}`);
      waiters.delete(`sub:${frame.chat_id}`);
      cb?.(frame.sub_id);
      return;
    }
    if (frame?.id != null) {
      const cb = waiters.get(String(frame.id));
      if (cb) {
        waiters.delete(String(frame.id));
        cb(frame);
      }
    }
  });
  port.onDisconnect.addListener(() => {
    for (const cb of waiters.values()) cb({ error: { message: 'port disconnected' } });
    waiters.clear();
    subs.clear();
  });

  function call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = `chat-${++counter}`;
      waiters.set(id, (reply) => {
        if (reply?.error) reject(new Error(reply.error?.message ?? String(reply.error)));
        else resolve(reply?.result as T);
      });
      port.postMessage({ id, method, params });
    });
  }

  const client: ChatClient = {
    async list() { return (await call<{ chats: ChatSummary[] }>('chat_list')).chats; },
    async create(title, tab_hint) {
      const r = await call<{ chat_id: string }>('chat_create', { title, tab_hint });
      return r.chat_id;
    },
    async read(chat_id, since_msg_id, limit) {
      const r = await call<{ messages: ChatMessage[] }>('chat_read', { chat_id, since_msg_id, limit });
      return r.messages;
    },
    async send(chat_id, role, text, opts) {
      return await call<{ msg_id: number; ts: number }>('chat_send', {
        chat_id,
        client_msg_id: crypto.randomUUID(),
        role,
        text,
        tool_call: opts?.tool_call,
        metadata: opts?.metadata,
      });
    },
    async del(chat_id) { await call('chat_delete', { chat_id }); },
    async subscribe(chat_id, onEvent) {
      const subId: string = await new Promise((resolve) => {
        waiters.set(`sub:${chat_id}`, resolve);
        port.postMessage({ type: 'subscribe', chat_id });
      });
      subs.set(subId, onEvent);
      return {
        unsubscribe: () => {
          subs.delete(subId);
          try { port.postMessage({ type: 'unsubscribe', sub_id: subId }); } catch { /* closed */ }
        },
      };
    },
    disconnect() { try { port.disconnect(); } catch { /* already closed */ } },
  };
  return client;
}
