// Phase 2 loopback MCP transport. Speaks the same wire frames as the
// WebSocket bridge (opendia-mcp/server.js) so both transports feed the
// same dispatcher in background.js. The client (sidepanel) connects a
// runtime port named "mcp-loopback"; background.js has been extended to
// receive frames on that port and reply via a per-call replyTo function.
//
// This is deliberately minimal — no @modelcontextprotocol/sdk wrapping yet.
// Phase 3 wires the MCP client SDK on top; Phase 2 only proves the
// transport works and both routes return byte-identical tools/list JSON.
export type LoopbackFrame =
  | { type: 'tools/list' }
  | { id: string; method: string; params?: unknown };

export type LoopbackReply =
  | { type: 'tools'; tools: unknown[] }
  | { id: string; result?: unknown; error?: unknown };

export interface LoopbackClient {
  toolsList(): Promise<unknown[]>;
  call(method: string, params?: unknown): Promise<unknown>;
  disconnect(): void;
}

const PORT_NAME = 'mcp-loopback';

export function connectLoopback(): LoopbackClient {
  const bp: any = (globalThis as any).browser ?? (globalThis as any).chrome;
  const port = bp.runtime.connect({ name: PORT_NAME });
  let pendingId = 0;
  const waiters = new Map<string, (r: LoopbackReply) => void>();
  let toolsWaiter: ((tools: unknown[]) => void) | null = null;
  let toolsRejector: ((e: unknown) => void) | null = null;

  port.onMessage.addListener((reply: LoopbackReply) => {
    if ((reply as any).type === 'tools') {
      const w = toolsWaiter;
      toolsWaiter = null;
      toolsRejector = null;
      w?.((reply as any).tools);
      return;
    }
    const id = (reply as any).id;
    const w = id != null ? waiters.get(String(id)) : undefined;
    if (w) {
      waiters.delete(String(id));
      w(reply);
    }
  });

  port.onDisconnect.addListener(() => {
    for (const w of waiters.values()) w({ id: '', error: { message: 'port disconnected' } } as any);
    waiters.clear();
    toolsRejector?.(new Error('port disconnected'));
    toolsWaiter = null;
    toolsRejector = null;
  });

  return {
    toolsList() {
      return new Promise<unknown[]>((resolve, reject) => {
        toolsWaiter = resolve;
        toolsRejector = reject;
        port.postMessage({ type: 'tools/list' });
      });
    },
    call(method, params) {
      return new Promise((resolve, reject) => {
        const id = `lp-${++pendingId}`;
        waiters.set(id, (reply) => {
          if ('error' in reply && reply.error) reject(reply.error);
          else resolve((reply as any).result);
        });
        port.postMessage({ id, method, params });
      });
    },
    disconnect() {
      try { port.disconnect(); } catch { /* already closed */ }
    },
  };
}
