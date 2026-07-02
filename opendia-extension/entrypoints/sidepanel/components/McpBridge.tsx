// SPEC docs/specs/opendia-cebian-merge.md §Phase 3 — "Settings → MCP Bridge".
// Feature-parity target with the old popup: daemon status pill, advertised
// tool count, current tab, WebSocket URL, reconnect/disconnect controls.
// Advanced fields (log tail, connected MCP client count/names) are stubbed
// until the daemon exposes them via a status frame.
import React from 'react';

interface Props {
  status: 'connecting' | 'connected' | 'error';
  toolCount: number | null;
  toolNames: string[];
  error: string | null;
}

const DEFAULT_WS_URL = 'ws://127.0.0.1:5555/';

export function McpBridge({ status, toolCount, toolNames, error }: Props) {
  const [wsUrl, setWsUrl] = React.useState(DEFAULT_WS_URL);
  const [daemonStatus, setDaemonStatus] = React.useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [currentTab, setCurrentTab] = React.useState<{ id?: number; url?: string; title?: string }>({});

  React.useEffect(() => {
    const bp: any = (globalThis as any).browser ?? (globalThis as any).chrome;
    (async () => {
      const persisted = await new Promise<Record<string, unknown>>((resolve) => {
        try {
          bp.storage?.local?.get?.(['cebian:mcp:wsUrl'], (r: Record<string, unknown>) => resolve(r || {}));
        } catch { resolve({}); }
      });
      if (typeof persisted['cebian:mcp:wsUrl'] === 'string') {
        setWsUrl(persisted['cebian:mcp:wsUrl'] as string);
      }
    })();

    const refreshStatus = () => {
      try {
        bp.runtime?.sendMessage?.({ action: 'getStatus' }, (resp: any) => {
          if (bp.runtime?.lastError) { setDaemonStatus('disconnected'); return; }
          setDaemonStatus(resp?.connected ? 'connected' : 'disconnected');
        });
      } catch { setDaemonStatus('disconnected'); }
      try {
        bp.tabs?.query?.({ active: true, currentWindow: true }, (tabs: any[]) => {
          const t = tabs?.[0];
          if (t) setCurrentTab({ id: t.id, url: t.url, title: t.title });
        });
      } catch { /* no tabs perm — leave blank */ }
    };
    refreshStatus();
    const iv = setInterval(refreshStatus, 4000);
    return () => clearInterval(iv);
  }, []);

  const reconnect = () => {
    const bp: any = (globalThis as any).browser ?? (globalThis as any).chrome;
    try { bp.runtime.sendMessage({ action: 'reconnect' }, () => {}); } catch {}
  };
  const disconnect = () => {
    const bp: any = (globalThis as any).browser ?? (globalThis as any).chrome;
    try { bp.runtime.sendMessage({ action: 'disconnect' }, () => {}); } catch {}
  };
  const saveWsUrl = (v: string) => {
    setWsUrl(v);
    const bp: any = (globalThis as any).browser ?? (globalThis as any).chrome;
    try { bp.storage?.local?.set?.({ 'cebian:mcp:wsUrl': v }); } catch {}
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Card>
        <Row label="Daemon">
          <StatusPill value={daemonStatus} />
        </Row>
        <Row label="Loopback MCP">
          <StatusPill value={status === 'connected' ? 'connected' : status === 'error' ? 'disconnected' : 'connecting'} />
        </Row>
        <Row label="Advertised tools">
          <span style={{ fontWeight: 600 }}>{toolCount ?? '…'}</span>
        </Row>
        <Row label="Current tab">
          <span style={{ maxWidth: 220, textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
            {currentTab.id != null ? `${currentTab.id} · ${currentTab.title ?? currentTab.url ?? '—'}` : '—'}
          </span>
        </Row>
        <Row label="WebSocket">
          <input
            value={wsUrl}
            onChange={(e) => saveWsUrl(e.target.value)}
            style={{
              width: 200,
              padding: '4px 8px',
              border: '1px solid #d1d5db',
              borderRadius: 4,
              fontSize: '0.8rem',
              fontFamily: 'ui-monospace, SFMono-Regular, monospace',
            }}
          />
        </Row>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <MiniButton onClick={reconnect}>Reconnect</MiniButton>
          <MiniButton onClick={disconnect}>Disconnect</MiniButton>
        </div>
        {error && (
          <div style={{ color: '#ef4444', marginTop: 8, fontSize: '0.8rem' }}>{error}</div>
        )}
      </Card>

      <details style={{ background: 'rgba(255,255,255,0.7)', border: '1px solid rgba(0,129,247,0.15)', borderRadius: 8, padding: 8 }}>
        <summary style={{ fontWeight: 600, cursor: 'pointer', fontSize: '0.85rem' }}>Advertised tools ({toolNames.length})</summary>
        <div style={{ fontSize: '0.7rem', color: '#374151', maxHeight: 260, overflow: 'auto', marginTop: 6, fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}>
          {toolNames.length === 0 ? '—' : toolNames.map((n) => <div key={n}>{n}</div>)}
        </div>
      </details>

      <footer style={{ marginTop: 'auto', fontSize: '0.65rem', color: '#6b7280' }}>
        Phase 3 scaffold. Cebian chat UI verbatim import pending.
      </footer>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ background: 'rgba(255,255,255,0.75)', padding: 12, borderRadius: 8, border: '1px solid rgba(0,129,247,0.15)' }}>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '3px 0', fontSize: '0.8rem' }}>
      <span style={{ color: '#6b7280' }}>{label}</span>
      <div>{children}</div>
    </div>
  );
}

function StatusPill({ value }: { value: 'connecting' | 'connected' | 'disconnected' }) {
  const color = value === 'connected' ? '#22c55e' : value === 'disconnected' ? '#ef4444' : '#6b7280';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
      <span style={{ fontWeight: 600, color }}>{value}</span>
    </span>
  );
}

function MiniButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        border: '1px solid rgba(0,129,247,0.3)',
        background: 'rgba(255,255,255,0.4)',
        color: '#0057b7',
        padding: '4px 12px',
        borderRadius: 4,
        cursor: 'pointer',
        fontWeight: 600,
        fontSize: '0.75rem',
      }}
    >{children}</button>
  );
}
