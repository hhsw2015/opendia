// Phase 3 minimal chat surface. Backed by the extension chat store (SPEC
// §Phase 4 ext side) via lib/chat/client.ts. No LLM wiring yet — the
// Cebian verbatim import lands in a follow-up. This exists so:
//   1. M7 acceptance can pass (daemon chat_read returns messages typed here).
//   2. M8 acceptance can pass (daemon chat_send appears here within 2s via
//      the runtime port subscription).
//   3. The sidepanel UX has a place-holder that isn't the debug tool list.
import React from 'react';
import { connectChatClient, type ChatClient, type ChatMessage, type ChatSummary } from '../../../lib/chat/client';

export function ChatSurface() {
  const [client, setClient] = React.useState<ChatClient | null>(null);
  const [chats, setChats] = React.useState<ChatSummary[]>([]);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [draft, setDraft] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const c = connectChatClient();
    setClient(c);
    c.list().then((list) => {
      setChats(list);
      if (list.length > 0) setActiveId(list[0].chat_id);
    }).catch((e) => setError(e?.message ?? String(e)));
    return () => c.disconnect();
  }, []);

  React.useEffect(() => {
    if (!client || !activeId) return;
    let unsub: (() => void) | null = null;
    let cancelled = false;
    client.read(activeId).then((ms) => { if (!cancelled) setMessages(ms); });
    client.subscribe(activeId, (event) => {
      if (event.type === 'chat_appended') {
        setMessages((prev) => (prev.some((m) => m.msg_id === event.msg.msg_id) ? prev : [...prev, event.msg]));
      } else if (event.type === 'chat_deleted' && event.chat_id === activeId) {
        setActiveId(null);
        setMessages([]);
      }
    }).then((s) => { unsub = s.unsubscribe; });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [client, activeId]);

  const createChat = async () => {
    if (!client) return;
    const id = await client.create('New chat');
    const next = await client.list();
    setChats(next);
    setActiveId(id);
    setMessages([]);
  };
  const send = async () => {
    if (!client || !activeId || !draft.trim()) return;
    const t = draft.trim();
    setDraft('');
    try {
      await client.send(activeId, 'user', t);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <select
          value={activeId ?? ''}
          onChange={(e) => setActiveId(e.target.value || null)}
          style={{ flex: 1, padding: 4, borderRadius: 4, border: '1px solid #d1d5db', fontSize: '0.8rem' }}
        >
          <option value="">— no chat —</option>
          {chats.map((c) => (
            <option key={c.chat_id} value={c.chat_id}>{c.title} · {c.message_count}</option>
          ))}
        </select>
        <button onClick={createChat} style={buttonStyle}>New</button>
      </div>

      {error && <div style={{ color: '#ef4444', fontSize: '0.75rem' }}>{error}</div>}

      <div style={{
        flex: 1,
        background: 'rgba(255,255,255,0.7)',
        border: '1px solid rgba(0,129,247,0.15)',
        borderRadius: 8,
        padding: 8,
        overflow: 'auto',
        minHeight: 300,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}>
        {messages.length === 0 ? (
          <div style={{ color: '#6b7280', fontSize: '0.8rem', textAlign: 'center', marginTop: 40 }}>
            {activeId ? 'No messages yet.' : 'Create a chat to begin.'}
          </div>
        ) : messages.map((m) => (
          <div key={m.msg_id} style={{
            alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
            maxWidth: '85%',
            padding: '6px 10px',
            borderRadius: 8,
            background: m.role === 'user' ? 'rgba(0,129,247,0.15)' : m.role === 'assistant' ? 'rgba(255,117,202,0.15)' : 'rgba(107,114,128,0.1)',
            fontSize: '0.85rem',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}>
            <div style={{ fontSize: '0.65rem', color: '#6b7280', marginBottom: 2 }}>{m.role} · #{m.msg_id}</div>
            {m.text}
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 6 }}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={activeId ? 'Type a message…' : 'Create a chat first.'}
          disabled={!activeId}
          style={{
            flex: 1,
            resize: 'none',
            padding: 8,
            borderRadius: 6,
            border: '1px solid #d1d5db',
            fontSize: '0.85rem',
            fontFamily: 'inherit',
            minHeight: 60,
          }}
        />
        <button onClick={send} disabled={!activeId || !draft.trim()} style={{ ...buttonStyle, alignSelf: 'flex-end' }}>Send</button>
      </div>
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  border: '1px solid rgba(0,129,247,0.3)',
  background: 'rgba(255,255,255,0.5)',
  color: '#0057b7',
  padding: '6px 12px',
  borderRadius: 6,
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: '0.8rem',
};
