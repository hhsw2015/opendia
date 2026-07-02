// Phase 2 App: single-panel debug view. Renders tool count from the
// loopback MCP transport as a live badge — this is the SPEC's M2/M3
// smoke test surface (see §Phase 2 acceptance).
import React from 'react';
import { connectLoopback, type LoopbackClient } from '../../lib/loopback-mcp/transport';

export function App() {
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
      background: 'rgba(255,255,255,0.9)',
      padding: '20px',
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
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
        <h1 style={{ fontSize: '1.1rem', margin: 0 }}>OpenDia sidepanel</h1>
      </header>

      <section style={{
        padding: 12,
        borderRadius: 8,
        background: 'rgba(255,255,255,0.7)',
        border: '1px solid rgba(0,129,247,0.15)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>Loopback MCP</span>
          <span style={{
            fontWeight: 600,
            color: status === 'connected' ? '#22c55e' : status === 'error' ? '#ef4444' : '#6b7280',
          }}>
            {status}
          </span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
          <span>Tools</span>
          <span style={{ fontWeight: 600 }}>{toolCount ?? '…'}</span>
        </div>
        {error && (
          <div style={{ color: '#ef4444', marginTop: 8, fontSize: '0.85rem' }}>{error}</div>
        )}
      </section>

      <section style={{
        padding: 12,
        borderRadius: 8,
        background: 'rgba(255,255,255,0.7)',
        border: '1px solid rgba(0,129,247,0.15)',
        fontSize: '0.75rem',
        color: '#374151',
        maxHeight: 300,
        overflow: 'auto',
      }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Advertised tools</div>
        {toolNames.length === 0 ? '—' : toolNames.map((n) => (
          <div key={n} style={{ fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}>{n}</div>
        ))}
      </section>

      <footer style={{ marginTop: 'auto', fontSize: '0.7rem', color: '#6b7280' }}>
        Phase 2 scaffold. Chat UI arrives in Phase 3.
      </footer>
    </div>
  );
}
