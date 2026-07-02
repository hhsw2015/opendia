// Phase 2/3 sidepanel App. Phase 2 introduced the loopback-MCP diagnostic
// view; Phase 3 promotes it to a "Settings → MCP Bridge" tab and adds a
// minimal chat surface backed by the extension chat store. Full Cebian
// verbatim chat UI (agent loop, providers, attachments) lands in a follow-up.
import React from 'react';
import { connectLoopback, type LoopbackClient } from '../../lib/loopback-mcp/transport';
import { McpBridge } from './components/McpBridge';
import { ChatSurface } from './components/ChatSurface';

type Tab = 'chat' | 'settings';

export function App() {
  const [tab, setTab] = React.useState<Tab>('chat');
  const [status, setStatus] = React.useState<'connecting' | 'connected' | 'error'>('connecting');
  const [toolCount, setToolCount] = React.useState<number | null>(null);
  const [toolNames, setToolNames] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const clientRef = React.useRef<LoopbackClient | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const client = connectLoopback();
    clientRef.current = client;
    client.toolsList().then(
      (tools) => {
        if (cancelled) return;
        const names = (tools as Array<{ name: string }>).map((t) => t.name);
        setToolCount(names.length);
        setToolNames(names);
        setStatus('connected');
      },
      (err) => {
        if (cancelled) return;
        setError(err?.message ?? String(err));
        setStatus('error');
      },
    );
    return () => {
      cancelled = true;
      client.disconnect();
    };
  }, []);

  return (
    <div style={{
      minHeight: '100vh',
      background: 'rgba(255,255,255,0.94)',
      padding: '16px',
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
    }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          background: 'linear-gradient(135deg, #0081F7, #FF75CA)',
          color: 'white',
          fontWeight: 700,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}>OD</div>
        <h1 style={{ fontSize: '1.05rem', margin: 0 }}>OpenDia</h1>
        <nav style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          <TabButton active={tab === 'chat'} onClick={() => setTab('chat')}>Chat</TabButton>
          <TabButton active={tab === 'settings'} onClick={() => setTab('settings')}>Settings</TabButton>
        </nav>
      </header>

      {tab === 'chat'
        ? <ChatSurface />
        : <McpBridge
            status={status}
            toolCount={toolCount}
            toolNames={toolNames}
            error={error}
          />}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        border: '1px solid rgba(0,129,247,0.25)',
        background: active ? 'rgba(0,129,247,0.15)' : 'transparent',
        color: active ? '#0057b7' : '#374151',
        padding: '4px 10px',
        borderRadius: 6,
        cursor: 'pointer',
        fontWeight: 600,
        fontSize: '0.8rem',
      }}
    >{children}</button>
  );
}
