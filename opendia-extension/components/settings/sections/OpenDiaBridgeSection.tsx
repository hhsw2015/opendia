// OpenDia MCP Bridge settings section. Shows daemon WS status, advertised
// tool count via loopback MCP, current tab, editable WS URL, plus reconnect
// / disconnect controls. Feature-parity with the pre-merge OpenDia popup
// (SPEC docs/specs/opendia-cebian-merge.md §Phase 3 M4).
import { useEffect, useRef, useState } from 'react';
import { Plug, RefreshCw, Unplug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { connectLoopback, type LoopbackClient } from '@/lib/loopback-mcp/transport';

type Status = 'connecting' | 'connected' | 'disconnected';

const DEFAULT_WS_URL = 'ws://127.0.0.1:5555/';

export function OpenDiaBridgeSection() {
  const [loopStatus, setLoopStatus] = useState<Status>('connecting');
  const [toolCount, setToolCount] = useState<number | null>(null);
  const [toolNames, setToolNames] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [daemonStatus, setDaemonStatus] = useState<Status>('connecting');
  const [wsUrl, setWsUrl] = useState(DEFAULT_WS_URL);
  const [currentTab, setCurrentTab] = useState<{ id?: number; url?: string; title?: string }>({});
  const clientRef = useRef<LoopbackClient | null>(null);

  useEffect(() => {
    let cancelled = false;
    const client = connectLoopback();
    clientRef.current = client;
    client.toolsList().then(
      (tools) => {
        if (cancelled) return;
        const names = (tools as Array<{ name: string }>).map((t) => t.name);
        setToolCount(names.length);
        setToolNames(names);
        setLoopStatus('connected');
      },
      (err) => {
        if (cancelled) return;
        setError(err?.message ?? String(err));
        setLoopStatus('disconnected');
      },
    );
    return () => {
      cancelled = true;
      client.disconnect();
    };
  }, []);

  useEffect(() => {
    const bp: any = (globalThis as any).browser ?? (globalThis as any).chrome;
    (async () => {
      const persisted = await new Promise<Record<string, unknown>>((resolve) => {
        try { bp.storage?.local?.get?.(['cebian:mcp:wsUrl'], (r: any) => resolve(r || {})); }
        catch { resolve({}); }
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
      } catch { /* no tabs perm */ }
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
    <div className="p-4 space-y-4 max-w-2xl">
      <div className="flex items-center gap-2">
        <Plug className="size-5" />
        <h2 className="text-lg font-semibold">OpenDia MCP Bridge</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Connects the extension to the Everywhere daemon over WebSocket, exposing 164 browser
        automation tools. The daemon proxies these to Claude Code / Cursor / any MCP client.
      </p>

      <div className="rounded-md border border-border p-3 space-y-2">
        <StatusRow label="Daemon" value={daemonStatus} />
        <StatusRow label="Loopback MCP" value={loopStatus} />
        <div className="flex justify-between items-center text-sm">
          <span className="text-muted-foreground">Advertised tools</span>
          <span className="font-semibold">{toolCount ?? '—'}</span>
        </div>
        <div className="flex justify-between items-center text-sm gap-2">
          <span className="text-muted-foreground shrink-0">Current tab</span>
          <span className="truncate max-w-[60%] text-right">
            {currentTab.id != null ? `${currentTab.id} · ${currentTab.title ?? currentTab.url ?? '—'}` : '—'}
          </span>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="opendia-ws-url">WebSocket URL</Label>
        <Input
          id="opendia-ws-url"
          value={wsUrl}
          onChange={(e) => saveWsUrl(e.target.value)}
          placeholder={DEFAULT_WS_URL}
          className="font-mono text-sm"
        />
        <p className="text-xs text-muted-foreground">
          The Everywhere daemon binds this endpoint on localhost. Only the extension speaks
          to it; MCP clients reach the daemon over HTTP on 127.0.0.1:7878.
        </p>
      </div>

      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={reconnect} className="gap-1.5">
          <RefreshCw className="size-3.5" /> Reconnect
        </Button>
        <Button variant="outline" size="sm" onClick={disconnect} className="gap-1.5">
          <Unplug className="size-3.5" /> Disconnect
        </Button>
      </div>

      {error && (
        <div className="text-sm text-destructive rounded-md border border-destructive/40 p-2 bg-destructive/5">
          {error}
        </div>
      )}

      <Separator />

      <details className="rounded-md border border-border p-3">
        <summary className="cursor-pointer font-medium text-sm">
          Advertised tools ({toolNames.length})
        </summary>
        <div className="mt-2 max-h-72 overflow-auto font-mono text-xs text-muted-foreground space-y-0.5">
          {toolNames.length === 0 ? '—' : toolNames.map((n) => <div key={n}>{n}</div>)}
        </div>
      </details>
    </div>
  );
}

function StatusRow({ label, value }: { label: string; value: Status }) {
  const color =
    value === 'connected' ? 'bg-green-500' :
    value === 'disconnected' ? 'bg-red-500' :
    'bg-muted-foreground';
  return (
    <div className="flex justify-between items-center text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="inline-flex items-center gap-1.5">
        <span className={`inline-block size-2 rounded-full ${color}`} />
        <span className="font-medium">{value}</span>
      </span>
    </div>
  );
}
