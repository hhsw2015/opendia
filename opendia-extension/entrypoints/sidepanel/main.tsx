// Phase 2 sidepanel React shell. Minimal — proves the WXT sidepanel
// entrypoint boots, the loopback MCP port speaks, and tools/list returns
// the same tool count the WebSocket transport exposes to the daemon.
// Phase 3 will replace this with Cebian's chat UI.
//
// Kill switch: OPENDIA_CHAT_UI in chrome.storage.local. "0" hides the UI
// (rollback path per SPEC §2 invariants). Default (missing key) = enabled.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

async function bootstrap() {
  const root = document.getElementById('root');
  if (!root) return;
  const bp: any = (globalThis as any).browser ?? (globalThis as any).chrome;
  const flag = await new Promise<string | null>((resolve) => {
    try {
      bp.storage.local.get(['OPENDIA_CHAT_UI'], (r: Record<string, unknown>) => {
        const v = r?.OPENDIA_CHAT_UI;
        resolve(v == null ? null : String(v));
      });
    } catch {
      resolve(null);
    }
  });
  if (flag === '0') {
    root.innerHTML = `
      <div style="padding:24px;font-family:sans-serif;color:#374151;background:rgba(255,255,255,0.9);min-height:100vh;">
        <h2 style="margin-top:0">Sidepanel disabled</h2>
        <p>OPENDIA_CHAT_UI is set to "0" in chrome.storage.local. Remove the
        key (or set it to "1") to re-enable this panel.</p>
      </div>`;
    return;
  }
  createRoot(root).render(<App />);
}

bootstrap();
