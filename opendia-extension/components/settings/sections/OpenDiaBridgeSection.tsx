// OpenDia MCP Bridge settings section. Shows daemon WS status, advertised
// tool count via loopback MCP, current tab, editable WS URL, plus reconnect
// / disconnect controls. Feature-parity with the pre-merge OpenDia popup
// (SPEC docs/specs/opendia-cebian-merge.md §Phase 3 M4).
//
// Also hosts the "Native tools for sidebar agent" toggle: when enabled the
// Cebian agent gets 11 core browser_* tools + 2 meta-tools (opendia_list_tools
// / opendia_call_tool) exposed as first-class AgentTool[] in-process — no
// MCP round-trip. Users can edit the whitelist to promote/demote tools.
import { useEffect, useRef, useState } from 'react';
import { Plug, RefreshCw, Unplug, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { connectLoopback, type LoopbackClient } from '@/lib/loopback-mcp/transport';
import { opendiaOpenBehaviour, type OpendiaOpenBehaviour } from '@/lib/persistence/storage';
import {
  opendiaNativeEnabled,
  opendiaNativeWhitelist,
  OPENDIA_NATIVE_DEFAULT_CORE,
} from '@/lib/tools/opendia-native';

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

      <OpenBehaviourPicker />

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

      <Separator />

      <NativeToolsPanel toolNames={toolNames} />
    </div>
  );
}

function NativeToolsPanel({ toolNames }: { toolNames: string[] }) {
  const [enabled, setEnabled] = useState(true);
  const [whitelist, setWhitelist] = useState<string[]>([...OPENDIA_NATIVE_DEFAULT_CORE]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    Promise.all([
      opendiaNativeEnabled.getValue(),
      opendiaNativeWhitelist.getValue(),
    ]).then(([e, w]) => {
      setEnabled(e);
      setWhitelist(w);
      setReady(true);
    });
  }, []);

  const toggle = (v: boolean) => {
    setEnabled(v);
    void opendiaNativeEnabled.setValue(v);
  };
  const flip = (name: string) => {
    setWhitelist((prev) => {
      const next = prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name];
      void opendiaNativeWhitelist.setValue(next);
      return next;
    });
  };
  const resetDefaults = () => {
    const defaults = [...OPENDIA_NATIVE_DEFAULT_CORE];
    setWhitelist(defaults);
    void opendiaNativeWhitelist.setValue(defaults);
  };

  const wlSet = new Set(whitelist);
  const inList = toolNames.filter((n) => wlSet.has(n));
  const outList = toolNames.filter((n) => !wlSet.has(n));

  return (
    <div className="rounded-md border border-border p-3 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 space-y-1">
          <div className="flex items-center gap-2 font-medium text-sm">
            <Wrench className="size-4" />
            Sidebar agent tools (in-process)
          </div>
          <p className="text-xs text-muted-foreground">
            Expose the whitelisted browser_* tools to the Cebian sidebar agent as
            first-class AgentTools. The remaining long-tail is reachable via
            opendia_list_tools + opendia_call_tool meta-tools to save prompt tokens.
          </p>
        </div>
        <Switch checked={enabled} onCheckedChange={toggle} disabled={!ready} />
      </div>

      {enabled && (
        <>
          <div className="text-xs text-muted-foreground">
            Core whitelist: {inList.length} · Long-tail (meta-only): {outList.length}
          </div>

          <details className="text-sm">
            <summary className="cursor-pointer font-medium">
              Edit whitelist ({whitelist.length})
            </summary>
            <div className="mt-2 max-h-72 overflow-auto space-y-1 pr-2">
              {toolNames.length === 0 ? (
                <div className="text-xs text-muted-foreground">
                  Loopback tools not loaded yet.
                </div>
              ) : (
                toolNames.map((name) => (
                  <label key={name} className="flex items-center gap-2 text-xs font-mono cursor-pointer">
                    <Checkbox
                      checked={wlSet.has(name)}
                      onCheckedChange={() => flip(name)}
                    />
                    <span>{name}</span>
                  </label>
                ))
              )}
            </div>
          </details>

          <Button variant="outline" size="sm" onClick={resetDefaults}>
            Reset to defaults
          </Button>
        </>
      )}
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

// Toolbar-click behaviour picker. Users on Arc (or any Chromium fork
// that silently drops chrome.sidePanel) can force the popup-window
// fallback here without hunting through DevTools.
function OpenBehaviourPicker() {
  const [mode, setMode] = useState<OpendiaOpenBehaviour>('auto');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    opendiaOpenBehaviour.getValue().then((v) => {
      setMode(v);
      setReady(true);
    });
  }, []);

  const pick = (v: OpendiaOpenBehaviour) => {
    setMode(v);
    void opendiaOpenBehaviour.setValue(v);
  };

  return (
    <div className="rounded-md border border-border p-3 space-y-2">
      <Label className="text-sm font-medium">Toolbar-click behaviour</Label>
      <p className="text-xs text-muted-foreground">
        Chrome / Edge / Brave support the native side panel. Arc silently drops
        it — pick "popup window" there for a detachable sidebar you can dock
        beside the current tab.
      </p>
      <div className="flex flex-col gap-1 text-sm">
        {(['auto', 'panel', 'window'] as const).map((opt) => (
          <label key={opt} className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="opendia-open-behaviour"
              value={opt}
              checked={mode === opt}
              onChange={() => pick(opt)}
              disabled={!ready}
            />
            <span>
              <span className="font-medium">{opt}</span>
              {' — '}
              <span className="text-muted-foreground text-xs">
                {opt === 'auto'
                  ? 'try native side panel, fall back to popup window if it fails'
                  : opt === 'panel'
                  ? 'native side panel only (do nothing on Arc)'
                  : 'always open as a popup window (works everywhere)'}
              </span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
