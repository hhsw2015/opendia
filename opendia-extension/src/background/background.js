// Import WebExtension polyfill at the top
if (typeof browser === 'undefined' && typeof chrome !== 'undefined') {
  globalThis.browser = chrome;
}

// Browser detection
const browserInfo = {
  isFirefox: typeof browser !== 'undefined' && browser.runtime.getManifest().applications?.gecko,
  isChrome: typeof chrome !== 'undefined' && !browser.runtime.getManifest().applications?.gecko,
  isServiceWorker: typeof importScripts === 'function',
  manifestVersion: browser.runtime.getManifest().manifest_version
};

console.log('🌐 Browser detected:', browserInfo);

// MCP Server connection configuration
let MCP_SERVER_URL = 'ws://localhost:5555'; // Default, will be auto-discovered
let lastKnownPorts = { websocket: 5555, http: 5556 }; // Cache for port discovery

// Safety Mode configuration
let safetyModeEnabled = false;
const WRITE_EDIT_TOOLS = [
  'element_click',
  'element_fill'
];

// Load safety mode state on startup
browser.storage.local.get(['safetyMode'], (result) => {
  safetyModeEnabled = result.safetyMode || false;
});

// Cross-browser WebSocket connection manager
class ConnectionManager {
  constructor() {
    this.mcpSocket = null;
    this.reconnectInterval = null;
    this.reconnectAttempts = 0;
    this.heartbeatInterval = null;
    this.isServiceWorker = browserInfo.isServiceWorker;
    this.isFirefox = browserInfo.isFirefox;
    // User-set "stay disconnected" flag. Persisted in chrome.storage so it
    // survives MV3 service-worker restarts. While true, connect() is a
    // no-op and scheduleReconnect / heartbeat won't pull us back. Lets the
    // same OpenDia ext binary live in multiple browsers without fighting
    // over the single :5555 server.
    this.manualDisconnect = false;
    // Race fix: keep the storage-load promise so every connect() path
    // can await it. Without this, an early connect() (heartbeat,
    // scheduleReconnect, or module-load self-connect right after MV3
    // SW restart) runs while manualDisconnect is still its default
    // false, opening a websocket the user explicitly disconnected.
    this.ready = this._loadManualFlag();
  }

  async _loadManualFlag() {
    try {
      const r = await browser.storage.local.get('manual_disconnect');
      this.manualDisconnect = r && r.manual_disconnect === true;
      if (this.manualDisconnect) console.log('🔌 OpenDia: starting in manual-disconnect mode (storage flag set)');
    } catch (e) {
      console.warn('OpenDia: failed to load manual_disconnect flag', e);
    }
  }

  async _persistManualFlag(val) {
    try { await browser.storage.local.set({ manual_disconnect: !!val }); } catch {}
  }

  async manualDisconnectNow() {
    this.manualDisconnect = true;
    await this._persistManualFlag(true);
    this.clearReconnectInterval();
    this.clearHeartbeat();
    if (this.mcpSocket) {
      try { this.mcpSocket.close(1000, 'user disconnect'); } catch {}
      this.mcpSocket = null;
    }
    console.log('🔌 OpenDia: manual disconnect — will not auto-reconnect until user clicks Reconnect.');
  }

  async manualReconnectNow() {
    this.manualDisconnect = false;
    await this._persistManualFlag(false);
    this.reconnectAttempts = 0;
    return this.connect();
  }

  async connect() {
    // Wait for the persisted manual_disconnect flag to load before
    // honoring connect() — otherwise an SW-startup connect can race
    // ahead of storage and reopen a socket the user disabled.
    if (this.ready) await this.ready;
    if (this.manualDisconnect) {
      console.log('🔌 OpenDia: skipping connect (manual-disconnect flag set)');
      return;
    }
    if (this.isServiceWorker) {
      // Chrome MV3: reuse if already open, otherwise create.
      // Opening a fresh socket on every message races the inbound
      // request — the new socket is still CONNECTING when the result
      // callback runs, so connectionManager.send() drops the reply.
      if (this.mcpSocket && this.mcpSocket.readyState === WebSocket.OPEN) {
        console.log('🔧 Chrome MV3: reusing open connection');
        return;
      }
      console.log('🔧 Chrome MV3: opening connection');
      await this.createConnection();
    } else {
      // Firefox MV2: Maintain persistent connection
      if (!this.mcpSocket || this.mcpSocket.readyState !== WebSocket.OPEN) {
        console.log('🦊 Firefox MV2: Creating persistent connection');
        await this.createConnection();
      } else {
        console.log('🦊 Firefox MV2: Using existing connection');
      }
    }
  }

  async createConnection() {
    try {
      // Try port discovery if using default URL or if connection failed
      if (MCP_SERVER_URL === 'ws://localhost:5555' || this.reconnectAttempts > 2) {
        await this.discoverServerPorts();
        this.reconnectAttempts = 0; // Reset attempts after discovery
      }

      console.log('🔗 Connecting to MCP server at', MCP_SERVER_URL);
      this.mcpSocket = new WebSocket(MCP_SERVER_URL);
      const socket = this.mcpSocket;

      // Block until the socket is actually OPEN (or errors). Without
      // this, createConnection resolves while readyState is still
      // CONNECTING, and the very next connectionManager.send() drops
      // the message because it checks readyState === OPEN.
      const opened = new Promise((resolve, reject) => {
        const onOpenOnce = () => { socket.removeEventListener('error', onErrOnce); resolve(); };
        const onErrOnce = (e) => { socket.removeEventListener('open', onOpenOnce); reject(e); };
        socket.addEventListener('open', onOpenOnce, { once: true });
        socket.addEventListener('error', onErrOnce, { once: true });
      });

      this.mcpSocket.onopen = () => {
        console.log('✅ Connected to MCP server');
        this.clearReconnectInterval();
        this.reconnectAttempts = 0; // Reset attempts on successful connection

        const tools = getAvailableTools();
        console.log(`🔧 Registering ${tools.length} tools:`, tools.map(t => t.name));

        // Register available browser functions
        this.mcpSocket.send(JSON.stringify({
          type: 'register',
          tools: tools
        }));

        // Heartbeat in both modes. In Chrome MV3 the websocket frame
        // activity itself resets the service-worker idle timer.
        this.setupHeartbeat();
      };

      this.mcpSocket.onmessage = async (event) => {
        const message = JSON.parse(event.data);
        // Server-driven keep-alive: ignore ping frames at the handler
        // level. The websocket activity alone is what keeps the MV3
        // service worker idle timer reset (Chrome 124+ behavior).
        if (message && message.type === 'ping') return;
        await handleMCPRequest(message);
      };

      this.mcpSocket.onclose = (event) => {
        console.log(`❌ Disconnected from MCP server (code: ${event.code}, reason: ${event.reason})`);
        this.clearHeartbeat(); // Clear heartbeat on disconnect
        this.reconnectAttempts++;

        // Check if this was a normal closure or abnormal
        if (event.code !== 1000 && event.code !== 1001) {
          console.log('🔄 Abnormal WebSocket closure, will attempt reconnection');

          if (!this.isServiceWorker) {
            // Firefox: Attempt to reconnect
            this.scheduleReconnect();
          }
          // Chrome: Will reconnect on next message
        } else {
          console.log('🔄 Normal WebSocket closure');
        }
      };

      this.mcpSocket.onerror = (error) => {
        console.log('⚠️ MCP WebSocket error:', error);
        this.reconnectAttempts++;
      };

      // Block resolution until the handshake actually completes.
      await opened;

    } catch (error) {
      console.error('Connection failed:', error);
      if (!this.isServiceWorker) {
        this.scheduleReconnect();
      }
    }
  }

  async discoverServerPorts() {
    // Try common HTTP ports to find the server
    const commonPorts = [5556, 5557, 5558, 3001, 6001, 6002, 6003];
    
    for (const httpPort of commonPorts) {
      try {
        const response = await fetch(`http://localhost:${httpPort}/ports`);
        if (response.ok) {
          const portInfo = await response.json();
          console.log('🔍 Discovered server ports:', portInfo);
          lastKnownPorts = { websocket: portInfo.websocket, http: portInfo.http };
          MCP_SERVER_URL = portInfo.websocketUrl;
          return portInfo;
        }
      } catch (error) {
        // Port not available or not OpenDia server, continue searching
      }
    }
    
    console.log('⚠️ Port discovery failed, using defaults');
    return null;
  }

  setupHeartbeat() {
    // Client-driven heartbeat. Originally only enabled in Firefox MV2;
    // now also enabled in Chrome MV3 because websocket frame activity
    // resets the MV3 service-worker idle timer (Chrome 124+).
    this.clearHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.mcpSocket?.readyState === WebSocket.OPEN) {
        this.mcpSocket.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
      } else if (this.mcpSocket?.readyState === WebSocket.CLOSED) {
        console.log('🔄 WebSocket closed, attempting reconnection...');
        this.connect();
      }
    }, 15000);
  }

  clearHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  scheduleReconnect() {
    this.clearReconnectInterval();
    
    // Exponential backoff for reconnection attempts
    const backoffTime = Math.min(5000 * Math.pow(2, this.reconnectAttempts), 30000);
    console.log(`🔄 Scheduling reconnection in ${backoffTime}ms (attempt ${this.reconnectAttempts})`);
    
    this.reconnectInterval = setInterval(() => {
      if (this.reconnectAttempts < 10) {
        this.connect();
      } else {
        console.log('❌ Maximum reconnection attempts reached');
        this.clearReconnectInterval();
      }
    }, backoffTime);
  }

  clearReconnectInterval() {
    if (this.reconnectInterval) {
      clearInterval(this.reconnectInterval);
      this.reconnectInterval = null;
    }
  }

  async ensureConnection() {
    if (this.isServiceWorker) {
      // Chrome: Always create fresh connection
      await this.connect();
    } else {
      // Firefox: Use existing or create new
      if (!this.mcpSocket || this.mcpSocket.readyState !== WebSocket.OPEN) {
        await this.connect();
      }
    }
    return this.mcpSocket;
  }

  send(message) {
    if (this.mcpSocket && this.mcpSocket.readyState === WebSocket.OPEN) {
      this.mcpSocket.send(JSON.stringify(message));
    } else {
      console.error('WebSocket not connected');
    }
  }

  getStatus() {
    return {
      connected: this.mcpSocket && this.mcpSocket.readyState === WebSocket.OPEN,
      manualDisconnect: this.manualDisconnect,
      browserInfo: browserInfo,
      connectionType: this.isServiceWorker ? 'temporary' : 'persistent'
    };
  }
}

// Create global connection manager
const connectionManager = new ConnectionManager();

// Content script management for background tabs
async function ensureContentScriptReady(tabId, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Test if content script is responsive
      const response = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Content script ping timeout'));
        }, 2000);
        
        browser.tabs.sendMessage(tabId, { action: 'ping' }, (response) => {
          clearTimeout(timeout);
          if (browser.runtime.lastError) {
            reject(new Error(browser.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      });
      
      if (response && response.success) {
        console.log(`✅ Content script ready in tab ${tabId}`);
        return true;
      }
    } catch (error) {
      console.log(`⚠️ Content script not responsive in tab ${tabId}, attempt ${attempt}/${retries}`);
      
      if (attempt === retries) {
        // Last attempt - try to inject content script
        try {
          const tab = await browser.tabs.get(tabId);
          
          // Check if tab URL is injectable (not chrome://, chrome-extension://, etc.)
          if (!isInjectableUrl(tab.url)) {
            throw new Error(`Cannot inject content script into ${tab.url} - restricted URL`);
          }
          
          console.log(`🔄 Injecting content script into tab ${tabId}`);
          
          // Use appropriate API based on browser
          if (browser.scripting) {
            // Chrome MV3
            await browser.scripting.executeScript({
              target: { tabId: tabId },
              files: ['src/content/content.js']
            });
          } else {
            // Firefox MV2 - check if already injected first
            try {
              const result = await browser.tabs.executeScript(tabId, {
                code: 'typeof window.OpenDiaContentScriptLoaded !== "undefined"'
              });
              
              if (result && result[0]) {
                console.log(`🔄 Content script already present in tab ${tabId}`);
                return true;
              }
            } catch (e) {
              // Continue with injection if check fails
            }
            
            await browser.tabs.executeScript(tabId, {
              file: 'src/content/content.js'
            });
          }
          
          // Wait a moment for script to initialize
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          // Test again
          const testResponse = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timeout after injection')), 3000);
            browser.tabs.sendMessage(tabId, { action: 'ping' }, (response) => {
              clearTimeout(timeout);
              if (browser.runtime.lastError) {
                reject(new Error(browser.runtime.lastError.message));
              } else {
                resolve(response);
              }
            });
          });
          
          if (testResponse && testResponse.success) {
            console.log(`✅ Content script successfully injected into tab ${tabId}`);
            return true;
          }
          
        } catch (injectionError) {
          throw new Error(`Failed to inject content script into tab ${tabId}: ${injectionError.message}`);
        }
      }
      
      // Wait before retry
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }
  
  throw new Error(`Content script not available in tab ${tabId} after ${retries} attempts`);
}

// Check if URL allows content script injection
function isInjectableUrl(url) {
  if (!url) return false;
  
  const restrictedProtocols = ['chrome:', 'chrome-extension:', 'chrome-devtools:', 'edge:', 'moz-extension:', 'about:'];
  const restrictedDomains = ['chrome.google.com', 'addons.mozilla.org'];
  
  // Check protocol
  if (restrictedProtocols.some(protocol => url.startsWith(protocol))) {
    return false;
  }
  
  // Check special browser pages
  if (url.startsWith('https://chrome.google.com/webstore') || 
      url.includes('chrome://') || 
      restrictedDomains.some(domain => url.includes(domain))) {
    return false;
  }
  
  return true;
}

// Get content script readiness status for a tab
async function getTabContentScriptStatus(tabId) {
  try {
    const tab = await browser.tabs.get(tabId);
    
    if (!isInjectableUrl(tab.url)) {
      return { ready: false, reason: 'restricted_url', url: tab.url };
    }
    
    const response = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => resolve(null), 3000); // Increase to 3 seconds
      browser.tabs.sendMessage(tabId, { action: 'ping' }, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });
    });
    
    if (response && response.success) {
      return { ready: true, reason: 'active', url: tab.url };
    } else {
      return { ready: false, reason: 'not_loaded', url: tab.url };
    }
    
  } catch (error) {
    return { ready: false, reason: 'tab_error', error: error.message };
  }
}

// Define available browser automation tools for MCP
function getAvailableTools() {
  return [
    /*
    🎯 BACKGROUND TAB WORKFLOW GUIDE:
    
    1. DISCOVER TABS: Use tab_list with check_content_script=false to see all tabs and their IDs
    2. TARGET SPECIFIC TABS: Add tab_id parameter to any tool to work on background tabs
    3. MULTI-TAB OPERATIONS: Process multiple tabs without switching between them
    
    Example Multi-Tab Workflow:
    - tab_list({check_content_script: false}) → Get tab IDs quickly
    - page_analyze({intent_hint: "article", tab_id: 12345}) → Analyze background research tab
    - page_extract_content({content_type: "article", tab_id: 12345}) → Extract content without switching
    - get_selected_text({tab_id: 67890}) → Get quotes from another background tab
    
    Perfect for: Research workflows, content analysis, form processing, social media management
    */
    
    // Page Analysis Tools
    {
      // SPEC §4.1 — the compact a11y/DOM snapshot + ref map. Prereq for
      // every ref-dependent ab parity tool (click/fill/hover/...).
      // Cheap: prefer this over page_extract_content for navigation use.
      name: "snapshot",
      description: "📐 SPEC §4.1: compact a11y/DOM snapshot with @refN anchors. Prefer this for navigation discovery; pair @refN with the matching click/fill tool. Cheap; returns ~100-400 nodes.",
      inputSchema: {
        type: "object",
        properties: {
          interactive_only: {
            type: "boolean",
            default: false,
            description: "If true, only nodes with an actionable role/tag/onclick/tabindex are listed.",
          },
          max_nodes: {
            type: "number",
            default: 400,
            description: "Soft cap on emitted nodes; sets truncated=true if exceeded.",
          },
          tab_id: { type: "number", description: "Optional tab id; defaults to active tab." },
        },
      },
    },
    {
      // SPEC ab agent_browser_open. Alias for page_navigate kept for
      // parity-matrix coverage; behaviour is identical.
      name: "open",
      description: "🧭 Navigate the active (or given) tab to a URL. SPEC alias for page_navigate; matches ab agent_browser_open.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Target URL (http(s)/file/data)." },
          wait_for: { type: "string", description: "Optional CSS selector to await." },
          timeout: { type: "number", description: "Wait timeout in ms (default 10000)." },
          tab_id: { type: "number" },
        },
        required: ["url"],
      },
    },
    {
      // SPEC ab agent_browser_click — uses @refN from a prior snapshot.
      name: "click",
      description: "🖱️ Click an element by @refN from the last snapshot. Call snapshot first; pair the @refN you found with this tool.",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "@refN identifier from snapshot.ref_map." },
          tab_id: { type: "number" },
        },
        required: ["ref"],
      },
    },
    {
      name: "fill",
      description: "✏️ Set the value of an input/textarea/contenteditable by @refN. Fires input + change events. Call snapshot first.",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string" },
          value: { type: "string" },
          tab_id: { type: "number" },
        },
        required: ["ref", "value"],
      },
    },
    {
      name: "type",
      description: "⌨️ Type text into a focused element by @refN, character-by-character (key events fire). Use fill for the cheaper bulk path; use type when the page listens for keydown/keypress.",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string" },
          text: { type: "string" },
          tab_id: { type: "number" },
        },
        required: ["ref", "text"],
      },
    },
    {
      name: "storage_set",
      description: "💾✏️ DANGEROUS: write one localStorage/sessionStorage key. {key, value, kind: \"local\"|\"session\"}.",
      inputSchema: { type: "object", properties: { key: { type: "string" }, value: {}, kind: { type: "string", enum: ["local", "session"], default: "local" }, tab_id: { type: "number" } }, required: ["key"] },
    },
    {
      name: "storage_clear",
      description: "💾🗑️ DANGEROUS: clear all localStorage or sessionStorage entries.",
      inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["local", "session"], default: "local" }, tab_id: { type: "number" } } },
    },
    {
      name: "cookies_set",
      description: "🍪✏️ DANGEROUS: set a cookie via chrome.cookies.set. Pass {name, value, url|domain, path?, expirationDate?, secure?, httpOnly?, sameSite?}.",
      inputSchema: { type: "object", properties: { name: { type: "string" }, value: { type: "string" }, url: { type: "string" }, domain: { type: "string" }, path: { type: "string" }, expirationDate: { type: "number" }, secure: { type: "boolean" }, httpOnly: { type: "boolean" }, sameSite: { type: "string" } }, required: ["name", "value"] },
    },
    {
      name: "cookies_set_curl",
      description: "🍪✏️ DANGEROUS: parse a curl-style \"Set-Cookie:\" header and set the resulting cookies for the active tab's URL.",
      inputSchema: { type: "object", properties: { header: { type: "string" }, url: { type: "string" } }, required: ["header"] },
    },
    {
      name: "set_headers",
      description: "📋 DANGEROUS: override extra HTTP headers for the tab via CDP Network.setExtraHTTPHeaders.",
      inputSchema: { type: "object", properties: { headers: { type: "object" }, tab_id: { type: "number" } }, required: ["headers"] },
    },
    {
      name: "set_credentials",
      description: "🔐 DANGEROUS: set HTTP Basic auth via CDP Network.setExtraHTTPHeaders Authorization.",
      inputSchema: { type: "object", properties: { username: { type: "string" }, password: { type: "string" }, tab_id: { type: "number" } }, required: ["username", "password"] },
    },
    {
      name: "network_request",
      description: "🌐 DANGEROUS: fetch() from background context (no CORS). Pass {url, method?, headers?, body?, credentials?}.",
      inputSchema: { type: "object", properties: { url: { type: "string" }, method: { type: "string" }, headers: { type: "object" }, body: { type: "string" }, credentials: { type: "string" } }, required: ["url"] },
    },
    {
      name: "network_route",
      description: "🌐 DANGEROUS: install a CDP Fetch.enable + Fetch.fulfillRequest interceptor. {pattern, response: {body, status?, headers?}}.",
      inputSchema: { type: "object", properties: { pattern: { type: "string" }, response: { type: "object" }, tab_id: { type: "number" } }, required: ["pattern", "response"] },
    },
    {
      name: "network_unroute",
      description: "🌐 DANGEROUS: clear CDP Fetch.disable for the tab.",
      inputSchema: { type: "object", properties: { tab_id: { type: "number" } } },
    },
    {
      name: "auth_save",
      description: "🔐 DANGEROUS: persist {name, kind, payload} to chrome.storage.local under key auth/<name>.",
      inputSchema: { type: "object", properties: { name: { type: "string" }, kind: { type: "string" }, payload: { type: "object" } }, required: ["name", "kind", "payload"] },
    },
    {
      name: "auth_login",
      description: "🔐 DANGEROUS: load a saved auth bundle and apply it (cookies_set + headers).",
      inputSchema: { type: "object", properties: { name: { type: "string" }, tab_id: { type: "number" } }, required: ["name"] },
    },
    {
      name: "auth_show",
      description: "🔐 DANGEROUS: read one saved auth bundle.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
    {
      name: "auth_list",
      description: "🔐 List saved auth bundle names.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "auth_delete",
      description: "🔐 DANGEROUS: delete one saved auth bundle.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
    {
      name: "state_save",
      description: "💼 DANGEROUS: snapshot cookies+localStorage+sessionStorage for the active URL into chrome.storage.local under state/<name>.",
      inputSchema: { type: "object", properties: { name: { type: "string" }, tab_id: { type: "number" } }, required: ["name"] },
    },
    {
      name: "state_load",
      description: "💼 DANGEROUS: restore one saved state snapshot for the active URL.",
      inputSchema: { type: "object", properties: { name: { type: "string" }, tab_id: { type: "number" } }, required: ["name"] },
    },
    {
      name: "state_show",
      description: "💼 Read one saved state snapshot.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
    {
      name: "state_list",
      description: "💼 List saved state names.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "state_clear",
      description: "💼 DANGEROUS: delete one saved state snapshot.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
    {
      name: "state_clean",
      description: "💼 DANGEROUS: delete ALL saved state snapshots.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "state_rename",
      description: "💼 Rename a saved state snapshot.",
      inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] },
    },
    {
      name: "upload",
      description: "📤 DANGEROUS: attach files[] (each {name, mime, base64}) to an <input type=file> by @refN.",
      inputSchema: { type: "object", properties: { ref: { type: "string" }, files: { type: "array", items: { type: "object" } }, tab_id: { type: "number" } }, required: ["ref", "files"] },
    },
    {
      name: "eval",
      description: "⚠️ DANGEROUS: execute arbitrary JavaScript in the page's MAIN world via chrome.scripting.executeScript. Returns the function's return value (JSON-serializable). Use this in preference to the legacy `evaluate_js` (which is now an alias).",
      inputSchema: { type: "object", properties: { script: { type: "string" }, tab_id: { type: "number" } }, required: ["script"] },
    },
    {
      name: "storage_get",
      description: "💾 Read one localStorage/sessionStorage key. Pass {key, kind: \"local\"|\"session\"}.",
      inputSchema: { type: "object", properties: { key: { type: "string" }, kind: { type: "string", enum: ["local", "session"], default: "local" }, tab_id: { type: "number" } }, required: ["key"] },
    },
    {
      name: "dialog_status",
      description: "❓ Best-effort armed-dialog status (always ok:false from content script — see field 'note').",
      inputSchema: { type: "object", properties: { tab_id: { type: "number" } } },
    },
    // wait_for_download is registered below (line ~1947, pre-existing
    // power tool with richer {timeout_ms, since_ms} schema). Removed
    // the duplicate SPEC registration here per round-4a review R2.
    {
      name: "frame_switch",
      description: "🖼️ Switch the WS pipe's content-script target to a frame by URL substring or ID. No-op when not yet supported by the WS bridge.",
      inputSchema: { type: "object", properties: { match: { type: "string" }, frame_id: { type: "number" }, tab_id: { type: "number" } } },
    },
    {
      name: "window_new",
      description: "🪟 Create a new browser window (chrome.windows.create). Pass {url} optional.",
      inputSchema: { type: "object", properties: { url: { type: "string" }, focused: { type: "boolean", default: true } } },
    },
    {
      name: "set_offline",
      description: "📵 Toggle offline mode via CDP Network.emulateNetworkConditions. Pass {offline:bool}.",
      inputSchema: { type: "object", properties: { offline: { type: "boolean" }, tab_id: { type: "number" } }, required: ["offline"] },
    },
    {
      name: "profiler_start",
      description: "⏱️ Start a JS profile via CDP Profiler.enable + Profiler.start.",
      inputSchema: { type: "object", properties: { tab_id: { type: "number" } } },
    },
    {
      name: "profiler_stop",
      description: "⏱️ Stop the JS profile and return the CPU profile JSON via CDP Profiler.stop.",
      inputSchema: { type: "object", properties: { tab_id: { type: "number" } } },
    },
    {
      name: "network_har_start",
      description: "🌐⏺️ Begin per-tab HAR-style capture (uses webRequest under the hood).",
      inputSchema: { type: "object", properties: { tab_id: { type: "number" } } },
    },
    {
      name: "network_har_stop",
      description: "🌐⏹️ Stop and return the captured request log.",
      inputSchema: { type: "object", properties: { tab_id: { type: "number" } } },
    },
    {
      name: "trace_start",
      description: "🔬 Start a CDP Tracing.start session.",
      inputSchema: { type: "object", properties: { categories: { type: "array", items: { type: "string" } }, tab_id: { type: "number" } } },
    },
    {
      name: "trace_stop",
      description: "🔬 Stop CDP tracing and return the collected events.",
      inputSchema: { type: "object", properties: { tab_id: { type: "number" } } },
    },
    {
      name: "pdf",
      description: "📄 Print the active tab to a base64 PDF via CDP Page.printToPDF.",
      inputSchema: { type: "object", properties: { tab_id: { type: "number" } } },
    },
    {
      name: "network_requests",
      description: "🌐 Return the buffered list of network requests for the active tab (last 200). Pass {flush:false} to peek without clearing.",
      inputSchema: { type: "object", properties: { flush: { type: "boolean", default: true }, tab_id: { type: "number" } } },
    },
    {
      name: "react_tree",
      description: "⚛️ Walk the React fiber tree from each root; emit compact node list (depth+name+key). Capped at max_nodes (default 200).",
      inputSchema: { type: "object", properties: { max_nodes: { type: "number", default: 200 }, tab_id: { type: "number" } } },
    },
    {
      name: "react_inspect",
      description: "⚛️ Resolve @refN to its nearest React fiber; return component name, ancestor chain, prop keys, has_state.",
      inputSchema: { type: "object", properties: { ref: { type: "string" }, tab_id: { type: "number" } }, required: ["ref"] },
    },
    {
      name: "react_renders_start",
      description: "⚛️ Hook onCommitFiberRoot to count renders per component. Pair with react_renders_stop.",
      inputSchema: { type: "object", properties: { tab_id: { type: "number" } } },
    },
    {
      name: "react_renders_stop",
      description: "⚛️ Stop the renders hook and return per-component render counts.",
      inputSchema: { type: "object", properties: { tab_id: { type: "number" } } },
    },
    {
      name: "react_suspense",
      description: "⚛️ Walk fibers and count Suspense boundaries by state {pending, resolved}.",
      inputSchema: { type: "object", properties: { tab_id: { type: "number" } } },
    },
    {
      name: "deny",
      description: "❎ Alias for dialog_dismiss — pre-arms the next confirm() to return false.",
      inputSchema: { type: "object", properties: { tab_id: { type: "number" } } },
    },
    {
      name: "diff_url",
      description: "🌐Δ Return the URL change since the last call (or null).",
      inputSchema: { type: "object", properties: { tab_id: { type: "number" } } },
    },
    {
      name: "errors",
      description: "🐞 Return buffered window.onerror / unhandledrejection events from the page (last 200).",
      inputSchema: { type: "object", properties: { flush: { type: "boolean", default: true }, tab_id: { type: "number" } } },
    },
    {
      name: "download",
      description: "📥 chrome.downloads.download wrapper. Pass {url, filename?}.",
      inputSchema: { type: "object", properties: { url: { type: "string" }, filename: { type: "string" } }, required: ["url"] },
    },
    {
      name: "highlight",
      description: "🎯 Outline @refN with a color for {duration_ms} (default 1500). Pair with snapshot.",
      inputSchema: { type: "object", properties: { ref: { type: "string" }, color: { type: "string" }, duration_ms: { type: "number" }, tab_id: { type: "number" } }, required: ["ref"] },
    },
    {
      name: "frame_main",
      description: "🖼️ Switch context to the top frame (no-op since the WS pipe is already top-frame-bound).",
      inputSchema: { type: "object", properties: { tab_id: { type: "number" } } },
    },
    {
      name: "add_init_script",
      description: "🌱 DANGEROUS: install a script via CDP Page.addScriptToEvaluateOnNewDocument; runs on every navigation. Returns the identifier; pair with remove_init_script.",
      inputSchema: { type: "object", properties: { script: { type: "string" }, tab_id: { type: "number" } }, required: ["script"] },
    },
    {
      name: "remove_init_script",
      description: "🧹 Remove an init script previously installed via add_init_script. Pass the identifier returned at install time.",
      inputSchema: { type: "object", properties: { id: { type: "string" }, tab_id: { type: "number" } }, required: ["id"] },
    },
    {
      name: "diff_screenshot",
      description: "📸Δ Capture viewport, byte-diff against the last screenshot. Returns equal:bool + sizes.",
      inputSchema: { type: "object", properties: { format: { type: "string", default: "jpeg" }, quality: { type: "number", default: 70 }, tab_id: { type: "number" } } },
    },
    {
      name: "console",
      description: "📜 Return buffered console.log/warn/error/info/debug messages from the page (last 500). Pass {flush:false} to peek without clearing.",
      inputSchema: { type: "object", properties: { flush: { type: "boolean", default: true }, tab_id: { type: "number" } } },
    },
    {
      name: "vitals",
      description: "📊 Snapshot web-vitals (navigation timing, paint, LCP) from PerformanceObserver entries already in memory.",
      inputSchema: { type: "object", properties: { tab_id: { type: "number" } } },
    },
    {
      name: "inspect",
      description: "🔬 Inspect one element by CSS selector — returns tag, text, rect, attrs.",
      inputSchema: { type: "object", properties: { selector: { type: "string" }, tab_id: { type: "number" } }, required: ["selector"] },
    },
    {
      name: "wait_for_function",
      description: "⚠️ DANGEROUS: eval a JS expression in the page's content-script context until it returns truthy (or timeout). Use only when wait_for_selector / wait_for_text don't fit.",
      inputSchema: { type: "object", properties: { script: { type: "string" }, timeout: { type: "number", default: 10000 }, tab_id: { type: "number" } }, required: ["script"] },
    },
    {
      name: "confirm",
      description: "✅ Alias for dialog_accept; pre-arms the next confirm() to return true.",
      inputSchema: { type: "object", properties: { tab_id: { type: "number" } } },
    },
    {
      name: "cookies_get",
      description: "🍪 Read cookies for the current tab's URL via chrome.cookies. Pass {url} to override.",
      inputSchema: { type: "object", properties: { url: { type: "string" }, tab_id: { type: "number" } } },
    },
    {
      name: "cookies_clear",
      description: "🍪🗑️ Clear all cookies for the current tab's URL (or pass {url}).",
      inputSchema: { type: "object", properties: { url: { type: "string" }, tab_id: { type: "number" } } },
    },
    {
      name: "get_cdp_url",
      description: "🔌 Return a chrome://inspect-style debuggable URL for the active tab (Chrome-only).",
      inputSchema: { type: "object", properties: { tab_id: { type: "number" } } },
    },
    {
      name: "diff_snapshot",
      description: "📐Δ Compute the difference vs the last snapshot. Returns {added, removed} lines + new ref_count. Cheap; prefer this when monitoring an SPA route change.",
      inputSchema: { type: "object", properties: { interactive_only: { type: "boolean" }, max_nodes: { type: "number" }, tab_id: { type: "number" } } },
    },
    {
      name: "get_box",
      description: "📦 getBoundingClientRect of @refN.",
      inputSchema: { type: "object", properties: { ref: { type: "string" }, tab_id: { type: "number" } }, required: ["ref"] },
    },
    {
      name: "get_styles",
      description: "🎨 getComputedStyle of @refN. Pass properties[] to limit; default returns common visual props.",
      inputSchema: { type: "object", properties: { ref: { type: "string" }, properties: { type: "array", items: { type: "string" } }, tab_id: { type: "number" } }, required: ["ref"] },
    },
    {
      name: "get_count",
      description: "🔢 querySelectorAll().length for a CSS selector.",
      inputSchema: { type: "object", properties: { selector: { type: "string" }, tab_id: { type: "number" } }, required: ["selector"] },
    },
    {
      name: "tap",
      description: "👇 Touch tap at viewport (x, y).",
      inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, tab_id: { type: "number" } }, required: ["x", "y"] },
    },
    {
      name: "device",
      description: "📱 Apply a named device preset (iphone15 | pixel7 | ipad | desktop1080). Wraps set_viewport.",
      inputSchema: { type: "object", properties: { name: { type: "string" }, tab_id: { type: "number" } }, required: ["name"] },
    },
    {
      name: "find",
      description: "🔎 CSS-selector single-element find; returns a fresh @refN.",
      inputSchema: { type: "object", properties: { selector: { type: "string" }, tab_id: { type: "number" } }, required: ["selector"] },
    },
    {
      name: "mouse_down",
      description: "🖱️ Press the mouse button at viewport (x, y).",
      inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, tab_id: { type: "number" } }, required: ["x", "y"] },
    },
    {
      name: "mouse_up",
      description: "🖱️ Release the mouse button at viewport (x, y).",
      inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, tab_id: { type: "number" } }, required: ["x", "y"] },
    },
    {
      name: "mouse_move",
      description: "🖱️ Move the mouse to viewport (x, y).",
      inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, tab_id: { type: "number" } }, required: ["x", "y"] },
    },
    {
      name: "mouse_wheel",
      description: "🖱️ Dispatch a wheel event with deltas (and scrollBy as fallback).",
      inputSchema: { type: "object", properties: { dx: { type: "number" }, dy: { type: "number" }, tab_id: { type: "number" } } },
    },
    {
      name: "keydown",
      description: "⌨️ Dispatch a keydown on the focused element.",
      inputSchema: { type: "object", properties: { key: { type: "string" }, tab_id: { type: "number" } }, required: ["key"] },
    },
    {
      name: "keyup",
      description: "⌨️ Dispatch a keyup on the focused element.",
      inputSchema: { type: "object", properties: { key: { type: "string" }, tab_id: { type: "number" } }, required: ["key"] },
    },
    {
      name: "keyboard_type",
      description: "⌨️ Type text into the focused element (per-character key events).",
      inputSchema: { type: "object", properties: { text: { type: "string" }, tab_id: { type: "number" } }, required: ["text"] },
    },
    {
      name: "keyboard_insert_text",
      description: "⌨️ Insert text into the focused element (no per-char key events).",
      inputSchema: { type: "object", properties: { text: { type: "string" }, tab_id: { type: "number" } }, required: ["text"] },
    },
    {
      name: "swipe",
      description: "📱 Touch swipe from (x1,y1) → (x2,y2).",
      inputSchema: { type: "object", properties: { x1: { type: "number" }, y1: { type: "number" }, x2: { type: "number" }, y2: { type: "number" }, tab_id: { type: "number" } }, required: ["x1", "y1", "x2", "y2"] },
    },
    {
      name: "pushstate",
      description: "🛣️ history.pushState passthrough (SPA tests).",
      inputSchema: { type: "object", properties: { url: { type: "string" }, state: { type: "object" }, tab_id: { type: "number" } } },
    },
    {
      name: "set_viewport",
      description: "📐 Resize viewport via CDP Emulation.setDeviceMetricsOverride. Pass {width, height, mobile?, deviceScaleFactor?}.",
      inputSchema: { type: "object", properties: { width: { type: "number" }, height: { type: "number" }, mobile: { type: "boolean" }, deviceScaleFactor: { type: "number" }, tab_id: { type: "number" } }, required: ["width", "height"] },
    },
    {
      name: "set_geo",
      description: "🌐 Override geolocation via CDP Emulation.setGeolocationOverride.",
      inputSchema: { type: "object", properties: { latitude: { type: "number" }, longitude: { type: "number" }, accuracy: { type: "number" }, tab_id: { type: "number" } }, required: ["latitude", "longitude"] },
    },
    {
      name: "set_media",
      description: "🎨 Override prefers-color-scheme / media features via CDP Emulation.setEmulatedMedia.",
      inputSchema: { type: "object", properties: { type: { type: "string" }, features: { type: "array", items: { type: "object" } }, tab_id: { type: "number" } } },
    },
    {
      name: "find_by_role",
      description: "🔎 Find an element by ARIA role; returns a fresh @refN appended to the live snapshot.",
      inputSchema: { type: "object", properties: { role: { type: "string" }, query: { type: "string" }, tab_id: { type: "number" } } },
    },
    {
      name: "find_by_text",
      description: "🔎 Find an element by visible text (exact preferred, falls back to substring).",
      inputSchema: { type: "object", properties: { query: { type: "string" }, tab_id: { type: "number" } }, required: ["query"] },
    },
    {
      name: "find_by_label",
      description: "🔎 Find an input by its <label> text.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, tab_id: { type: "number" } }, required: ["query"] },
    },
    {
      name: "find_by_placeholder",
      description: "🔎 Find an input by its placeholder.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, tab_id: { type: "number" } }, required: ["query"] },
    },
    {
      name: "find_by_testid",
      description: "🔎 Find an element by data-testid.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, tab_id: { type: "number" } }, required: ["query"] },
    },
    {
      name: "dialog_accept",
      description: "✅ Accept the next browser dialog (alert/confirm/prompt). One-shot; install before triggering.",
      inputSchema: { type: "object", properties: { text: { type: "string" }, tab_id: { type: "number" } } },
    },
    {
      name: "dialog_dismiss",
      description: "❎ Dismiss the next browser dialog (alert/confirm/prompt). One-shot.",
      inputSchema: { type: "object", properties: { tab_id: { type: "number" } } },
    },
    {
      name: "dblclick",
      description: "🖱️🖱️ Double-click an element by @refN. Pair with snapshot.",
      inputSchema: { type: "object", properties: { ref: { type: "string" }, tab_id: { type: "number" } }, required: ["ref"] },
    },
    {
      name: "scroll_into_view",
      description: "🪟 Scroll an element by @refN into the viewport center.",
      inputSchema: { type: "object", properties: { ref: { type: "string" }, tab_id: { type: "number" } }, required: ["ref"] },
    },
    {
      name: "select",
      description: "🔽 Select option(s) on a <select> by @refN. value or values[] (multi-select).",
      inputSchema: { type: "object", properties: { ref: { type: "string" }, value: { type: "string" }, values: { type: "array", items: { type: "string" } }, tab_id: { type: "number" } }, required: ["ref"] },
    },
    {
      name: "drag",
      description: "🤚 Drag from @ref to @ref (HTML5 drag events).",
      inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, tab_id: { type: "number" } }, required: ["from", "to"] },
    },
    {
      name: "get_text",
      description: "📝 Read innerText of @refN. Cheap; prefer this over get_html for content extraction.",
      inputSchema: { type: "object", properties: { ref: { type: "string" }, tab_id: { type: "number" } }, required: ["ref"] },
    },
    {
      name: "get_html",
      description: "📄 Read outerHTML of @refN. Typically large; only when get_text loses needed detail. Capped at 8KB by default.",
      inputSchema: { type: "object", properties: { ref: { type: "string" }, max_bytes: { type: "number", default: 8000 }, tab_id: { type: "number" } }, required: ["ref"] },
    },
    {
      name: "get_value",
      description: "🧮 Read input/textarea/contenteditable value of @refN.",
      inputSchema: { type: "object", properties: { ref: { type: "string" }, tab_id: { type: "number" } }, required: ["ref"] },
    },
    {
      name: "get_attr",
      description: "🏷️ Read a DOM attribute of @refN.",
      inputSchema: { type: "object", properties: { ref: { type: "string" }, name: { type: "string" }, tab_id: { type: "number" } }, required: ["ref", "name"] },
    },
    {
      name: "is_visible",
      description: "👁️ Returns whether @refN is visible (rect>0 + visibility/display/opacity).",
      inputSchema: { type: "object", properties: { ref: { type: "string" }, tab_id: { type: "number" } }, required: ["ref"] },
    },
    {
      name: "is_enabled",
      description: "✅ Returns whether @refN is enabled (not disabled).",
      inputSchema: { type: "object", properties: { ref: { type: "string" }, tab_id: { type: "number" } }, required: ["ref"] },
    },
    {
      name: "is_checked",
      description: "☑️ Returns whether @refN is a checked checkbox/radio.",
      inputSchema: { type: "object", properties: { ref: { type: "string" }, tab_id: { type: "number" } }, required: ["ref"] },
    },
    {
      name: "hover",
      description: "👆 Hover over an element by @refN; fires mouseover/mouseenter/mousemove. Pair with snapshot.",
      inputSchema: { type: "object", properties: { ref: { type: "string" }, tab_id: { type: "number" } }, required: ["ref"] },
    },
    {
      name: "focus",
      description: "🎯 Focus an element by @refN. Pair with snapshot.",
      inputSchema: { type: "object", properties: { ref: { type: "string" }, tab_id: { type: "number" } }, required: ["ref"] },
    },
    {
      name: "check",
      description: "☑️ Check a checkbox by @refN (no-op if already checked). Pair with snapshot.",
      inputSchema: { type: "object", properties: { ref: { type: "string" }, tab_id: { type: "number" } }, required: ["ref"] },
    },
    {
      name: "uncheck",
      description: "☐ Uncheck a checkbox by @refN (no-op if already unchecked). Pair with snapshot.",
      inputSchema: { type: "object", properties: { ref: { type: "string" }, tab_id: { type: "number" } }, required: ["ref"] },
    },
    {
      name: "wait_ms",
      description: "⏱️ Sleep for a fixed number of milliseconds.",
      inputSchema: { type: "object", properties: { ms: { type: "number" }, tab_id: { type: "number" } }, required: ["ms"] },
    },
    // wait_for_selector is registered below (line ~1809, pre-existing
    // power tool). The pre-existing handler accepts `timeout_ms` and
    // `visible` flags that the new schema would have lost — instead
    // we extended the power tool to also accept `timeout` (ms).
    // Removed the duplicate SPEC registration here per round-4a review R1.
    {
      name: "wait_for_text",
      description: "📝 Wait until the body innerText contains the given substring (or timeout).",
      inputSchema: { type: "object", properties: { text: { type: "string" }, timeout: { type: "number", default: 10000 }, tab_id: { type: "number" } }, required: ["text"] },
    },
    {
      name: "wait_for_url",
      description: "🌐 Wait until the active tab's URL matches the given substring/regex (or timeout).",
      inputSchema: { type: "object", properties: { url: { type: "string" }, regex: { type: "boolean", default: false }, timeout: { type: "number", default: 10000 }, tab_id: { type: "number" } }, required: ["url"] },
    },
    {
      name: "wait_for_load",
      description: "📡 Wait until the active tab's status === \"complete\" (or timeout).",
      inputSchema: { type: "object", properties: { timeout: { type: "number", default: 10000 }, tab_id: { type: "number" } } },
    },
    {
      name: "tab_new",
      description: "🆕 Create a new tab. Alias for tab_create matching ab agent_browser_tab_new.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          active: { type: "boolean", default: true },
        },
      },
    },
    {
      name: "close",
      description: "❌ Close the active tab (or the given tab_id). ab agent_browser_close.",
      inputSchema: { type: "object", properties: { tab_id: { type: "number" } } },
    },
    {
      name: "press",
      description: "⌨️ Press a key (or chord like Control+a) on the active element. ab agent_browser_press.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "e.g. Enter, Tab, Escape, Control+a" },
          tab_id: { type: "number" },
        },
        required: ["key"],
      },
    },
    {
      name: "scroll",
      description: "🖱️ Scroll the page. dir ∈ up|down|left|right (default down). pixels = scroll distance (default 800). ab agent_browser_scroll.",
      inputSchema: {
        type: "object",
        properties: {
          dir: { type: "string", enum: ["up", "down", "left", "right"], default: "down" },
          pixels: { type: "number", default: 800 },
          tab_id: { type: "number" },
        },
      },
    },
    // screenshot is registered below (line ~1836, pre-existing).
    // Removed the duplicate SPEC registration here per round-4a review R3.
    {
      name: "get_url",
      description: "🔗 Return the current URL of the active (or given) tab. ab agent_browser_get_url.",
      inputSchema: { type: "object", properties: { tab_id: { type: "number" } } },
    },
    {
      name: "get_title",
      description: "📰 Return the document title of the active (or given) tab. ab agent_browser_get_title.",
      inputSchema: { type: "object", properties: { tab_id: { type: "number" } } },
    },
    {
      name: "back",
      description: "↩️ Navigate the tab one step back in history. ab agent_browser_back.",
      inputSchema: { type: "object", properties: { tab_id: { type: "number" } } },
    },
    {
      name: "forward",
      description: "↪️ Navigate the tab one step forward in history. ab agent_browser_forward.",
      inputSchema: { type: "object", properties: { tab_id: { type: "number" } } },
    },
    {
      name: "reload",
      description: "🔄 Reload the tab. ab agent_browser_reload. bypass_cache:true does a hard reload.",
      inputSchema: {
        type: "object",
        properties: {
          tab_id: { type: "number" },
          bypass_cache: { type: "boolean", default: false },
        },
      },
    },
    {
      name: "page_analyze",
      description: "🔍 BACKGROUND TAB READY: Analyze any tab without switching to it! Two-phase intelligent page analysis with token efficiency optimization. Use tab_id parameter to analyze background tabs while staying on current page.",
      inputSchema: {
        type: "object",
        examples: [
          { intent_hint: "analyze", phase: "discover" },  // Current tab quick analysis
          { intent_hint: "login", tab_id: 12345 },  // Background tab login form analysis
          { intent_hint: "post_create", tab_id: 67890, phase: "detailed" }  // Background tab detailed analysis
        ],
        properties: {
          intent_hint: {
            type: "string",
            description: "User intent: login, signup, search, post_create, comment, menu, submit, etc."
          },
          phase: {
            type: "string",
            enum: ["discover", "detailed"],
            default: "discover",
            description: "Analysis phase: 'discover' for quick scan (<100 tokens), 'detailed' for full analysis"
          },
          focus_areas: {
            type: "array",
            items: { type: "string" },
            description: "Areas to analyze in detail: buttons, forms, navigation, search_elements"
          },
          max_results: {
            type: "number",
            default: 5,
            maximum: 15,
            description: "Maximum number of elements to return"
          },
          element_ids: {
            type: "array",
            items: { type: "string" },
            description: "Expand specific quick match IDs from discover phase (e.g. ['q1', 'q2'])"
          },
          tab_id: {
            type: "number",
            description: "🎯 TARGET ANY TAB: Specify tab ID to analyze background tabs without switching! Get tab IDs from tab_list. If omitted, analyzes current active tab."
          }
        },
        required: ["intent_hint"]
      }
    },
    {
      name: "page_extract_content",
      description: "📄 BACKGROUND TAB READY: Extract content from any tab without switching! Perfect for analyzing multiple research tabs, articles, or pages simultaneously. Use tab_id to target specific background tabs.",
      inputSchema: {
        type: "object",
        examples: [
          { content_type: "article" },  // Extract from current tab
          { content_type: "article", tab_id: 12345 },  // Extract from background research tab
          { content_type: "posts", tab_id: 67890, max_items: 10 }  // Extract social media posts from background tab
        ],
        properties: {
          content_type: {
            type: "string",
            enum: ["article", "search_results", "posts"],
            description: "Type of content to extract"
          },
          max_items: {
            type: "number",
            description: "Maximum number of items to extract (for lists/collections)",
            default: 20
          },
          summarize: {
            type: "boolean",
            default: true,
            description: "Return summary instead of full content to save tokens"
          },
          tab_id: {
            type: "number",
            description: "🎯 TARGET ANY TAB: Extract content from specific background tab without switching! Use tab_list to get tab IDs. Perfect for processing multiple research tabs."
          }
        },
        required: ["content_type"]
      }
    },
    
    // Element Interaction Tools
    {
      name: "element_click",
      description: "🖱️ BACKGROUND TAB READY: Click elements in any tab without switching! Perform actions on background tabs while staying on current page. Use tab_id to target specific tabs.",
      inputSchema: {
        type: "object",
        properties: {
          element_id: {
            type: "string",
            description: "Unique element identifier from page_analyze"
          },
          click_type: {
            type: "string",
            enum: ["left", "right", "double"],
            default: "left"
          },
          wait_after: {
            type: "number",
            description: "Milliseconds to wait after click",
            default: 500
          },
          tab_id: {
            type: "number",
            description: "🎯 TARGET ANY TAB: Click elements in background tabs without switching! Get tab IDs from tab_list to interact with multiple tabs efficiently."
          }
        },
        required: ["element_id"]
      }
    },
    {
      name: "element_fill",
      description: "✏️ BACKGROUND TAB READY: Fill forms in any tab without switching! Enhanced focus and event simulation for modern web apps. Use tab_id to fill forms in background tabs.",
      inputSchema: {
        type: "object",
        properties: {
          element_id: {
            type: "string",
            description: "Unique element identifier from page_analyze"
          },
          value: {
            type: "string",
            description: "Text value to input"
          },
          clear_first: {
            type: "boolean",
            description: "Clear existing content before filling",
            default: true
          },
          force_focus: {
            type: "boolean",
            description: "Use enhanced focus sequence with click simulation for modern apps",
            default: true
          },
          tab_id: {
            type: "number",
            description: "🎯 TARGET ANY TAB: Fill forms in background tabs without switching! Perfect for batch form filling across multiple tabs. Get tab IDs from tab_list."
          }
        },
        required: ["element_id", "value"]
      }
    },
    
    // Navigation Tools
    {
      name: "page_navigate",
      description: "Navigate CURRENT tab to a new URL. Use tab_create instead if you want to open a NEW tab with a URL.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "URL to navigate to"
          },
          wait_for: {
            type: "string",
            description: "CSS selector to wait for after navigation (ensures page is ready)"
          },
          timeout: {
            type: "number",
            description: "Maximum wait time in milliseconds",
            default: 10000
          }
        },
        required: ["url"]
      }
    },
    {
      name: "page_wait_for",
      description: "Wait for specific element or condition on current page",
      inputSchema: {
        type: "object",
        properties: {
          condition_type: {
            type: "string",
            enum: ["element_visible", "text_present"],
            description: "Type of condition to wait for"
          },
          selector: {
            type: "string",
            description: "CSS selector for element-based conditions"
          },
          text: {
            type: "string",
            description: "Text to wait for (when condition_type is 'text_present')"
          },
          timeout: {
            type: "number",
            description: "Maximum wait time in milliseconds",
            default: 5000
          }
        },
        required: ["condition_type"]
      }
    },
    
    // Tab Management Tools
    {
      name: "tab_create",
      description: "Creates tabs. CRITICAL: For multiple identical tabs, ALWAYS use 'count' parameter! Examples: {url: 'https://x.com', count: 5} creates 5 Twitter tabs. {url: 'https://github.com', count: 10} creates 10 GitHub tabs. Single tab: {url: 'https://example.com'}. Multiple different URLs: {urls: ['url1', 'url2']}.",
      inputSchema: {
        type: "object",
        examples: [
          { url: "https://x.com", count: 5 },  // CORRECT: Creates 5 identical Twitter tabs in one batch
          { url: "https://github.com", count: 10 },  // CORRECT: Creates 10 GitHub tabs 
          { urls: ["https://x.com/post1", "https://x.com/post2", "https://google.com"] },  // CORRECT: Different URLs in batch
          { url: "https://example.com" }  // Single tab only
        ],
        properties: {
          url: {
            type: "string",
            description: "Single URL to open. Can be used with 'count' to create multiple identical tabs"
          },
          urls: {
            type: "array",
            items: { type: "string" },
            description: "PREFERRED FOR MULTIPLE URLS: Array of URLs to open ALL AT ONCE in a single batch operation. Pass ALL URLs here instead of making multiple calls! Example: ['https://x.com/post1', 'https://x.com/post2', 'https://google.com']",
            maxItems: 100
          },
          count: {
            type: "number",
            default: 1,
            minimum: 1,
            maximum: 50,
            description: "REQUIRED FOR MULTIPLE IDENTICAL TABS: Set this to N to create N copies of the same URL. For '5 Twitter tabs' use count=5 with url='https://x.com'. DO NOT make 5 separate calls!"
          },
          active: {
            type: "boolean",
            default: true,
            description: "Whether to activate the last created tab (single tab only)"
          },
          wait_for: {
            type: "string",
            description: "CSS selector to wait for after tab creation (single tab only)"
          },
          timeout: {
            type: "number",
            default: 10000,
            description: "Maximum wait time per tab in milliseconds"
          },
          batch_settings: {
            type: "object",
            description: "Performance control settings for batch operations",
            properties: {
              chunk_size: {
                type: "number",
                default: 5,
                minimum: 1,
                maximum: 10,
                description: "Number of tabs to create per batch"
              },
              delay_between_chunks: {
                type: "number",
                default: 1000,
                minimum: 100,
                maximum: 5000,
                description: "Delay between batches in milliseconds"
              },
              delay_between_tabs: {
                type: "number",
                default: 200,
                minimum: 50,
                maximum: 1000,
                description: "Delay between individual tabs in milliseconds"
              }
            }
          }
        }
      }
    },
    {
      name: "tab_close",
      description: "Close specific tab(s) by ID or close current tab",
      inputSchema: {
        type: "object",
        properties: {
          tab_id: {
            type: "number",
            description: "Specific tab ID to close (optional, closes current tab if not provided)"
          },
          tab_ids: {
            type: "array",
            items: { type: "number" },
            description: "Array of tab IDs to close multiple tabs"
          }
        }
      }
    },
    {
      name: "tab_list",
      description: "📋 TAB DISCOVERY: Get list of all open tabs with IDs for background tab targeting! Shows content script readiness status and tab details. Essential for multi-tab workflows - use tab IDs with other tools to work on background tabs.",
      inputSchema: {
        type: "object",
        examples: [
          { check_content_script: false },  // RECOMMENDED: Default false to avoid timeouts
          { current_window_only: false, check_content_script: false }  // Get all tabs across windows
        ],
        properties: {
          current_window_only: {
            type: "boolean",
            default: true,
            description: "Only return tabs from the current window"
          },
          include_details: {
            type: "boolean",
            default: true,
            description: "Include additional tab details (title, favicon, etc.)"
          },
          check_content_script: {
            type: "boolean",
            default: false,
            description: "🔍 ESSENTIAL FOR BACKGROUND TABS: Check which tabs are ready for background operations! Set to true when planning multi-tab workflows to see which tabs can be targeted."
          }
        }
      }
    },
    {
      name: "tab_switch",
      description: "Switch to a specific tab by ID",
      inputSchema: {
        type: "object",
        properties: {
          tab_id: {
            type: "number",
            description: "Tab ID to switch to"
          }
        },
        required: ["tab_id"]
      }
    },
    
    // Element State Tools
    {
      name: "element_get_state",
      description: "Get detailed state information for a specific element (disabled, clickable, etc.)",
      inputSchema: {
        type: "object",
        properties: {
          element_id: {
            type: "string",
            description: "Element ID from page_analyze"
          }
        },
        required: ["element_id"]
      }
    },
    // Workspace and Reference Management Tools
    {
      name: "get_bookmarks",
      description: "Get all bookmarks or search for specific bookmarks",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query for bookmarks (optional)"
          }
        }
      }
    },
    {
      name: "add_bookmark",
      description: "Add a new bookmark",
      inputSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Title of the bookmark"
          },
          url: {
            type: "string",
            description: "URL of the bookmark"
          },
          parentId: {
            type: "string",
            description: "ID of the parent folder (optional)"
          }
        },
        required: ["title", "url"]
      }
    },
    {
      name: "get_history",
      description: "Search browser history with comprehensive filters for finding previous work by date/keywords",
      inputSchema: {
        type: "object",
        properties: {
          keywords: {
            type: "string",
            description: "Search keywords to match in page titles and URLs"
          },
          start_date: {
            type: "string",
            format: "date-time",
            description: "Start date for history search (ISO 8601 format)"
          },
          end_date: {
            type: "string",
            format: "date-time",
            description: "End date for history search (ISO 8601 format)"
          },
          domains: {
            type: "array",
            items: { type: "string" },
            description: "Filter by specific domains (e.g., ['github.com', 'stackoverflow.com'])"
          },
          min_visit_count: {
            type: "number",
            default: 1,
            description: "Minimum visit count threshold"
          },
          max_results: {
            type: "number",
            default: 50,
            maximum: 500,
            description: "Maximum number of results to return"
          },
          sort_by: {
            type: "string",
            enum: ["visit_time", "visit_count", "title"],
            default: "visit_time",
            description: "Sort results by visit time, visit count, or title"
          },
          sort_order: {
            type: "string",
            enum: ["desc", "asc"],
            default: "desc",
            description: "Sort order (descending or ascending)"
          }
        }
      }
    },
    {
      name: "get_selected_text",
      description: "📝 BACKGROUND TAB READY: Get selected text from any tab without switching! Perfect for collecting quotes, citations, or highlighted content from multiple research tabs simultaneously.",
      inputSchema: {
        type: "object",
        properties: {
          include_metadata: {
            type: "boolean",
            default: true,
            description: "Include metadata about the selection (element info, position, etc.)"
          },
          max_length: {
            type: "number",
            default: 10000,
            description: "Maximum length of text to return"
          },
          tab_id: {
            type: "number",
            description: "🎯 TARGET ANY TAB: Get selected text from background tabs without switching! Perfect for collecting quotes or snippets from multiple research tabs."
          }
        }
      }
    },
    {
      name: "page_scroll",
      description: "📜 BACKGROUND TAB READY: Scroll any tab without switching! Critical for long pages. Navigate through content in background tabs while staying on current page. Use tab_id to target specific tabs.",
      inputSchema: {
        type: "object",
        properties: {
          direction: {
            type: "string",
            enum: ["up", "down", "left", "right", "top", "bottom"],
            default: "down",
            description: "Direction to scroll"
          },
          amount: {
            type: "string",
            enum: ["small", "medium", "large", "page", "custom"],
            default: "medium",
            description: "Amount to scroll"
          },
          pixels: {
            type: "number",
            description: "Custom pixel amount (when amount is 'custom')"
          },
          smooth: {
            type: "boolean",
            default: true,
            description: "Use smooth scrolling animation"
          },
          element_id: {
            type: "string",
            description: "Scroll to specific element (overrides direction/amount)"
          },
          wait_after: {
            type: "number",
            default: 500,
            description: "Milliseconds to wait after scrolling"
          },
          tab_id: {
            type: "number",
            description: "🎯 TARGET ANY TAB: Scroll content in background tabs without switching! Perfect for navigating long documents or pages in multiple tabs simultaneously."
          }
        }
      }
    },
    {
      name: "get_page_links",
      description: "Get all hyperlinks on the current page with filtering options",
      inputSchema: {
        type: "object",
        properties: {
          link_type: {
            type: "string",
            enum: ["all", "internal", "external"],
            default: "all",
            description: "Filter by internal/external links"
          },
          domains: {
            type: "array",
            items: { type: "string" },
            description: "Filter by specific domains (optional)"
          },
          max_results: {
            type: "number",
            default: 50,
            maximum: 200,
            description: "Maximum links to return"
          }
        }
      }
    },
    {
      name: "page_style",
      description: "🎨 Transform page appearance with themes, colors, fonts, and fun effects! Apply preset themes like 'dark_hacker', 'retro_80s', or create custom styles. Perfect for making boring pages fun or improving readability.",
      inputSchema: {
        type: "object",
        examples: [
          { mode: "preset", theme: "dark_hacker" },
          { mode: "custom", background: "#000", text_color: "#00ff00", font: "monospace" },
          { mode: "ai_mood", mood: "cozy coffee shop vibes", intensity: "strong" },
          { mode: "effect", effect: "matrix_rain", duration: 30 }
        ],
        properties: {
          mode: {
            type: "string", 
            enum: ["preset", "custom", "ai_mood", "effect", "reset"],
            description: "Styling mode to use"
          },
          theme: {
            type: "string",
            enum: ["dark_hacker", "retro_80s", "rainbow_party", "minimalist_zen", "high_contrast", "cyberpunk", "pastel_dream", "newspaper"],
            description: "Preset theme name (when mode=preset)"
          },
          background: { 
            type: "string", 
            description: "Background color/gradient" 
          },
          text_color: { 
            type: "string", 
            description: "Text color" 
          },
          font: { 
            type: "string", 
            description: "Font family" 
          },
          font_size: { 
            type: "string", 
            description: "Font size (e.g., '1.2em', '16px')" 
          },
          mood: { 
            type: "string", 
            description: "Describe desired mood/feeling (when mode=ai_mood)" 
          },
          intensity: { 
            type: "string", 
            enum: ["subtle", "medium", "strong"], 
            default: "medium" 
          },
          effect: { 
            type: "string", 
            enum: ["matrix_rain", "floating_particles", "cursor_trail", "neon_glow", "typing_effect"] 
          },
          duration: { 
            type: "number", 
            description: "Effect duration in seconds", 
            default: 10 
          },
          remember: {
            type: "boolean",
            description: "Remember this style for this website",
            default: false
          }
        },
        required: ["mode"]
      }
    },
    // ---- Power tools (Everywhere fork) -------------------------------
    // Inspired by open-browser-use executeCdp + OpenChromeCLI evaluateScript:
    // give the host a low-level escape hatch when the heuristic
    // page_analyze can't find the element it needs.
    {
      name: "evaluate_js",
      description: "🛠️ POWER TOOL: Run arbitrary JavaScript in the page's MAIN world via chrome.scripting.executeScript. Returns the function's return value (JSON-serializable). Use when page_analyze can't see the element you need, or you need to interact with shadow DOM, custom web components, or hidden controls.",
      inputSchema: {
        type: "object",
        properties: {
          tab_id: { type: "number", description: "Target tab id. If omitted, uses active tab." },
          expression: { type: "string", description: "JS expression OR full function body. The code is wrapped in `() => { <expression> }`, so a trailing `return` is needed for non-expression bodies." },
          args: { type: "array", description: "Arguments forwarded as the function's parameters (JSON-serializable).", default: [] },
          world: { type: "string", enum: ["MAIN", "ISOLATED"], default: "MAIN", description: "Execution world. MAIN sees page globals; ISOLATED is the content-script sandbox." },
          timeout_ms: { type: "number", default: 5000, description: "Hard timeout for the script." }
        },
        required: ["expression"]
      }
    },
    {
      name: "dom_query",
      description: "🎯 POWER TOOL: Find ONE element by CSS selector (with optional shadow-DOM piercing) and perform an action: click, fill, focus, scroll_into_view, get_text, get_attr, get_html, exists. Bypasses page_analyze's heuristics entirely.",
      inputSchema: {
        type: "object",
        properties: {
          tab_id: { type: "number", description: "Target tab id. Defaults to active tab." },
          selector: { type: "string", description: "CSS selector. Use ' >>> ' to pierce open shadow roots (e.g. 'my-host >>> button.submit')." },
          action: { type: "string", enum: ["click","fill","focus","scroll_into_view","get_text","get_attr","get_html","exists","submit_form"], description: "What to do once the element is located." },
          value: { type: "string", description: "Text for action=fill, or attribute name for action=get_attr." },
          nth: { type: "number", default: 0, description: "Index when the selector matches multiple elements (0=first)." }
        },
        required: ["selector", "action"]
      }
    },
    {
      name: "dom_query_all",
      description: "🔎 POWER TOOL: Enumerate every element matching a CSS selector (shadow-piercing). For each match return tagName, text (trimmed), role, id, classes, name, type, value, href, aria-label, visible, rect. Use this when page_analyze's heuristic 15-element cap is hiding the button you need.",
      inputSchema: {
        type: "object",
        properties: {
          tab_id: { type: "number", description: "Target tab id." },
          selector: { type: "string", description: "CSS selector. Supports ' >>> ' shadow piercing.", default: "button, [role=button], input, textarea, select, a[href]" },
          limit: { type: "number", default: 100, description: "Cap on results." },
          visible_only: { type: "boolean", default: true, description: "Filter to elements with non-zero bounding box." },
          all_frames: { type: "boolean", default: false, description: "Walk every iframe in the tab and merge results (each row carries a frame_id field)." }
        }
      }
    },
    {
      name: "wait_for_selector",
      description: "⏳ POWER TOOL: Poll until a CSS selector matches (or timeout). Useful right after navigation or after a click that triggers async DOM updates.",
      inputSchema: {
        type: "object",
        properties: {
          tab_id: { type: "number" },
          selector: { type: "string", description: "CSS selector. Supports ' >>> '." },
          timeout_ms: { type: "number", default: 8000 },
          visible: { type: "boolean", default: true, description: "Require non-zero bounding box." }
        },
        required: ["selector"]
      }
    },
    {
      name: "dispatch_keys",
      description: "⌨️ POWER TOOL: Dispatch real KeyboardEvents (keydown + keypress + keyup) on a CSS-selected element (or document). Use to send Enter / Cmd+Enter / Tab / Escape / arrows / typed text to forms that don't react to .click() or to fill+blur.",
      inputSchema: {
        type: "object",
        properties: {
          tab_id: { type: "number" },
          selector: { type: "string", description: "Optional CSS selector for target. Defaults to document.activeElement, then document.body." },
          keys: { type: "array", items: { type: "string" }, description: "Sequence of keys, e.g. [\"Enter\"], [\"Tab\",\"Tab\",\"Enter\"], [\"Meta+Enter\"]." }
        },
        required: ["keys"]
      }
    },
    {
      name: "screenshot",
      description: "📸 POWER TOOL: Capture the visible area of a tab as PNG (base64). Useful for verifying clicks / form-submit results visually.",
      inputSchema: {
        type: "object",
        properties: {
          tab_id: { type: "number", description: "Tab to capture. Defaults to active tab in current window." },
          format: { type: "string", enum: ["png","jpeg"], default: "png" },
          quality: { type: "number", default: 90, description: "JPEG quality 0-100 (ignored for PNG)." }
        }
      }
    },
    // ---- CDP power tools (Everywhere fork) ---------------------------
    // Everything below requires chrome.debugger.attach. Chrome shows a
    // "OpenDia is debugging this browser" warning bar on the affected
    // tab — that is browser-enforced and unavoidable. In exchange, you
    // get isTrusted=true input events, network capture, console
    // capture, file upload via DOM.setFileInputFiles, etc.
    {
      name: "cdp_evaluate",
      description: "🚀 CDP: Run arbitrary JS in the page via Runtime.evaluate (await supported, bypasses page CSP). Use when dom_query is not enough.",
      inputSchema: {
        type: "object",
        properties: {
          tab_id: { type: "number" },
          expression: { type: "string", description: "JS expression. Wrapped to support top-level await." },
          await_promise: { type: "boolean", default: true },
          return_by_value: { type: "boolean", default: true },
          timeout_ms: { type: "number", default: 10000 }
        },
        required: ["tab_id", "expression"]
      }
    },
    {
      name: "cdp_input_mouse",
      description: "🖱️ CDP: dispatch isTrusted=true mouse events at viewport coordinates (mousePressed + mouseReleased). For sites that reject scripted .click() (Cloudflare/Turnstile/Stripe).",
      inputSchema: {
        type: "object",
        properties: {
          tab_id: { type: "number" },
          x: { type: "number" },
          y: { type: "number" },
          button: { type: "string", enum: ["left","right","middle"], default: "left" },
          click_count: { type: "number", default: 1 }
        },
        required: ["tab_id", "x", "y"]
      }
    },
    {
      name: "cdp_input_keys",
      description: "⌨️ CDP: type real isTrusted keystrokes via Input.dispatchKeyEvent. Each entry is either a single character (typed as text) or a key spec like 'Enter', 'Meta+Enter', 'Tab'.",
      inputSchema: {
        type: "object",
        properties: {
          tab_id: { type: "number" },
          keys: { type: "array", items: { type: "string" }, description: "Sequence to type." }
        },
        required: ["tab_id", "keys"]
      }
    },
    {
      name: "cdp_list_network_requests",
      description: "🌐 CDP: list HTTP(S) requests captured since attach. Use cdp_get_response_body(request_id) to fetch a body.",
      inputSchema: {
        type: "object",
        properties: {
          tab_id: { type: "number" },
          limit: { type: "number", default: 200 },
          since_ms: { type: "number", description: "Filter to requests started after this unix-ms timestamp." },
          method_filter: { type: "string", description: "Substring filter on HTTP method (GET/POST/...)." },
          url_filter: { type: "string", description: "Substring filter on URL." }
        }
      }
    },
    {
      name: "cdp_get_response_body",
      description: "🌐 CDP: fetch the response body for a captured request_id (from cdp_list_network_requests).",
      inputSchema: {
        type: "object",
        properties: {
          tab_id: { type: "number" },
          request_id: { type: "string" }
        },
        required: ["tab_id", "request_id"]
      }
    },
    {
      name: "cdp_list_console_messages",
      description: "📜 CDP: list console.* + Log entries captured since attach.",
      inputSchema: {
        type: "object",
        properties: {
          tab_id: { type: "number" },
          limit: { type: "number", default: 200 },
          level_filter: { type: "string", description: "info/log/warning/error/debug filter." }
        }
      }
    },
    {
      name: "cdp_upload_file",
      description: "📁 CDP: set files on a <input type=file> selected by CSS. Uses DOM.querySelector + DOM.setFileInputFiles. file_paths are absolute paths on the host machine running Chrome.",
      inputSchema: {
        type: "object",
        properties: {
          tab_id: { type: "number" },
          selector: { type: "string" },
          file_paths: { type: "array", items: { type: "string" } }
        },
        required: ["tab_id", "selector", "file_paths"]
      }
    },
    {
      name: "wait_for_download",
      description: "⬇️ Wait for the next download to start (or one already in progress to finish), then return its final filename + path. Uses chrome.downloads API.",
      inputSchema: {
        type: "object",
        properties: {
          timeout_ms: { type: "number", default: 30000 },
          since_ms: { type: "number", description: "Only consider downloads started after this unix-ms timestamp." }
        }
      }
    },
    {
      name: "get_cookies",
      description: "🍪 List cookies via chrome.cookies.getAll. Filter by url or domain.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          domain: { type: "string" },
          name: { type: "string" }
        }
      }
    },
    {
      name: "set_cookie",
      description: "🍪 Set a cookie via chrome.cookies.set.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          name: { type: "string" },
          value: { type: "string" },
          domain: { type: "string" },
          path: { type: "string", default: "/" },
          secure: { type: "boolean" },
          http_only: { type: "boolean" },
          expires_seconds: { type: "number", description: "Seconds from now until expiration." }
        },
        required: ["url","name","value"]
      }
    },
    {
      name: "clear_cookies",
      description: "🍪 Remove cookies matching url+name (chrome.cookies.remove).",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          name: { type: "string" }
        },
        required: ["url"]
      }
    },
    {
      name: "open_incognito_tab",
      description: "🕵️ Open a new tab in a fresh Incognito window (clean cookies / storage).",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", default: "about:blank" }
        }
      }
    },
    {
      name: "emulate_device",
      description: "📱 Override viewport + user agent via Emulation.setDeviceMetricsOverride / setUserAgentOverride. Pass clear:true to revert.",
      inputSchema: {
        type: "object",
        properties: {
          tab_id: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
          device_scale_factor: { type: "number", default: 2 },
          mobile: { type: "boolean", default: true },
          user_agent: { type: "string" },
          clear: { type: "boolean", default: false }
        },
        required: ["tab_id"]
      }
    },
    // ---- OBU parity (Everywhere fork) -------------------------------
    // Clipboard + session + cursor — last 4-OBU-method gap.
    {
      name: "clipboard_read_text",
      description: "📋 Read the active page's clipboard as plain text. Calls navigator.clipboard.readText() in MAIN world via CDP — the page must be focused and have clipboard-read permission, otherwise the browser refuses (we surface the rejection).",
      inputSchema: {
        type: "object",
        properties: { tab_id: { type: "number" } },
        required: ["tab_id"]
      }
    },
    {
      name: "clipboard_write_text",
      description: "📋 Write plain text to the system clipboard via the active page (navigator.clipboard.writeText). Requires the page to be focused.",
      inputSchema: {
        type: "object",
        properties: { tab_id: { type: "number" }, text: { type: "string" } },
        required: ["tab_id", "text"]
      }
    },
    {
      name: "clipboard_read",
      description: "📋 Read the clipboard as ClipboardItems (text/* and image/* MIME types). Uses navigator.clipboard.read(); returns an array of {type, data_base64} entries.",
      inputSchema: {
        type: "object",
        properties: { tab_id: { type: "number" } },
        required: ["tab_id"]
      }
    },
    {
      name: "clipboard_write",
      description: "📋 Write rich items to the clipboard. Each entry is {type, data_base64}. Most browsers only allow text/plain and image/png from a script.",
      inputSchema: {
        type: "object",
        properties: {
          tab_id: { type: "number" },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string" },
                data_base64: { type: "string" }
              },
              required: ["type", "data_base64"]
            }
          }
        },
        required: ["tab_id", "items"]
      }
    },
    {
      name: "claim_tab",
      description: "🏷️ Mark a user tab as 'owned by this agent session'. Stored in chrome.storage; finalize_tabs reads this list.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          tab_id: { type: "number" }
        },
        required: ["session_id", "tab_id"]
      }
    },
    {
      name: "finalize_tabs",
      description: "🏷️ End the agent session. For each claimed tab in `keep`, leave it open with the requested status; tabs claimed but not in keep are closed. Mirrors OBU finalizeTabs.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          keep: {
            type: "array",
            items: {
              type: "object",
              properties: {
                tab_id: { type: "number" },
                status: { type: "string", description: "handoff | deliverable | reviewed | (free-form)" }
              },
              required: ["tab_id"]
            }
          }
        },
        required: ["session_id"]
      }
    },
    {
      name: "name_session",
      description: "🏷️ Set the chrome.tabGroups title for a session, so its claimed tabs are visually grouped under that name. Falls back to a no-op when tabGroups API isn't present.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          name: { type: "string" }
        },
        required: ["session_id", "name"]
      }
    },
    {
      name: "move_mouse",
      description: "🖱️ Visual-only cursor move. Updates the on-screen software cursor (when Everywhere CursorOverlay is enabled) without dispatching any input. Use to telegraph intent before a real click. Mirrors OBU moveMouse.",
      inputSchema: {
        type: "object",
        properties: {
          tab_id: { type: "number" },
          x: { type: "number" },
          y: { type: "number" }
        },
        required: ["x", "y"]
      }
    },
  ];

  // Strip CDP / Chromium-specific power tools when running under Firefox
  // (no chrome.debugger / Emulation.* / chrome.windows.create({incognito})
  // semantics there). Otherwise the MCP host advertises tools that
  // unconditionally throw a misleading "chrome.debugger is undefined"
  // when called.
  if (browserInfo.isFirefox) {
    const chromiumOnly = new Set([
      "cdp_evaluate", "cdp_input_mouse", "cdp_input_keys",
      "cdp_list_network_requests", "cdp_get_response_body",
      "cdp_list_console_messages", "cdp_upload_file",
      "open_incognito_tab", "emulate_device",
    ]);
    return tools.filter(t => !chromiumOnly.has(t.name));
  }
  return tools;
}

// Handle MCP requests with enhanced automation tools
async function handleMCPRequest(message) {
  const { id, method, params } = message;

  try {
    // Ensure connection for Chrome service workers
    await connectionManager.ensureConnection();

    // Safety Mode check: Block write/edit tools if safety mode is enabled
    if (safetyModeEnabled && WRITE_EDIT_TOOLS.includes(method)) {
      const targetInfo = params.tab_id ? `tab ${params.tab_id}` : 'the current page';
      throw new Error(`🛡️ Safety Mode is enabled. This tool (${method}) is blocked to prevent modifications to ${targetInfo}. To disable Safety Mode, open the OpenDia extension popup and toggle off "Safety Mode".`);
    }

    let result;

    switch (method) {
      // New automation tools with background tab support
      case "snapshot":
        result = await sendToContentScript('snapshot', params, params.tab_id);
        break;
      case "page_analyze":
        result = await sendToContentScript('analyze', params, params.tab_id);
        break;
      case "page_extract_content":
        result = await sendToContentScript('extract_content', params, params.tab_id);
        break;
      case "element_click":
        result = await sendToContentScript('element_click', params, params.tab_id);
        break;
      case "element_fill":
        result = await sendToContentScript('element_fill', params, params.tab_id);
        break;
      case "page_navigate":
        result = await navigateToUrl(params.url, params.wait_for, params.timeout);
        break;
      case "open":
        // SPEC alias for page_navigate; matches ab agent_browser_open.
        result = await navigateToUrl(params.url, params.wait_for, params.timeout);
        break;
      case "tab_new":
        result = await createTab({ url: params.url, active: params.active });
        break;
      case "dblclick":
      case "scroll_into_view":
      case "select":
      case "drag":
      case "get_text":
      case "get_html":
      case "get_value":
      case "get_attr":
      case "is_visible":
      case "is_enabled":
      case "is_checked":
      case "find_by_role":
      case "find_by_text":
      case "find_by_label":
      case "find_by_placeholder":
      case "find_by_testid":
      case "find":
      case "errors":
      case "highlight":
      case "frame_main":
      case "react_tree":
      case "react_inspect":
      case "react_renders_start":
      case "react_renders_stop":
      case "react_suspense":
      case "storage_get":
      case "storage_set":
      case "storage_clear":
      case "upload":
      case "dialog_status":
      case "console":
      case "vitals":
      case "inspect":
      case "wait_for_function":
      case "diff_snapshot":
      case "get_box":
      case "get_styles":
      case "get_count":
      case "tap":
      case "mouse_down":
      case "mouse_up":
      case "mouse_move":
      case "mouse_wheel":
      case "keydown":
      case "keyup":
      case "keyboard_type":
      case "keyboard_insert_text":
      case "swipe":
      case "pushstate":
        result = await sendToContentScript(method, params, params.tab_id);
        break;
      case "set_viewport":
        result = await cdpSetViewport(params);
        break;
      case "device":
        result = await cdpSetViewport(devicePreset(params.name, params.tab_id));
        break;
      case "set_geo":
        result = await cdpSetGeo(params);
        break;
      case "set_media":
        result = await cdpSetMedia(params);
        break;
      case "dialog_accept":
      case "confirm":
        result = await prearmDialog(params.tab_id, "accept", params.text);
        break;
      case "dialog_dismiss":
      case "deny":
        result = await prearmDialog(params.tab_id, "dismiss", null);
        break;
      case "diff_url":
        result = await diffUrl(params);
        break;
      case "download":
        result = await chrome.downloads.download({ url: params.url, filename: params.filename })
                       .then((id) => ({ ok: true, download_id: id, url: params.url }));
        break;
      case "diff_screenshot":
        result = await diffScreenshot(params);
        break;
      case "pdf":
        result = await capturePdf(params);
        break;
      case "network_requests":
      case "network_har_stop":
        result = await flushNetworkBuffer(params);
        break;
      case "network_har_start":
        ensureNetListener();
        result = { ok: true, started: true };
        break;
      // wait_for_download handled by the pre-existing case below
      // (richer schema {timeout_ms, since_ms}). Removed the duplicate
      // case here per round-4a review R2.
      case "frame_switch":
        result = await frameSwitch(params);
        break;
      case "add_init_script":
        result = await addInitScript(params);
        break;
      case "remove_init_script":
        result = await removeInitScript(params);
        break;
      case "window_new":
        result = await chrome.windows.create({ url: params.url, focused: params.focused !== false })
                       .then((w) => ({ ok: true, window_id: w.id }));
        break;
      case "set_offline":
        result = await cdpSetOffline(params);
        break;
      case "profiler_start":
        result = await cdpProfilerStart(params);
        break;
      case "profiler_stop":
        result = await cdpProfilerStop(params);
        break;
      case "trace_start":
        result = await cdpTraceStart(params);
        break;
      case "trace_stop":
        result = await cdpTraceStop(params);
        break;
      case "cookies_get":
        result = await cookiesGet(params);
        break;
      case "cookies_clear":
        result = await cookiesClear(params);
        break;
      case "cookies_set":
        result = await cookiesSet(params);
        break;
      case "cookies_set_curl":
        result = await cookiesSetCurl(params);
        break;
      case "set_headers":
        result = await cdpSetHeaders(params);
        break;
      case "set_credentials":
        result = await cdpSetCredentials(params);
        break;
      case "network_request":
        result = await backgroundFetch(params);
        break;
      case "network_route":
        result = await cdpRouteInstall(params);
        break;
      case "network_unroute":
        result = await cdpRouteClear(params);
        break;
      case "auth_save":
        result = await authSave(params);
        break;
      case "auth_login":
        result = await authLogin(params);
        break;
      case "auth_show":
        result = await authShow(params);
        break;
      case "auth_list":
        result = await authList();
        break;
      case "auth_delete":
        result = await authDelete(params);
        break;
      case "state_save":
        result = await stateSave(params);
        break;
      case "state_load":
        result = await stateLoad(params);
        break;
      case "state_show":
        result = await stateShow(params);
        break;
      case "state_list":
        result = await stateList();
        break;
      case "state_clear":
        result = await stateClear(params);
        break;
      case "state_clean":
        result = await stateClean();
        break;
      case "state_rename":
        result = await stateRename(params);
        break;
      case "eval":
        result = await pageEval(params);
        break;
      case "get_cdp_url":
        result = await getCdpUrl(params);
        break;
      case "hover":
        result = await sendToContentScript('hover', params, params.tab_id);
        break;
      case "focus":
        result = await sendToContentScript('focus', params, params.tab_id);
        break;
      case "check":
        result = await sendToContentScript('check', params, params.tab_id);
        break;
      case "uncheck":
        result = await sendToContentScript('uncheck', params, params.tab_id);
        break;
      case "wait_ms":
        result = await sendToContentScript('wait_ms', params, params.tab_id);
        break;
      // wait_for_selector handled by the pre-existing power-tool case
      // below (waitForSelector(params)). Removed the duplicate case here
      // per round-4a review R1.
      case "wait_for_text":
        result = await sendToContentScript('wait_for_text', params, params.tab_id);
        break;
      case "wait_for_url":
        result = await waitForTabUrl(params);
        break;
      case "wait_for_load":
        result = await waitForTabLoad(params);
        break;
      case "close":
        result = await closeTabs({ tab_id: params.tab_id });
        break;
      case "press":
        result = await sendToContentScript('press', params, params.tab_id);
        break;
      case "scroll":
        result = await sendToContentScript('scroll', params, params.tab_id);
        break;
      // screenshot handled by the pre-existing case below (same fn).
      // Removed the duplicate case here per round-4a review R3.
      case "get_url":
        result = await tabGetField(params.tab_id, "url");
        break;
      case "get_title":
        result = await tabGetField(params.tab_id, "title");
        break;
      case "click":
        // SPEC ab agent_browser_click — @refN-based.
        result = await sendToContentScript('click', params, params.tab_id);
        break;
      case "fill":
        result = await sendToContentScript('fill', params, params.tab_id);
        break;
      case "type":
        result = await sendToContentScript('type', params, params.tab_id);
        break;
      case "back":
        // SPEC ab agent_browser_back.
        result = await tabHistoryNavigate("back", params.tab_id);
        break;
      case "forward":
        result = await tabHistoryNavigate("forward", params.tab_id);
        break;
      case "reload":
        result = await tabReload(params.tab_id, !!params.bypass_cache);
        break;
      case "page_wait_for":
        result = await sendToContentScript('wait_for', params, params.tab_id);
        break;
        
      // Tab management tools
      case "tab_create":
        result = await createTab(params);
        break;
      case "tab_close":
        result = await closeTabs(params);
        break;
      case "tab_list":
        result = await listTabs(params);
        break;
      case "tab_switch":
        result = await switchToTab(params.tab_id);
        break;
        
      // Element state tools
      case "element_get_state":
        result = await sendToContentScript('get_element_state', params, params.tab_id);
        break;
      // Workspace and Reference Management Tools
      case "get_bookmarks":
        result = await getBookmarks(params);
        break;
      case "add_bookmark":
        result = await addBookmark(params);
        break;
      case "get_history":
        result = await getHistory(params);
        break;
      case "get_selected_text":
        result = await getSelectedText(params);
        break;
      case "page_scroll":
        result = await sendToContentScript('page_scroll', params, params.tab_id);
        break;
      case "get_page_links":
        result = await sendToContentScript('get_page_links', params, params.tab_id);
        break;
      case "page_style":
        result = await sendToContentScript('page_style', params, params.tab_id);
        break;

      // ---- Power tools (Everywhere fork) -----------------------------
      case "evaluate_js":
        result = await evaluateJs(params);
        break;
      case "dom_query":
        result = await domQuery(params);
        break;
      case "dom_query_all":
        result = await domQueryAll(params);
        break;
      case "wait_for_selector":
        result = await waitForSelector(params);
        break;
      case "dispatch_keys":
        result = await dispatchKeys(params);
        break;
      case "screenshot":
        result = await captureScreenshot(params);
        break;

      // CDP power tools
      case "cdp_evaluate":
        result = await cdpEvaluate(params); break;
      case "cdp_input_mouse":
        result = await cdpInputMouse(params); break;
      case "cdp_input_keys":
        result = await cdpInputKeys(params); break;
      case "cdp_list_network_requests":
        result = await cdpListNetworkRequests(params); break;
      case "cdp_get_response_body":
        result = await cdpGetResponseBody(params); break;
      case "cdp_list_console_messages":
        result = await cdpListConsoleMessages(params); break;
      case "cdp_upload_file":
        result = await cdpUploadFile(params); break;
      case "wait_for_download":
        result = await waitForDownload(params); break;
      case "get_cookies":
        result = await getCookies(params); break;
      case "set_cookie":
        result = await setCookie(params); break;
      case "clear_cookies":
        result = await clearCookies(params); break;
      case "open_incognito_tab":
        result = await openIncognitoTab(params); break;
      case "emulate_device":
        result = await emulateDevice(params); break;

      // OBU parity
      case "clipboard_read_text":
        result = await clipboardReadText(params); break;
      case "clipboard_write_text":
        result = await clipboardWriteText(params); break;
      case "clipboard_read":
        result = await clipboardRead(params); break;
      case "clipboard_write":
        result = await clipboardWrite(params); break;
      case "claim_tab":
        result = await claimTab(params); break;
      case "finalize_tabs":
        result = await finalizeTabs(params); break;
      case "name_session":
        result = await nameSession(params); break;
      case "move_mouse":
        result = await moveMouse(params); break;

      default:
        throw new Error(`Unknown method: ${method}`);
    }

    // Send success response
    connectionManager.send({
      id,
      result,
    });
  } catch (error) {
    // Send error response
    connectionManager.send({
      id,
      error: {
        message: error.message,
        code: -32603,
      },
    });
  }
}

// Enhanced content script communication with background tab support
// ---- Power tools (Everywhere fork) ---------------------------------------
// These four handlers give the MCP host a low-level DOM escape hatch via
// chrome.scripting.executeScript so it isn't bound by page_analyze's
// heuristic 15-element cap or its blindness to icon-only / custom-element
// buttons.

async function _resolveTabId(tabId) {
  if (tabId) {
    try { await browser.tabs.get(tabId); return tabId; }
    catch { throw new Error(`Tab ${tabId} not found or inaccessible`); }
  }
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!active) throw new Error("No active tab");
  return active.id;
}

async function _exec(tabId, world, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world,
    func,
    args,
  });
  // executeScript returns one entry per frame; take main frame (frameId 0).
  const main = results.find(r => r.frameId === 0) || results[0];
  if (!main) throw new Error("executeScript returned no frames");
  return main.result;
}

// MAIN-world entrypoint. Receives the whole user payload as a JSON-encoded
// arg (CSP in MV3 forbids `new Function()`, so we can't compile user code
// in the service worker — instead this one real function runs in the page
// and dispatches on `op`). Returns { ok, result } / { ok:false, error }.
function _odMainWorld(payload) {
  const { op, selector, action, value, nth, visibleOnly, limit, timeoutMs, requireVisible, keys, expression, args } = payload;

  function resolve(sel, nthIdx, allMatches) {
    const parts = String(sel || '').split(' >>> ').map(s => s.trim()).filter(Boolean);
    if (parts.length === 0) return allMatches ? [] : null;
    let roots = [document];
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      const next = [];
      for (const root of roots) {
        let found;
        try { found = root.querySelectorAll(parts[i]); } catch { return allMatches ? [] : null; }
        for (const el of found) {
          if (last) next.push(el);
          else if (el.shadowRoot) next.push(el.shadowRoot);
        }
      }
      roots = next;
      if (!last && roots.length === 0) break;
    }
    if (allMatches) return roots;
    return roots[nthIdx || 0] || null;
  }
  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  }
  function describe(el) {
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { x:0,y:0,width:0,height:0 };
    return {
      tag: el.tagName ? el.tagName.toLowerCase() : null,
      id: el.id || null,
      classes: el.className && typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean) : [],
      text: (el.innerText || el.textContent || '').trim().slice(0, 200),
      role: el.getAttribute ? el.getAttribute('role') : null,
      name: el.getAttribute ? (el.getAttribute('name') || el.getAttribute('aria-label') || el.getAttribute('title')) : null,
      type: el.type || null,
      value: el.value !== undefined ? String(el.value).slice(0, 200) : null,
      href: el.href || null,
      placeholder: el.placeholder || null,
      visible: visible(el),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    };
  }
  function parseKey(spec) {
    const parts = spec.split('+').map(s => s.trim()).filter(Boolean);
    const mods = { ctrl:false, meta:false, alt:false, shift:false };
    let key = parts.pop();
    for (const p of parts) {
      const low = p.toLowerCase();
      if (low === 'ctrl' || low === 'control') mods.ctrl = true;
      else if (low === 'meta' || low === 'cmd' || low === 'command') mods.meta = true;
      else if (low === 'alt' || low === 'option') mods.alt = true;
      else if (low === 'shift') mods.shift = true;
    }
    return { key, mods };
  }

  try {
    if (op === 'evaluate_js') {
      // CSP: can't construct a function from a string. Document this and refuse cleanly.
      return { ok: false, error: "evaluate_js is unavailable in MV3 (page CSP forbids new Function). Use dom_query / dom_query_all / dispatch_keys / wait_for_selector instead." };
    }

    if (op === 'dom_query') {
      const el = resolve(selector, nth, false);
      if (!el) return { ok: true, result: { found: false } };
      const info = describe(el);
      let outcome = null;
      switch (action) {
        case 'click':
          el.scrollIntoView({ block: 'center', inline: 'center' });
          if (typeof el.click === 'function') el.click();
          else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          outcome = 'clicked';
          break;
        case 'fill': {
          el.focus();
          if ('value' in el) {
            const nativeSetter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
            if (nativeSetter && nativeSetter.set) nativeSetter.set.call(el, value);
            else el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } else if (el.isContentEditable) {
            el.textContent = value;
            el.dispatchEvent(new InputEvent('input', { bubbles: true }));
          } else {
            return { ok: false, error: 'dom_query fill: element is not fillable' };
          }
          outcome = 'filled';
          break;
        }
        case 'focus': el.focus(); outcome = 'focused'; break;
        case 'scroll_into_view':
          el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
          outcome = 'scrolled'; break;
        case 'get_text':
          outcome = (el.innerText || el.textContent || '').trim(); break;
        case 'get_attr':
          outcome = el.getAttribute ? el.getAttribute(value) : null; break;
        case 'get_html':
          outcome = el.outerHTML; break;
        case 'exists':
          outcome = true; break;
        case 'submit_form': {
          let form = el.tagName === 'FORM' ? el : el.closest('form');
          if (!form) return { ok: false, error: 'submit_form: no enclosing <form>' };
          if (form.requestSubmit) form.requestSubmit(); else form.submit();
          outcome = 'submitted'; break;
        }
        default:
          return { ok: false, error: 'dom_query: unknown action ' + action };
      }
      return { ok: true, result: { found: true, element: info, outcome } };
    }

    if (op === 'dom_query_all') {
      const all = resolve(selector, 0, true);
      const out = [];
      const cap = Math.max(1, Math.min(2000, limit || 100));
      for (const el of all) {
        if (visibleOnly && !visible(el)) continue;
        out.push(describe(el));
        if (out.length >= cap) break;
      }
      return { ok: true, result: { count: out.length, total_matches: all.length, elements: out } };
    }

    if (op === 'wait_for_selector') {
      return new Promise((resolve2) => {
        const start = Date.now();
        const cap = Math.max(100, Math.min(60000, timeoutMs || 8000));
        function tick() {
          const el = resolve(selector, 0, false);
          if (el && (!requireVisible || visible(el))) {
            resolve2({ ok: true, result: { matched: true, elapsed_ms: Date.now() - start, element: describe(el) } });
            return;
          }
          if (Date.now() - start >= cap) {
            resolve2({ ok: true, result: { matched: false, elapsed_ms: Date.now() - start } });
            return;
          }
          requestAnimationFrame(tick);
        }
        tick();
      });
    }

    if (op === 'dispatch_keys') {
      let target = selector ? resolve(selector, 0, false) : (document.activeElement || document.body);
      if (!target) return { ok: true, result: { dispatched: false, reason: 'no target' } };
      target.focus && target.focus();
      const dispatched = [];
      for (const spec of keys) {
        const { key, mods } = parseKey(spec);
        const init = {
          key, code: key.length === 1 ? 'Key' + key.toUpperCase() : key,
          bubbles: true, cancelable: true, composed: true,
          ctrlKey: mods.ctrl, metaKey: mods.meta, altKey: mods.alt, shiftKey: mods.shift,
        };
        target.dispatchEvent(new KeyboardEvent('keydown', init));
        if (key.length === 1) target.dispatchEvent(new KeyboardEvent('keypress', init));
        target.dispatchEvent(new KeyboardEvent('keyup', init));
        dispatched.push(spec);
      }
      return { ok: true, result: { dispatched: true, keys: dispatched, target_tag: target.tagName ? target.tagName.toLowerCase() : null } };
    }

    return { ok: false, error: 'unknown op ' + op };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

async function _runInMain(tabId, payload, world) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: world || 'MAIN',
    func: _odMainWorld,
    args: [payload],
  });
  const main = results.find(r => r.frameId === 0) || results[0];
  if (!main) throw new Error("executeScript returned no frames");
  const r = main.result;
  if (!r || typeof r !== 'object') throw new Error("MAIN world returned no payload");
  if (!r.ok) throw new Error(r.error || "MAIN world reported failure");
  return r.result;
}

// Run the same MAIN-world dispatcher across every frame in the tab and
// merge the per-frame results. Used by dom_query_all when callers ask
// for cross-frame enumeration; safe to call when there's only the main
// frame.
async function _runInAllFrames(tabId, payload) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: 'MAIN',
    func: _odMainWorld,
    args: [payload],
  });
  const merged = { count: 0, total_matches: 0, elements: [], frames: 0 };
  for (const r of results) {
    if (!r || !r.result || !r.result.ok) continue;
    const data = r.result.result || {};
    merged.frames++;
    merged.total_matches += data.total_matches || 0;
    if (Array.isArray(data.elements)) {
      for (const el of data.elements) {
        merged.elements.push({ ...el, frame_id: r.frameId });
      }
    }
  }
  merged.count = merged.elements.length;
  return merged;
}

async function evaluateJs(params) {
  // Legacy alias. The original implementation refused to run because
  // MV3 + content-script CSP forbid Function-from-string. The newer
  // `eval` op uses chrome.scripting.executeScript MAIN world which DOES
  // work, so route here. SPEC parity + round-4a review D1.
  const r = await pageEval({ script: params.script || params.code || "", tab_id: params.tab_id });
  // Preserve the legacy {success} envelope for any caller still
  // checking that field.
  return { success: !!r?.ok, ...r };
}

async function domQuery(params) {
  const tabId = await _resolveTabId(params.tab_id);
  if (!params.selector) throw new Error("dom_query: selector required");
  if (!params.action) throw new Error("dom_query: action required");
  const result = await _runInMain(tabId, {
    op: 'dom_query',
    selector: params.selector,
    action: params.action,
    value: params.value ?? null,
    nth: params.nth || 0,
  });
  return { success: true, ...result };
}

async function domQueryAll(params) {
  const tabId = await _resolveTabId(params.tab_id);
  const payload = {
    op: 'dom_query_all',
    selector: params.selector || 'button, [role=button], input, textarea, select, a[href]',
    limit: params.limit || 100,
    visibleOnly: params.visible_only !== false,
  };
  const result = params.all_frames
    ? await _runInAllFrames(tabId, payload)
    : await _runInMain(tabId, payload);
  return { success: true, ...result };
}

async function waitForSelector(params) {
  const tabId = await _resolveTabId(params.tab_id);
  if (!params.selector) throw new Error("wait_for_selector: selector required");
  const result = await _runInMain(tabId, {
    op: 'wait_for_selector',
    selector: params.selector,
    // Accept both `timeout_ms` (legacy) and `timeout` (SPEC) so the
    // bench fixtures keep working after round-4a review R1 dedup.
    timeoutMs: params.timeout_ms || params.timeout || 8000,
    requireVisible: params.visible !== false,
  });
  return { success: true, ...result };
}

async function dispatchKeys(params) {
  const tabId = await _resolveTabId(params.tab_id);
  if (!Array.isArray(params.keys) || params.keys.length === 0)
    throw new Error("dispatch_keys: keys array required");
  const result = await _runInMain(tabId, {
    op: 'dispatch_keys',
    selector: params.selector || null,
    keys: params.keys,
  });
  return { success: true, ...result };
}

async function captureScreenshot(params) {
  const tabId = params.tab_id ? await _resolveTabId(params.tab_id) : await _resolveTabId(null);
  const format = params.format === 'jpeg' ? 'jpeg' : 'png';
  const quality = format === 'jpeg' ? (params.quality || 90) : undefined;
  // Primary path: CDP Page.captureScreenshot — works on any tab the
  // extension can attach to, no activeTab gate.
  try {
    await _cdpAttach(tabId);
    const cdpOpts = { format };
    if (quality !== undefined) cdpOpts.quality = quality;
    const r = await _cdpSend(tabId, 'Page.captureScreenshot', cdpOpts);
    if (r && r.data)
      return { success: true, mime: format === 'jpeg' ? 'image/jpeg' : 'image/png', base64: r.data, length: r.data.length };
  } catch (e) {
    // Fall through to chrome.tabs.captureVisibleTab for the active-tab
    // case where the user explicitly invoked us through popup.
  }
  // Fallback: chrome.tabs.captureVisibleTab. Requires activeTab/permission.
  let windowId;
  try {
    const tab = await browser.tabs.get(tabId);
    windowId = tab.windowId;
  } catch {
    const [active] = await browser.tabs.query({ active: true, currentWindow: true });
    windowId = active && active.windowId;
  }
  const opts = quality !== undefined ? { format, quality } : { format };
  const dataUrl = await new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(windowId, opts, (url) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(url);
    });
  });
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!m) return { success: false, error: "captureVisibleTab returned unexpected data URL" };
  return { success: true, mime: m[1], base64: m[2], length: m[2].length };
}

// ============== CDP power tools (Everywhere fork) ==========================
// chrome.debugger.attach(target, '1.3') gives us Runtime / DOM / Input /
// Network / Page / Emulation. We attach lazily on first use, keep one
// attachment per tab, and auto-detach on tab close. Per-tab buffers
// accumulate Network and Console events for later retrieval.

const _cdpAttached = new Map(); // tabId -> { attachedAt, network: [], console: [], pendingResponses: Map }
const _cdpAttachLock = new Map();

async function _cdpAttach(tabId) {
  if (_cdpAttached.has(tabId)) return _cdpAttached.get(tabId);
  // Serialize attach per tab — concurrent CDP calls would each race attach.
  let lock = _cdpAttachLock.get(tabId);
  if (!lock) {
    lock = _doAttach(tabId);
    _cdpAttachLock.set(tabId, lock);
  }
  try { return await lock; }
  finally { _cdpAttachLock.delete(tabId); }
}

async function _doAttach(tabId) {
  let alreadyAttached = false;
  await new Promise((res, rej) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const e = chrome.runtime.lastError;
      if (!e) return res();
      if (/already attached/i.test(e.message || '')) {
        alreadyAttached = true; res(); return;
      }
      rej(new Error(e.message));
    });
  });
  // SW-restart fix: if a stale attachment from a previous SW lifetime
  // is still around, our in-memory state + onEvent listeners are gone
  // and the buffers below would silently never fill. Detach + reattach
  // so the listeners reattach to a fresh attachment we own.
  if (alreadyAttached) {
    try {
      await new Promise((res) => chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; res(); }));
      await new Promise((res, rej) => chrome.debugger.attach({ tabId }, '1.3', () => {
        const e = chrome.runtime.lastError;
        if (e) rej(new Error(e.message)); else res();
      }));
    } catch (e) {
      console.warn('OpenDia: stale CDP re-attach failed', e);
    }
  }
  const state = {
    attachedAt: Date.now(),
    network: [],
    console: [],
    pendingByReqId: new Map(),
  };
  _cdpAttached.set(tabId, state);
  try { await _cdpSend(tabId, 'Network.enable', {}); } catch (e) { console.warn('OpenDia CDP Network.enable failed', e); }
  try { await _cdpSend(tabId, 'Runtime.enable', {}); } catch (e) { console.warn('OpenDia CDP Runtime.enable failed', e); }
  try { await _cdpSend(tabId, 'Log.enable',     {}); } catch (e) { console.warn('OpenDia CDP Log.enable failed', e); }
  return state;
}

function _cdpSend(tabId, method, params = {}) {
  return new Promise((res, rej) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (r) => {
      const e = chrome.runtime.lastError;
      if (e) rej(new Error(`${method}: ${e.message}`));
      else res(r);
    });
  });
}

// Single global CDP event listener — routes events to per-tab buffers.
chrome.debugger.onEvent.addListener((source, method, params) => {
  const st = _cdpAttached.get(source.tabId);
  if (!st) return;

  if (method === 'Network.requestWillBeSent') {
    st.network.push({
      requestId: params.requestId,
      url: params.request?.url,
      method: params.request?.method,
      type: params.type,
      ts: Date.now(),
      status: null, // filled in by Network.responseReceived
      mime: null,
      size: null,
    });
    if (st.network.length > 5000) st.network.splice(0, st.network.length - 5000);
  } else if (method === 'Network.responseReceived') {
    const e = st.network.find(r => r.requestId === params.requestId);
    if (e) {
      e.status = params.response?.status;
      e.mime = params.response?.mimeType;
    }
  } else if (method === 'Network.loadingFinished') {
    const e = st.network.find(r => r.requestId === params.requestId);
    if (e) e.size = params.encodedDataLength;
  } else if (method === 'Runtime.consoleAPICalled') {
    st.console.push({
      level: params.type,
      text: (params.args || []).map(a => a.value !== undefined ? String(a.value)
        : (a.description || JSON.stringify(a.preview || {}))).join(' '),
      ts: Date.now(),
      url: params.stackTrace?.callFrames?.[0]?.url,
      line: params.stackTrace?.callFrames?.[0]?.lineNumber,
    });
    if (st.console.length > 2000) st.console.splice(0, st.console.length - 2000);
  } else if (method === 'Log.entryAdded') {
    st.console.push({
      level: params.entry?.level,
      text: params.entry?.text,
      ts: Date.now(),
      url: params.entry?.url,
      line: params.entry?.lineNumber,
      source: params.entry?.source,
    });
    if (st.console.length > 2000) st.console.splice(0, st.console.length - 2000);
  } else if (method === 'Fetch.requestPaused') {
    // SPEC ab network_route — fulfill or continue based on per-tab route table.
    const route = __routeState.get(source.tabId);
    if (!route) {
      _cdpSend(source.tabId, 'Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
      return;
    }
    const url = params.request?.url || '';
    const matches = route.pattern && (
      route.pattern === '*' ||
      url.includes(route.pattern.replace(/\*/g, '')) ||
      (function() { try { return new RegExp(route.pattern).test(url); } catch { return false; } })()
    );
    if (!matches) {
      _cdpSend(source.tabId, 'Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
      return;
    }
    const resp = route.response || {};
    const body = btoa(unescape(encodeURIComponent(resp.body || '')));
    const headers = Object.entries(resp.headers || { 'content-type': 'text/plain' })
      .map(([name, value]) => ({ name, value: String(value) }));
    _cdpSend(source.tabId, 'Fetch.fulfillRequest', {
      requestId: params.requestId,
      responseCode: resp.status || 200,
      responseHeaders: headers,
      body,
    }).catch(() => {});
  }
});

// On tab close, detach automatically.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (_cdpAttached.has(tabId)) {
    _cdpAttached.delete(tabId);
    // attempt detach (may already be gone)
    try { chrome.debugger.detach({ tabId }, () => void chrome.runtime.lastError); } catch {}
  }
});

async function cdpEvaluate(params) {
  const tabId = await _resolveTabId(params.tab_id);
  await _cdpAttach(tabId);
  const expr = params.expression;
  if (!expr || typeof expr !== 'string') throw new Error("cdp_evaluate: expression required");
  // Wrap in (async () => { ... })() so caller can write `return X` or just `X`.
  const wrapped = `(async () => { ${expr.includes('return ') ? expr : 'return (' + expr + ');'} })()`;
  const r = await _cdpSend(tabId, 'Runtime.evaluate', {
    expression: wrapped,
    awaitPromise: params.await_promise !== false,
    returnByValue: params.return_by_value !== false,
    timeout: Math.max(100, Math.min(60000, params.timeout_ms || 10000)),
    userGesture: true,
  });
  if (r.exceptionDetails) {
    return { success: false, error: r.exceptionDetails.text + (r.exceptionDetails.exception?.description ? ': ' + r.exceptionDetails.exception.description : '') };
  }
  return { success: true, result: r.result?.value !== undefined ? r.result.value : (r.result?.description ?? null) };
}

async function cdpInputMouse(params) {
  const tabId = await _resolveTabId(params.tab_id);
  await _cdpAttach(tabId);
  const { x, y } = params;
  if (typeof x !== 'number' || typeof y !== 'number') throw new Error("cdp_input_mouse: x and y required");
  const button = params.button || 'left';
  const click_count = params.click_count || 1;
  await _cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  for (let i = 0; i < click_count; i++) {
    await _cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: i+1 });
    await _cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: i+1 });
  }
  return { success: true, x, y, button, click_count };
}

const _CDP_KEY_MAP = {
  'Enter':   { code: 'Enter',    keyCode: 13, key: 'Enter' },
  'Return':  { code: 'Enter',    keyCode: 13, key: 'Enter' },
  'Tab':     { code: 'Tab',      keyCode: 9,  key: 'Tab' },
  'Escape':  { code: 'Escape',   keyCode: 27, key: 'Escape' },
  'Backspace':{code: 'Backspace',keyCode: 8,  key: 'Backspace' },
  'Delete':  { code: 'Delete',   keyCode: 46, key: 'Delete' },
  'ArrowUp': { code: 'ArrowUp',  keyCode: 38, key: 'ArrowUp' },
  'ArrowDown':{code: 'ArrowDown',keyCode: 40, key: 'ArrowDown' },
  'ArrowLeft':{code: 'ArrowLeft',keyCode: 37, key: 'ArrowLeft' },
  'ArrowRight':{code:'ArrowRight',keyCode:39, key: 'ArrowRight' },
  'Space':   { code: 'Space',    keyCode: 32, key: ' ' },
};
function _cdpModifiers(parts) {
  let m = 0;
  for (const p of parts) {
    const low = p.toLowerCase();
    if (low === 'alt' || low === 'option') m |= 1;
    else if (low === 'ctrl' || low === 'control') m |= 2;
    else if (low === 'meta' || low === 'cmd' || low === 'command') m |= 4;
    else if (low === 'shift') m |= 8;
  }
  return m;
}
async function cdpInputKeys(params) {
  const tabId = await _resolveTabId(params.tab_id);
  await _cdpAttach(tabId);
  const keys = params.keys;
  if (!Array.isArray(keys)) throw new Error("cdp_input_keys: keys array required");
  // Inner helper: emit a full keyDown + (char if printable) + keyUp triple
  // for one character. React onKeyDown / autocomplete dropdowns / IME
  // consumers all need keyDown to fire, so we never emit char alone.
  async function emitChar(ch, modifiers) {
    const code = ch.toUpperCase().charCodeAt(0);
    const isLetter = ch.length === 1 && /[a-zA-Z]/.test(ch);
    const codeStr = isLetter ? 'Key' + ch.toUpperCase()
                  : (ch.length === 1 ? 'Key' + ch.toUpperCase() : ch);
    await _cdpSend(tabId, 'Input.dispatchKeyEvent', { type:'keyDown', modifiers, key:ch, code:codeStr, keyCode:code });
    await _cdpSend(tabId, 'Input.dispatchKeyEvent', { type:'char',    modifiers, key:ch, text:ch, unmodifiedText:ch });
    await _cdpSend(tabId, 'Input.dispatchKeyEvent', { type:'keyUp',   modifiers, key:ch, code:codeStr, keyCode:code });
  }

  for (const spec of keys) {
    const parts = spec.split('+').map(s => s.trim());
    const last = parts.pop();
    const modifiers = _cdpModifiers(parts);
    const named = _CDP_KEY_MAP[last];
    if (named) {
      await _cdpSend(tabId, 'Input.dispatchKeyEvent', { type:'keyDown',  modifiers, ...named });
      await _cdpSend(tabId, 'Input.dispatchKeyEvent', { type:'keyUp',    modifiers, ...named });
    } else if (last.length === 1) {
      await emitChar(last, modifiers);
    } else {
      // Multi-character literal (e.g. "hello"): emit a full key triple per
      // character so onKeyDown handlers see each one. modifiers apply to
      // every character — usually parts is empty here so modifiers === 0.
      for (const ch of last) await emitChar(ch, modifiers);
    }
  }
  return { success: true, dispatched: keys };
}

async function cdpListNetworkRequests(params) {
  const tabId = await _resolveTabId(params.tab_id);
  await _cdpAttach(tabId);
  const st = _cdpAttached.get(tabId);
  let rows = st.network;
  if (params.since_ms) rows = rows.filter(r => r.ts >= params.since_ms);
  if (params.method_filter) rows = rows.filter(r => (r.method||'').includes(params.method_filter));
  if (params.url_filter) rows = rows.filter(r => (r.url||'').includes(params.url_filter));
  const limit = Math.max(1, Math.min(2000, params.limit || 200));
  if (rows.length > limit) rows = rows.slice(-limit);
  return { success: true, count: rows.length, total_buffered: st.network.length, requests: rows };
}

async function cdpGetResponseBody(params) {
  const tabId = await _resolveTabId(params.tab_id);
  await _cdpAttach(tabId);
  if (!params.request_id) throw new Error("cdp_get_response_body: request_id required");
  const r = await _cdpSend(tabId, 'Network.getResponseBody', { requestId: params.request_id });
  return { success: true, body: r.body, base64: !!r.base64Encoded };
}

async function cdpListConsoleMessages(params) {
  const tabId = await _resolveTabId(params.tab_id);
  await _cdpAttach(tabId);
  const st = _cdpAttached.get(tabId);
  let rows = st.console;
  if (params.level_filter) rows = rows.filter(r => (r.level||'') === params.level_filter);
  const limit = Math.max(1, Math.min(2000, params.limit || 200));
  if (rows.length > limit) rows = rows.slice(-limit);
  return { success: true, count: rows.length, total_buffered: st.console.length, messages: rows };
}

async function cdpUploadFile(params) {
  const tabId = await _resolveTabId(params.tab_id);
  await _cdpAttach(tabId);
  if (!params.selector) throw new Error("cdp_upload_file: selector required");
  if (!Array.isArray(params.file_paths) || params.file_paths.length === 0)
    throw new Error("cdp_upload_file: file_paths required");
  // depth:0 only sends the document node back — DOM.querySelector only
  // needs root.nodeId, full-tree pierce here would copy megabytes per call.
  const doc = await _cdpSend(tabId, 'DOM.getDocument', { depth: 0 });
  const found = await _cdpSend(tabId, 'DOM.querySelector', { nodeId: doc.root.nodeId, selector: params.selector });
  if (!found.nodeId) throw new Error("cdp_upload_file: element not found");
  await _cdpSend(tabId, 'DOM.setFileInputFiles', { nodeId: found.nodeId, files: params.file_paths });
  return { success: true, files: params.file_paths };
}

async function waitForDownload(params) {
  const timeoutMs = Math.max(500, Math.min(120000, params.timeout_ms || 30000));
  // Floor on the call moment, not 1s before — otherwise a previously
  // completed download in the chrome.downloads search results gets
  // mistaken for the one we are waiting for and the tool returns
  // "success" without ever waiting. Callers who want a window into the
  // recent past must pass since_ms explicitly.
  const sinceMs = params.since_ms || Date.now();
  const start = Date.now();
  // First check existing recent downloads.
  while (Date.now() - start < timeoutMs) {
    const items = await new Promise(res => chrome.downloads.search({ orderBy: ['-startTime'], limit: 20 }, res));
    const fresh = items.find(d => new Date(d.startTime).getTime() >= sinceMs && (d.state === 'complete' || d.state === 'in_progress'));
    if (fresh && fresh.state === 'complete') {
      return { success: true, id: fresh.id, filename: fresh.filename, url: fresh.url, mime: fresh.mime, bytes: fresh.fileSize, state: fresh.state };
    }
    await new Promise(r => setTimeout(r, 600));
  }
  return { success: false, error: "wait_for_download: timeout" };
}

async function getCookies(params) {
  const filter = {};
  if (params.url) filter.url = params.url;
  if (params.domain) filter.domain = params.domain;
  if (params.name) filter.name = params.name;
  const cookies = await new Promise(res => chrome.cookies.getAll(filter, res));
  return { success: true, count: cookies.length, cookies };
}

async function setCookie(params) {
  if (!params.url || !params.name) throw new Error("set_cookie: url + name required");
  const expirationDate = params.expires_seconds
    ? Math.floor(Date.now()/1000) + params.expires_seconds
    : undefined;
  const cookie = await new Promise((res, rej) => {
    chrome.cookies.set({
      url: params.url,
      name: params.name,
      value: params.value || '',
      domain: params.domain,
      path: params.path || '/',
      secure: params.secure,
      httpOnly: params.http_only,
      expirationDate,
    }, (c) => {
      const e = chrome.runtime.lastError;
      if (e) rej(new Error(e.message)); else res(c);
    });
  });
  return { success: !!cookie, cookie };
}

async function clearCookies(params) {
  if (!params.url) throw new Error("clear_cookies: url required");
  const withTimeout = (p, ms, label) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' timeout')), ms))
  ]);
  if (params.name) {
    try {
      const r = await withTimeout(
        new Promise(res => chrome.cookies.remove({ url: params.url, name: params.name }, res)),
        4000, 'cookies.remove');
      return { success: !!r, removed: r };
    } catch (e) {
      return { success: false, error: String(e?.message || e) };
    }
  }
  // Remove all cookies for this URL.
  let all;
  try {
    all = await withTimeout(
      new Promise(res => chrome.cookies.getAll({ url: params.url }, res)),
      4000, 'cookies.getAll');
  } catch (e) {
    return { success: false, error: String(e?.message || e) };
  }
  const removed = [];
  for (const c of all) {
    try {
      await withTimeout(
        new Promise(res => chrome.cookies.remove({ url: params.url, name: c.name }, () => res())),
        2000, 'cookies.remove');
      removed.push(c.name);
    } catch { /* skip stuck ones */ }
  }
  return { success: true, removed };
}

async function openIncognitoTab(params) {
  const url = params.url || 'about:blank';
  const win = await new Promise(res => chrome.windows.create({ incognito: true, url }, res));
  const tab = win && win.tabs && win.tabs[0];
  return { success: true, window_id: win?.id, tab_id: tab?.id, url: tab?.url };
}

async function emulateDevice(params) {
  const tabId = await _resolveTabId(params.tab_id);
  await _cdpAttach(tabId);
  if (params.clear) {
    try { await _cdpSend(tabId, 'Emulation.clearDeviceMetricsOverride', {}); } catch {}
    try { await _cdpSend(tabId, 'Emulation.setUserAgentOverride', { userAgent: '' }); } catch {}
    return { success: true, cleared: true };
  }
  if (params.width && params.height) {
    await _cdpSend(tabId, 'Emulation.setDeviceMetricsOverride', {
      width: params.width, height: params.height,
      deviceScaleFactor: params.device_scale_factor || 2,
      mobile: params.mobile !== false,
    });
  }
  if (params.user_agent) {
    await _cdpSend(tabId, 'Emulation.setUserAgentOverride', { userAgent: params.user_agent });
  }
  return { success: true };
}

// =================== OBU parity handlers ============================
// Clipboard goes through CDP Runtime.evaluate of navigator.clipboard.*
// because chrome.scripting.executeScript runs in the page world but
// navigator.clipboard requires user-activation; CDP Runtime.evaluate
// with userGesture:true bypasses the activation gate.

async function clipboardReadText(params) {
  const tabId = await _resolveTabId(params.tab_id);
  // Activate target tab — clipboard API requires a focused page.
  try { await browser.tabs.update(tabId, { active: true }); } catch {}
  await _cdpAttach(tabId);
  // Race the page readText() with our own 4s deadline so we never
  // exceed the bridge's 30s tool timeout. clipboard.readText() can
  // hang indefinitely if the doc is permission-blocked.
  const r = await _cdpSend(tabId, 'Runtime.evaluate', {
    expression: `Promise.race([
      navigator.clipboard.readText(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('clipboard.readText timeout')), 4000))
    ])`,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
    timeout: 5000,
  });
  if (r.exceptionDetails)
    return { success: false, error: r.exceptionDetails.text };
  return { success: true, text: r.result?.value ?? "" };
}

async function clipboardWriteText(params) {
  const tabId = await _resolveTabId(params.tab_id);
  await _cdpAttach(tabId);
  if (typeof params.text !== 'string') throw new Error("clipboard_write_text: text required");
  const expr = `navigator.clipboard.writeText(${JSON.stringify(params.text)}).then(()=>true)`;
  const r = await _cdpSend(tabId, 'Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
    timeout: 5000,
  });
  if (r.exceptionDetails)
    return { success: false, error: r.exceptionDetails.text };
  return { success: true };
}

async function clipboardRead(params) {
  const tabId = await _resolveTabId(params.tab_id);
  await _cdpAttach(tabId);
  // Iterate ClipboardItems and convert each blob to base64.
  const expr = `(async () => {
    const out = [];
    const items = await navigator.clipboard.read();
    for (const item of items) {
      for (const type of item.types) {
        const blob = await item.getType(type);
        const buf = new Uint8Array(await blob.arrayBuffer());
        let bin = ''; for (const b of buf) bin += String.fromCharCode(b);
        out.push({ type, data_base64: btoa(bin) });
      }
    }
    return out;
  })()`;
  const r = await _cdpSend(tabId, 'Runtime.evaluate', {
    expression: expr, awaitPromise: true, returnByValue: true, userGesture: true, timeout: 8000,
  });
  if (r.exceptionDetails)
    return { success: false, error: r.exceptionDetails.text };
  return { success: true, items: r.result?.value ?? [] };
}

async function clipboardWrite(params) {
  const tabId = await _resolveTabId(params.tab_id);
  await _cdpAttach(tabId);
  if (!Array.isArray(params.items) || params.items.length === 0)
    throw new Error("clipboard_write: items required");
  const itemsLiteral = JSON.stringify(params.items);
  const expr = `(async () => {
    const items = ${itemsLiteral};
    const clipItems = items.map(it => {
      const bin = atob(it.data_base64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      return new ClipboardItem({ [it.type]: new Blob([buf], { type: it.type }) });
    });
    await navigator.clipboard.write(clipItems);
    return true;
  })()`;
  const r = await _cdpSend(tabId, 'Runtime.evaluate', {
    expression: expr, awaitPromise: true, returnByValue: true, userGesture: true, timeout: 8000,
  });
  if (r.exceptionDetails)
    return { success: false, error: r.exceptionDetails.text };
  return { success: true };
}

// ----- Session management -------------------------------------------
// Persist {sessionId -> [tabIds]} in chrome.storage.local under
// "od.sessions". finalize_tabs reads + acts.
const _SESSION_STORE_KEY = "od.sessions";
async function _readSessions() {
  try {
    const r = await browser.storage.local.get(_SESSION_STORE_KEY);
    return r?.[_SESSION_STORE_KEY] ?? {};
  } catch { return {}; }
}
async function _writeSessions(sessions) {
  try { await browser.storage.local.set({ [_SESSION_STORE_KEY]: sessions }); } catch {}
}

async function claimTab(params) {
  if (!params.session_id) throw new Error("claim_tab: session_id required");
  const tabId = await _resolveTabId(params.tab_id);
  const sessions = await _readSessions();
  const list = sessions[params.session_id] ?? [];
  if (!list.includes(tabId)) list.push(tabId);
  sessions[params.session_id] = list;
  await _writeSessions(sessions);
  return { success: true, session_id: params.session_id, tab_id: tabId, claimed: list.length };
}

async function finalizeTabs(params) {
  if (!params.session_id) throw new Error("finalize_tabs: session_id required");
  const sessions = await _readSessions();
  const claimed = sessions[params.session_id] ?? [];
  const keep = Array.isArray(params.keep) ? params.keep : [];
  const keepIds = new Set(keep.map(k => k.tab_id));
  const closed = [];
  const kept = [];
  for (const tid of claimed) {
    if (keepIds.has(tid)) {
      const status = (keep.find(k => k.tab_id === tid)?.status) || "kept";
      kept.push({ tab_id: tid, status });
    } else {
      try { await browser.tabs.remove(tid); closed.push(tid); } catch {}
    }
  }
  // Drop the session record.
  delete sessions[params.session_id];
  await _writeSessions(sessions);
  return { success: true, session_id: params.session_id, closed, kept };
}

async function nameSession(params) {
  if (!params.session_id || !params.name) throw new Error("name_session: session_id + name required");
  // chrome.tabGroups requires the "tabGroups" permission; without it,
  // gracefully no-op.
  if (!chrome.tabGroups || !chrome.tabs.group) {
    return { success: true, named: false, reason: "tabGroups API unavailable" };
  }
  const sessions = await _readSessions();
  const tabs = (sessions[params.session_id] ?? []).filter(Boolean);
  if (tabs.length === 0) return { success: true, named: false, reason: "no claimed tabs" };
  // Group + rename. Errors here are non-fatal — we still return success.
  // Hard timeout: chrome.tabs.group can hang on non-groupable tabs
  // (incognito tabs, tabs already in another window, sleeping tabs).
  try {
    const groupId = await Promise.race([
      chrome.tabs.group({ tabIds: tabs }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('tabs.group timeout')), 3000))
    ]);
    await Promise.race([
      chrome.tabGroups.update(groupId, { title: params.name }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('tabGroups.update timeout')), 2000))
    ]);
    return { success: true, named: true, group_id: groupId, tab_count: tabs.length };
  } catch (e) {
    return { success: true, named: false, reason: String(e?.message || e) };
  }
}

// ----- Visual-only cursor move (no real input) ----------------------
// The Everywhere host renders a software cursor when CursorOverlayEnabled
// is on. We surface an MCP tool here for protocol parity with OBU's
// moveMouse, but the actual rendering happens out-of-process. The
// simplest cross-stack signal is a small JSON payload printed by the
// ext that the host can pick up via console capture; concretely we just
// log the intent (host-side TracedInputSimulator already drives the
// overlay for any *real* CGEvent input, so move_mouse is a no-op when
// the host is the one initiating moves).

async function moveMouse(params) {
  if (typeof params.x !== 'number' || typeof params.y !== 'number')
    throw new Error("move_mouse: x and y required");
  // Just acknowledge the intent. There's no Chrome API to move the
  // OS cursor without dispatching events; truly visual cursors are
  // platform-host concerns (Everywhere has SoftwareCursorOverlay
  // wired to its IInputSimulator decorator).
  return {
    success: true,
    x: params.x, y: params.y,
    note: "move_mouse is acknowledged at the bridge level; visual cursor rendering is host-side (Everywhere SoftwareCursorOverlay).",
  };
}

async function sendToContentScript(action, data, targetTabId = null) {
  let targetTab;
  
  if (targetTabId) {
    // Use specific tab
    try {
      targetTab = await browser.tabs.get(targetTabId);
    } catch (error) {
      throw new Error(`Tab ${targetTabId} not found or inaccessible`);
    }
  } else {
    // Fallback to active tab (maintains compatibility)
    const [activeTab] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    
    if (!activeTab) {
      throw new Error('No active tab found');
    }
    targetTab = activeTab;
  }
  
  // Ensure content script is available in the target tab
  await ensureContentScriptReady(targetTab.id);
  
  return new Promise((resolve, reject) => {
    browser.tabs.sendMessage(targetTab.id, { action, data }, (response) => {
      if (browser.runtime.lastError) {
        reject(new Error(`Tab ${targetTab.id}: ${browser.runtime.lastError.message}`));
      } else if (response && response.success) {
        resolve(response.data);
      } else {
        reject(new Error(`Tab ${targetTab.id}: ${response?.error || 'Unknown error'}`));
      }
    });
  });
}

async function navigateToUrl(url, waitFor, timeout = 10000) {
  const [activeTab] = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });
  
  await browser.tabs.update(activeTab.id, { url });
  
  // If waitFor is specified, wait for the element to appear
  if (waitFor) {
    try {
      await waitForElement(activeTab.id, waitFor, timeout);
    } catch (error) {
      return { success: true, tabId: activeTab.id, warning: `Navigation completed but wait condition failed: ${error.message}` };
    }
  }
  
  return { success: true, tabId: activeTab.id, url: url };
}

async function waitForElement(tabId, selector, timeout = 5000) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    try {
      const result = await browser.tabs.sendMessage(tabId, {
        action: 'wait_for',
        data: { 
          condition_type: 'element_visible', 
          selector: selector,
          timeout: 1000
        }
      });
      
      if (result.success) {
        return true;
      }
    } catch (error) {
      // Content script might not be ready yet, continue waiting
    }
    
    // Wait 500ms before next check
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  throw new Error(`Timeout waiting for element: ${selector}`);
}

// SPEC: ab back/forward/reload — thin wrappers over chrome.tabs.* with
// active-tab fallback. Throws on missing tab so the WS caller sees a
// clean error envelope instead of a silent no-op.
async function tabHistoryNavigate(direction, tabId) {
  const resolved = tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!resolved) throw new Error(`${direction}: no active tab`);
  if (direction === "back") {
    await chrome.tabs.goBack(resolved);
  } else {
    await chrome.tabs.goForward(resolved);
  }
  return { ok: true, direction, tab_id: resolved };
}

async function tabGetField(tabId, field) {
  const resolved = tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!resolved) throw new Error(field + ": no active tab");
  const tab = await chrome.tabs.get(resolved);
  return { ok: true, tab_id: resolved, [field]: tab[field] || "" };
}

// SPEC ab agent_browser_wait_for_url — poll chrome.tabs.get until URL
// matches. Background-side because the URL changes during navigation
// would invalidate any content-script poll.
async function waitForTabUrl(params) {
  const id = params.tab_id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!id) throw new Error("wait_for_url: no active tab");
  const target = String(params.url || "");
  const isRegex = !!params.regex;
  const re = isRegex ? new RegExp(target) : null;
  const timeout = params.timeout || 10000;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const tab = await chrome.tabs.get(id);
    const u = tab.url || "";
    if ((isRegex && re.test(u)) || (!isRegex && u.includes(target))) {
      return { ok: true, url: u, waited_ms: Date.now() - start };
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("wait_for_url: \"" + target + "\" did not match within " + timeout + "ms");
}

async function waitForTabLoad(params) {
  const id = params.tab_id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!id) throw new Error("wait_for_load: no active tab");
  const timeout = params.timeout || 10000;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const tab = await chrome.tabs.get(id);
    if (tab.status === "complete") {
      return { ok: true, status: "complete", waited_ms: Date.now() - start };
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("wait_for_load: did not reach complete within " + timeout + "ms");
}

// SPEC ab cookies_* — chrome.cookies API.
// (waitForDownload defined above ~L3230 with the richer pre-existing
// {timeout_ms, since_ms} schema; the duplicate SPEC variant was removed
// per round-4a review R2.)

// SPEC ab set_offline — CDP Network override.
async function cdpSetOffline(params) {
  const id = params.tab_id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!id) throw new Error("set_offline: no active tab");
  await _cdpSend(id, "Network.enable", {});
  await _cdpSend(id, "Network.emulateNetworkConditions", {
    offline: !!params.offline,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  return { ok: true, offline: !!params.offline, tab_id: id };
}

async function cdpProfilerStart(params) {
  const id = params.tab_id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!id) throw new Error("profiler_start: no active tab");
  await _cdpSend(id, "Profiler.enable", {});
  await _cdpSend(id, "Profiler.start", {});
  return { ok: true, tab_id: id };
}

async function cdpProfilerStop(params) {
  const id = params.tab_id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!id) throw new Error("profiler_stop: no active tab");
  const r = await _cdpSend(id, "Profiler.stop", {});
  return { ok: true, tab_id: id, profile: r?.profile || null };
}

async function cdpTraceStart(params) {
  const id = params.tab_id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!id) throw new Error("trace_start: no active tab");
  await _cdpSend(id, "Tracing.start", {
    categories: (params.categories || ["devtools.timeline"]).join(","),
    options: "record-until-full",
  });
  return { ok: true, tab_id: id };
}

async function cdpTraceStop(params) {
  const id = params.tab_id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!id) throw new Error("trace_stop: no active tab");
  await _cdpSend(id, "Tracing.end", {});
  return { ok: true, tab_id: id, note: "Tracing.end fired; events stream is consumed externally" };
}

// SPEC ab pdf — CDP Page.printToPDF; returns base64.
async function capturePdf(params) {
  const id = params.tab_id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!id) throw new Error("pdf: no active tab");
  const r = await _cdpSend(id, "Page.printToPDF", {});
  return { ok: true, tab_id: id, base64: r?.data || "", bytes: (r?.data || "").length };
}

// SPEC ab network_requests — buffered request log.
const __netBuffer = new Map(); // tabId → array of {url, method, type, ts}
function ensureNetListener() {
  if (globalThis.__openDiaNetListener) return;
  chrome.webRequest.onBeforeRequest.addListener((details) => {
    const buf = __netBuffer.get(details.tabId) || [];
    buf.push({ url: details.url, method: details.method, type: details.type, ts: details.timeStamp });
    if (buf.length > 200) buf.shift();
    __netBuffer.set(details.tabId, buf);
  }, { urls: ["<all_urls>"] });
  globalThis.__openDiaNetListener = true;
}
async function flushNetworkBuffer(params) {
  ensureNetListener();
  const id = params.tab_id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!id) throw new Error("network_requests: no active tab");
  const buf = __netBuffer.get(id) || [];
  const out = buf.slice();
  if (params.flush !== false) __netBuffer.set(id, []);
  return { ok: true, tab_id: id, requests: out, count: out.length };
}

// SPEC ab diff_url — track the URL across calls.
const __urlState = new Map();
async function diffUrl(params) {
  const id = params.tab_id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!id) throw new Error("diff_url: no active tab");
  const tab = await chrome.tabs.get(id);
  const prev = __urlState.get(id) ?? null;
  __urlState.set(id, tab.url || "");
  return { ok: true, prev, current: tab.url || "", changed: prev !== null && prev !== tab.url };
}

// SPEC ab diff_screenshot — capture viewport, byte-diff against last
// stored screenshot for the tab. byte-equal is enough for "did anything
// change" sanity; pixel-perfect diff would require canvas in MV3 SW.
const __shotState = new Map();
async function diffScreenshot(params) {
  const out = await captureScreenshot(params);
  const dataUrl = out?.data_url || out?.image || "";
  const id = params.tab_id ?? "active";
  const prev = __shotState.get(id) ?? null;
  __shotState.set(id, dataUrl);
  return {
    ok: true,
    equal: prev !== null && prev === dataUrl,
    bytes_now: dataUrl.length,
    bytes_prev: prev ? prev.length : 0,
  };
}

// SPEC ab frame_switch — list frames in tab; pick by URL substring or id.
async function frameSwitch(params) {
  const id = params.tab_id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!id) throw new Error("frame_switch: no active tab");
  const frames = await new Promise((resolve, reject) =>
    chrome.webNavigation.getAllFrames({ tabId: id }, (f) => f ? resolve(f) : reject(new Error("frame_switch: getAllFrames failed"))));
  let target = null;
  if (params.frame_id !== undefined) {
    target = frames.find((f) => f.frameId === params.frame_id) || null;
  } else if (params.match) {
    target = frames.find((f) => (f.url || "").includes(params.match)) || null;
  } else {
    target = frames.find((f) => f.parentFrameId === -1) || null;
  }
  if (!target) {
    return { ok: false, error: "frame_switch: no frame matched", frames: frames.map((f) => ({ id: f.frameId, url: f.url, parent: f.parentFrameId })) };
  }
  return { ok: true, tab_id: id, frame: { id: target.frameId, url: target.url, parent: target.parentFrameId },
           note: "WS pipe still targets the top frame; subsequent content-script ops run there. CDP-level frame routing is a future PR." };
}

// SPEC ab add_init_script / remove_init_script — CDP Page.addScript...
async function addInitScript(params) {
  const id = params.tab_id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!id) throw new Error("add_init_script: no active tab");
  await _cdpSend(id, "Page.enable", {});
  const r = await _cdpSend(id, "Page.addScriptToEvaluateOnNewDocument", { source: params.script || "" });
  return { ok: true, tab_id: id, id: r?.identifier || null };
}
async function removeInitScript(params) {
  const id = params.tab_id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!id) throw new Error("remove_init_script: no active tab");
  if (!params.id) throw new Error("remove_init_script: id required");
  await _cdpSend(id, "Page.removeScriptToEvaluateOnNewDocument", { identifier: params.id });
  return { ok: true, tab_id: id, id: params.id };
}

// SPEC ab cookies_set — DANGEROUS_TOOLS, user-approved. chrome.cookies.set.
async function cookiesSet(params) {
  const opts = { name: params.name, value: String(params.value ?? "") };
  if (params.url) opts.url = params.url;
  else if (params.domain) opts.domain = params.domain;
  else opts.url = await activeTabUrl();
  for (const k of ["path", "expirationDate", "secure", "httpOnly", "sameSite"]) {
    if (params[k] !== undefined) opts[k] = params[k];
  }
  const cookie = await chrome.cookies.set(opts);
  return { ok: true, cookie };
}

// SPEC ab cookies_set_curl — parse one Set-Cookie:-like header.
async function cookiesSetCurl(params) {
  const url = params.url || (await activeTabUrl());
  const header = String(params.header || "").replace(/^Set-Cookie:\s*/i, "");
  const parts = header.split(";").map((s) => s.trim()).filter(Boolean);
  const [first, ...rest] = parts;
  const eq = first.indexOf("=");
  if (eq === -1) throw new Error("cookies_set_curl: malformed header");
  const opts = { url, name: first.slice(0, eq), value: first.slice(eq + 1) };
  for (const seg of rest) {
    const [k, v] = seg.includes("=") ? seg.split("=", 2) : [seg, ""];
    const lk = k.toLowerCase();
    if (lk === "path") opts.path = v;
    else if (lk === "domain") opts.domain = v;
    else if (lk === "secure") opts.secure = true;
    else if (lk === "httponly") opts.httpOnly = true;
    else if (lk === "samesite") opts.sameSite = v.toLowerCase();
    else if (lk === "expires") opts.expirationDate = Math.floor(Date.parse(v) / 1000);
    else if (lk === "max-age") opts.expirationDate = Math.floor(Date.now() / 1000) + parseInt(v, 10);
  }
  const cookie = await chrome.cookies.set(opts);
  return { ok: true, cookie };
}

// SPEC ab set_headers / set_credentials — CDP Network override.
async function cdpSetHeaders(params) {
  const id = params.tab_id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!id) throw new Error("set_headers: no active tab");
  await _cdpSend(id, "Network.enable", {});
  await _cdpSend(id, "Network.setExtraHTTPHeaders", { headers: params.headers || {} });
  return { ok: true, tab_id: id, count: Object.keys(params.headers || {}).length };
}

async function cdpSetCredentials(params) {
  const id = params.tab_id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!id) throw new Error("set_credentials: no active tab");
  if (typeof params.username !== "string" || typeof params.password !== "string") {
    throw new Error("set_credentials: username and password required (non-null strings)");
  }
  if (params.username.includes(":")) {
    throw new Error("set_credentials: username may not contain ':' (Basic auth separator)");
  }
  const auth = "Basic " + btoa(params.username + ":" + params.password);
  await _cdpSend(id, "Network.enable", {});
  await _cdpSend(id, "Network.setExtraHTTPHeaders", { headers: { Authorization: auth } });
  return { ok: true, tab_id: id, username: params.username };
}

// SPEC ab network_request — DANGEROUS unrestricted fetch.
async function backgroundFetch(params) {
  const r = await fetch(params.url, {
    method: params.method || "GET",
    headers: params.headers || {},
    body: params.body,
    credentials: params.credentials || "include",
  });
  const text = await r.text();
  const headers = {};
  for (const [k, v] of r.headers.entries()) headers[k] = v;
  return { ok: true, status: r.status, headers, body: text, bytes: text.length };
}

// SPEC ab network_route / network_unroute — CDP Fetch.* interceptor.
const __routeState = new Map();
async function cdpRouteInstall(params) {
  const id = params.tab_id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!id) throw new Error("network_route: no active tab");
  if (typeof params.pattern !== "string" || params.pattern.length > 1024) {
    throw new Error("network_route: pattern required (string ≤ 1024 chars)");
  }
  const respBytes = ((params.response && params.response.body) || "").length;
  if (respBytes > 1024 * 1024) {
    throw new Error("network_route: response.body capped at 1 MiB to bound service-worker memory");
  }
  await _cdpSend(id, "Fetch.enable", {
    patterns: [{ urlPattern: params.pattern, requestStage: "Request" }],
  });
  __routeState.set(id, params);
  return { ok: true, tab_id: id, pattern: params.pattern };
}
async function cdpRouteClear(params) {
  const id = params.tab_id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!id) throw new Error("network_unroute: no active tab");
  await _cdpSend(id, "Fetch.disable", {});
  __routeState.delete(id);
  return { ok: true, tab_id: id };
}

// SPEC ab auth_* — chrome.storage.local credential vault.
async function authSave(params) {
  const key = "auth/" + params.name;
  await chrome.storage.local.set({ [key]: { kind: params.kind, payload: params.payload, savedAt: Date.now() } });
  return { ok: true, name: params.name };
}
async function authShow(params) {
  const key = "auth/" + params.name;
  const r = await chrome.storage.local.get(key);
  if (!r[key]) throw new Error("auth_show: \"" + params.name + "\" not found");
  return { ok: true, name: params.name, ...r[key] };
}
async function authList() {
  const r = await chrome.storage.local.get(null);
  return { ok: true, names: Object.keys(r).filter((k) => k.startsWith("auth/")).map((k) => k.slice(5)) };
}
async function authDelete(params) {
  const key = "auth/" + params.name;
  await chrome.storage.local.remove(key);
  return { ok: true, name: params.name };
}
async function authLogin(params) {
  const bundle = await authShow(params);
  // Apply bundle.payload to the active tab. payload shape:
  //   { cookies: [chrome.cookies.set args], headers: {…} }
  const id = params.tab_id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!id) throw new Error("auth_login: no active tab");
  if (Array.isArray(bundle.payload?.cookies)) {
    for (const c of bundle.payload.cookies) await chrome.cookies.set(c);
  }
  if (bundle.payload?.headers) {
    await _cdpSend(id, "Network.enable", {});
    await _cdpSend(id, "Network.setExtraHTTPHeaders", { headers: bundle.payload.headers });
  }
  return { ok: true, name: params.name, applied: { cookies: (bundle.payload?.cookies || []).length, headers: !!bundle.payload?.headers } };
}

// SPEC ab state_* — full session snapshot.
async function stateSave(params) {
  const url = await activeTabUrl(params.tab_id);
  const id = params.tab_id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  const cookies = await chrome.cookies.getAll({ url });
  const storage = await chrome.scripting.executeScript({
    target: { tabId: id },
    func: () => ({
      local: Object.fromEntries(Array.from({ length: localStorage.length }, (_, i) => [localStorage.key(i), localStorage.getItem(localStorage.key(i))])),
      session: Object.fromEntries(Array.from({ length: sessionStorage.length }, (_, i) => [sessionStorage.key(i), sessionStorage.getItem(sessionStorage.key(i))])),
    }),
  });
  const key = "state/" + params.name;
  await chrome.storage.local.set({ [key]: { url, cookies, storage: storage[0]?.result || { local: {}, session: {} }, savedAt: Date.now() } });
  return { ok: true, name: params.name, url, cookies: cookies.length };
}
async function stateShow(params) {
  const key = "state/" + params.name;
  const r = await chrome.storage.local.get(key);
  if (!r[key]) throw new Error("state_show: \"" + params.name + "\" not found");
  return { ok: true, name: params.name, ...r[key] };
}
async function stateList() {
  const r = await chrome.storage.local.get(null);
  return { ok: true, names: Object.keys(r).filter((k) => k.startsWith("state/")).map((k) => k.slice(6)) };
}
async function stateLoad(params) {
  const bundle = await stateShow(params);
  const id = params.tab_id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!id) throw new Error("state_load: no active tab");
  for (const c of bundle.cookies || []) {
    // chrome.cookies.set rejects expirationDate in the past; clamp.
    const opts = { url: c.url || bundle.url, name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite };
    if (c.expirationDate && c.expirationDate > Date.now() / 1000) opts.expirationDate = c.expirationDate;
    try { await chrome.cookies.set(opts); } catch { /* skip cookies the browser refuses */ }
  }
  await chrome.scripting.executeScript({
    target: { tabId: id },
    func: (s) => {
      localStorage.clear(); sessionStorage.clear();
      for (const [k, v] of Object.entries(s.local || {})) localStorage.setItem(k, v);
      for (const [k, v] of Object.entries(s.session || {})) sessionStorage.setItem(k, v);
    },
    args: [bundle.storage || { local: {}, session: {} }],
  });
  return { ok: true, name: params.name, cookies: (bundle.cookies || []).length };
}
async function stateClear(params) {
  const key = "state/" + params.name;
  await chrome.storage.local.remove(key);
  return { ok: true, name: params.name };
}
async function stateClean() {
  const r = await chrome.storage.local.get(null);
  const keys = Object.keys(r).filter((k) => k.startsWith("state/"));
  if (keys.length) await chrome.storage.local.remove(keys);
  return { ok: true, removed: keys.length };
}
async function stateRename(params) {
  const fromKey = "state/" + params.from;
  const toKey = "state/" + params.to;
  const r = await chrome.storage.local.get(fromKey);
  if (!r[fromKey]) throw new Error("state_rename: \"" + params.from + "\" not found");
  await chrome.storage.local.set({ [toKey]: r[fromKey] });
  await chrome.storage.local.remove(fromKey);
  return { ok: true, from: params.from, to: params.to };
}

// SPEC ab eval — DANGEROUS. chrome.scripting.executeScript MAIN world.
async function pageEval(params) {
  const id = params.tab_id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!id) throw new Error("eval: no active tab");
  const r = await chrome.scripting.executeScript({
    target: { tabId: id },
    world: "MAIN",
    func: (src) => {
      try {
        // Wrap as an IIFE so multi-statement scripts work; the script
        // must `return` its result.
        // eslint-disable-next-line no-new-func
        return { ok: true, value: new Function("return (function(){ " + src + " })();")() };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
    args: [params.script],
  });
  return r[0]?.result || { ok: false, error: "no result" };
}

async function cookiesGet(params) {
  const url = params.url ?? await activeTabUrl(params.tab_id);
  const cookies = await chrome.cookies.getAll({ url });
  return { ok: true, url, cookies };
}

async function cookiesClear(params) {
  const url = params.url ?? await activeTabUrl(params.tab_id);
  const cookies = await chrome.cookies.getAll({ url });
  for (const c of cookies) {
    await chrome.cookies.remove({ url, name: c.name });
  }
  return { ok: true, url, cleared: cookies.length };
}

async function activeTabUrl(tabId) {
  const id = tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!id) throw new Error("no active tab");
  const tab = await chrome.tabs.get(id);
  return tab.url || "";
}

async function getCdpUrl(params) {
  const id = params.tab_id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!id) throw new Error("get_cdp_url: no active tab");
  // Chrome DevTools front-end URL — only useful when the user has
  // --remote-debugging-port set; otherwise this is best-effort.
  return { ok: true, tab_id: id, cdp_url: "devtools://devtools/bundled/inspector.html?ws=localhost:9222/devtools/page/" + id };
}

// SPEC ab dialog_accept / dialog_dismiss — pre-arm the next
// alert/confirm/prompt by injecting overrides into the page main world
// (through chrome.scripting.executeScript). One-shot; the override
// removes itself after the first dialog.
async function prearmDialog(tabId, action, promptText) {
  const id = tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!id) throw new Error("dialog_" + action + ": no active tab");
  await chrome.scripting.executeScript({
    target: { tabId: id },
    world: "MAIN",
    func: (a, t) => {
      const orig = { alert: window.alert, confirm: window.confirm, prompt: window.prompt };
      const restore = () => Object.assign(window, orig);
      window.alert = function () { restore(); };
      window.confirm = function () { restore(); return a === "accept"; };
      window.prompt = function () { restore(); return a === "accept" ? (t || "") : null; };
    },
    args: [action, promptText],
  });
  return { ok: true, action, tab_id: id };
}

// CDP-based emulation overrides — re-using the existing _cdpSend helper
// (search for it elsewhere in this file). Each override persists until
// the tab is closed or a same-domain CDP clear call is issued.
// SPEC ab agent_browser_device — small named-preset table.
function devicePreset(name, tab_id) {
  const presets = {
    iphone15:   { width: 393, height: 852, mobile: true,  deviceScaleFactor: 3 },
    pixel7:     { width: 412, height: 915, mobile: true,  deviceScaleFactor: 2.625 },
    ipad:       { width: 820, height: 1180, mobile: true, deviceScaleFactor: 2 },
    desktop1080:{ width: 1920, height: 1080, mobile: false, deviceScaleFactor: 1 },
  };
  const preset = presets[name];
  if (!preset) throw new Error("device: unknown preset \"" + name + "\"");
  return Object.assign({}, preset, { tab_id });
}

async function cdpSetViewport(params) {
  const id = params.tab_id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!id) throw new Error("set_viewport: no active tab");
  await _cdpSend(id, "Emulation.setDeviceMetricsOverride", {
    width: params.width,
    height: params.height,
    deviceScaleFactor: params.deviceScaleFactor || 1,
    mobile: !!params.mobile,
  });
  return { ok: true, tab_id: id, width: params.width, height: params.height };
}

async function cdpSetGeo(params) {
  const id = params.tab_id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!id) throw new Error("set_geo: no active tab");
  await _cdpSend(id, "Emulation.setGeolocationOverride", {
    latitude: params.latitude,
    longitude: params.longitude,
    accuracy: params.accuracy ?? 100,
  });
  return { ok: true, tab_id: id, latitude: params.latitude, longitude: params.longitude };
}

async function cdpSetMedia(params) {
  const id = params.tab_id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!id) throw new Error("set_media: no active tab");
  await _cdpSend(id, "Emulation.setEmulatedMedia", {
    type: params.type || "",
    features: params.features || [],
  });
  return { ok: true, tab_id: id };
}

async function tabReload(tabId, bypassCache) {
  const resolved = tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (!resolved) throw new Error("reload: no active tab");
  await chrome.tabs.reload(resolved, { bypassCache: !!bypassCache });
  return { ok: true, tab_id: resolved, bypass_cache: !!bypassCache };
}

// Enhanced Tab Management Functions with Batch Support
async function createTab(params) {
  const { 
    url, 
    urls, 
    count = 1, 
    active = true, 
    wait_for, 
    timeout = 10000,
    batch_settings = {}
  } = params;
  
  // Smart hint: If creating single tab but description suggests multiple, provide guidance
  if (count === 1 && !urls) {
    console.log(`💡 Single tab creation. For multiple identical tabs, use count parameter: {"url": "${url}", "count": N}`);
  }
  
  // Validate parameters
  const validation = validateTabCreateParams(params);
  if (!validation.valid) {
    throw new Error(validation.error);
  }
  
  console.log(`🎯 Tab creation request:`, { url, urls, count, batch_settings, hasBatchSettings: !!batch_settings });
  
  // Determine operation type
  if (urls && urls.length > 0) {
    // Batch creation with multiple URLs
    console.log(`🚀 Using batch mode with ${urls.length} URLs`);
    return await createTabsBatch(urls, active, wait_for, timeout, batch_settings);
  } else if (url && count > 1) {
    // Batch creation with same URL repeated
    console.log(`🔄 Using repeat mode: ${count} copies of ${url}`);
    const urlArray = Array(count).fill(url);
    return await createTabsBatch(urlArray, active, wait_for, timeout, batch_settings);
  } else {
    // Single tab creation (legacy behavior)
    console.log(`📱 Using single tab mode for: ${url || 'about:blank'}`);
    return await createSingleTab(url, active, wait_for, timeout);
  }
}

// Parameter validation
function validateTabCreateParams(params) {
  const { url, urls, count = 1 } = params;
  
  // Check for conflicting parameters
  if (url && urls) {
    return { valid: false, error: "Cannot specify both 'url' and 'urls' parameters" };
  }
  
  if (urls && count > 1) {
    return { valid: false, error: "Cannot use 'count' with 'urls' array" };
  }
  
  // Allow empty URL for about:blank tabs
  if (!url && !urls && count > 1) {
    return { valid: false, error: "Must specify 'url' when using 'count' parameter" };
  }
  
  // Validate URLs array
  if (urls) {
    if (!Array.isArray(urls) || urls.length === 0) {
      return { valid: false, error: "'urls' must be a non-empty array" };
    }
    
    if (urls.length > 100) {
      return { valid: false, error: "Maximum 100 URLs allowed in batch operation" };
    }
    
    // Validate each URL
    for (let i = 0; i < urls.length; i++) {
      if (typeof urls[i] !== 'string' || !urls[i].trim()) {
        return { valid: false, error: `Invalid URL at index ${i}: must be a non-empty string` };
      }
    }
  }
  
  // Validate count
  if (count < 1 || count > 50) {
    return { valid: false, error: "Count must be between 1 and 50" };
  }
  
  return { valid: true };
}

// Single tab creation (original behavior)
async function createSingleTab(url, active, wait_for, timeout) {
  const createProperties = { active };
  if (url) {
    createProperties.url = url;
  }
  
  console.log(`🔍 Creating single tab with properties:`, createProperties);
  const newTab = await browser.tabs.create(createProperties);
  console.log(`📝 Tab created:`, { id: newTab.id, url: newTab.url, pendingUrl: newTab.pendingUrl });
  
  // Wait a moment for the URL to load
  if (url) {
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Check if tab loaded correctly
    try {
      const updatedTab = await browser.tabs.get(newTab.id);
      console.log(`🔄 Tab after load check:`, { id: updatedTab.id, url: updatedTab.url, status: updatedTab.status });
      
      // If URL was provided and wait_for is specified, wait for the element
      if (wait_for) {
        try {
          await waitForElement(newTab.id, wait_for, timeout);
        } catch (error) {
          return {
            success: true,
            tab_id: newTab.id,
            url: updatedTab.url,
            actual_url: updatedTab.url,
            requested_url: url,
            warning: `Tab created but wait condition failed: ${error.message}`
          };
        }
      }
      
      return {
        success: true,
        tab_id: newTab.id,
        url: updatedTab.url || updatedTab.pendingUrl || url,
        actual_url: updatedTab.url || updatedTab.pendingUrl,
        requested_url: url,
        active: updatedTab.active,
        status: updatedTab.status,
        title: updatedTab.title || 'New Tab',
        note: updatedTab.url === 'about:blank' && updatedTab.pendingUrl ? 'Tab is still loading' : undefined
      };
    } catch (error) {
      console.error(`❌ Error checking tab status:`, error);
      return {
        success: true,
        tab_id: newTab.id,
        url: newTab.url || 'about:blank',
        actual_url: newTab.url,
        requested_url: url,
        active: newTab.active,
        title: newTab.title || 'New Tab',
        warning: `Tab created but status check failed: ${error.message}`
      };
    }
  }
  
  return {
    success: true,
    tab_id: newTab.id,
    url: newTab.url || 'about:blank',
    active: newTab.active,
    title: newTab.title || 'New Tab'
  };
}

// Batch tab creation with performance throttling
async function createTabsBatch(urls, active, wait_for, timeout, batch_settings = {}) {
  console.log('🔍 createTabsBatch called with:', { urls: urls.length, batch_settings });
  
  const {
    chunk_size = 5,
    delay_between_chunks = 1000,
    delay_between_tabs = 200
  } = batch_settings || {};
  
  const startTime = Date.now();
  const totalTabs = urls.length;
  const createdTabs = [];
  const errors = [];
  
  // Performance warnings
  const warnings = [];
  if (totalTabs > 20) {
    warnings.push(`Creating ${totalTabs} tabs may impact browser performance`);
  }
  if (totalTabs > 45) {
    warnings.push(`Large batch (${totalTabs} tabs) may hit Chrome's tab limits or cause memory issues`);
  }
  
  console.log(`🚀 Starting batch tab creation: ${totalTabs} tabs in chunks of ${chunk_size}`);
  
  // Process in chunks
  for (let chunkStart = 0; chunkStart < urls.length; chunkStart += chunk_size) {
    const chunkEnd = Math.min(chunkStart + chunk_size, urls.length);
    const chunk = urls.slice(chunkStart, chunkEnd);
    const chunkIndex = Math.floor(chunkStart / chunk_size) + 1;
    const totalChunks = Math.ceil(urls.length / chunk_size);
    
    // Reduced logging for better performance
    if (totalTabs > 10) {
      console.log(`📦 Chunk ${chunkIndex}/${totalChunks}`);
    }
    
    // Create tabs in current chunk with delays
    for (let i = 0; i < chunk.length; i++) {
      const url = chunk[i];
      const globalIndex = chunkStart + i;
      const isLastTab = globalIndex === totalTabs - 1;
      
      try {
        // Only activate the very last tab if active=true
        const shouldActivate = active && isLastTab;
        
        const tab = await browser.tabs.create({
          url: url,
          active: shouldActivate
        });
        
        // Wait a moment and check actual URL
        await new Promise(resolve => setTimeout(resolve, 300));
        const updatedTab = await browser.tabs.get(tab.id);
        
        createdTabs.push({
          tab_id: tab.id,
          url: updatedTab.url || url,
          requested_url: url,
          index: globalIndex,
          active: updatedTab.active,
          title: updatedTab.title || `Tab ${globalIndex + 1}`
        });
        
        // Only log for small batches to avoid context overflow
        if (totalTabs <= 5) {
          console.log(`✅ Created tab ${globalIndex + 1}/${totalTabs}: ${url} (ID: ${tab.id})`);
        }
        
        // Wait between individual tabs (except last in chunk)
        if (i < chunk.length - 1) {
          await new Promise(resolve => setTimeout(resolve, delay_between_tabs));
        }
        
      } catch (error) {
        console.error(`❌ Failed to create tab ${globalIndex + 1}: ${error.message}`);
        errors.push({
          index: globalIndex,
          url: url,
          error: error.message
        });
      }
    }
    
    // Wait between chunks (except after last chunk)
    if (chunkEnd < urls.length) {
      if (totalTabs <= 10) {
        console.log(`⏳ Waiting ${delay_between_chunks}ms before next chunk...`);
      }
      await new Promise(resolve => setTimeout(resolve, delay_between_chunks));
    }
  }
  
  const executionTime = Date.now() - startTime;
  const successCount = createdTabs.length;
  const errorCount = errors.length;
  
  console.log(`🏁 Batch creation complete: ${successCount}/${totalTabs} successful in ${executionTime}ms`);
  
  // Prepare result - simplified to avoid context overflow
  const result = {
    success: errorCount === 0,
    batch_operation: true,
    summary: {
      total_requested: totalTabs,
      successful: successCount,
      failed: errorCount,
      execution_time_ms: executionTime
    },
    // Only include full tab details for small batches
    created_tabs: totalTabs <= 10 ? createdTabs : createdTabs.map(tab => ({
      tab_id: tab.tab_id,
      url: tab.url
    }))
  };
  
  // Add warnings if any
  if (warnings.length > 0) {
    result.warnings = warnings;
  }
  
  // Add errors if any
  if (errors.length > 0) {
    result.errors = errors;
    result.partial_success = successCount > 0;
  }
  
  // Add active tab info
  const activeTabs = createdTabs.filter(tab => tab.active);
  if (activeTabs.length > 0) {
    result.active_tab = activeTabs[0];
  }
  
  return result;
}

// Utility function to generate URLs for testing/demo purposes
function generateTestUrls(baseUrl, count) {
  const urls = [];
  for (let i = 1; i <= count; i++) {
    urls.push(`${baseUrl}?tab=${i}`);
  }
  return urls;
}

// Batch operation helper functions
function estimateBatchTime(urlCount, batchSettings = {}) {
  const {
    chunk_size = 5,
    delay_between_chunks = 1000,
    delay_between_tabs = 200
  } = batchSettings || {};
  
  const totalChunks = Math.ceil(urlCount / chunk_size);
  const timePerChunk = (chunk_size - 1) * delay_between_tabs; // delays within chunk
  const timeForChunks = totalChunks * timePerChunk;
  const timeBetweenChunks = (totalChunks - 1) * delay_between_chunks;
  
  return timeForChunks + timeBetweenChunks; // in milliseconds
}

async function closeTabs(params) {
  const { tab_id, tab_ids } = params;
  
  let tabsToClose = [];
  
  if (tab_ids && Array.isArray(tab_ids)) {
    // Close multiple tabs
    tabsToClose = tab_ids;
  } else if (tab_id) {
    // Close specific tab
    tabsToClose = [tab_id];
  } else {
    // Close current tab
    const [activeTab] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (activeTab) {
      tabsToClose = [activeTab.id];
    }
  }
  
  if (tabsToClose.length === 0) {
    throw new Error('No tabs specified to close');
  }
  
  // Close tabs
  await browser.tabs.remove(tabsToClose);
  
  return {
    success: true,
    closed_tabs: tabsToClose,
    count: tabsToClose.length
  };
}

async function listTabs(params) {
  const { 
    current_window_only = true, 
    include_details = true,
    check_content_script = false 
  } = params;
  
  const queryOptions = {};
  if (current_window_only) {
    queryOptions.currentWindow = true;
  }
  
  const tabs = await browser.tabs.query(queryOptions);
  
  // Check content script status if requested
  const contentScriptStatuses = new Map();
  if (check_content_script) {
    const statusPromises = tabs.map(async (tab) => {
      try {
        const status = await getTabContentScriptStatus(tab.id);
        return [tab.id, status];
      } catch (error) {
        return [tab.id, { ready: false, reason: 'error', error: error.message }];
      }
    });
    
    const results = await Promise.all(statusPromises);
    results.forEach(([tabId, status]) => {
      contentScriptStatuses.set(tabId, status);
    });
  }
  
  const tabList = tabs.map(tab => {
    const basicInfo = {
      id: tab.id,
      url: tab.url,
      active: tab.active,
      title: tab.title
    };
    
    // Add content script status if checked
    if (check_content_script) {
      const scriptStatus = contentScriptStatuses.get(tab.id);
      basicInfo.content_script = {
        ready: scriptStatus?.ready || false,
        reason: scriptStatus?.reason || 'unknown',
        injectable: isInjectableUrl(tab.url)
      };
    }
    
    if (include_details) {
      return {
        ...basicInfo,
        index: tab.index,
        pinned: tab.pinned,
        status: tab.status,
        favIconUrl: tab.favIconUrl,
        windowId: tab.windowId,
        incognito: tab.incognito
      };
    }
    
    return basicInfo;
  });
  
  // Calculate summary statistics
  const summary = {
    total_tabs: tabList.length,
    active_tab: tabs.find(tab => tab.active)?.id || null
  };
  
  if (check_content_script) {
    const readyTabs = tabList.filter(tab => tab.content_script?.ready).length;
    const injectableTabs = tabList.filter(tab => tab.content_script?.injectable).length;
    
    summary.content_script_stats = {
      ready_count: readyTabs,
      injectable_count: injectableTabs,
      restricted_count: tabList.length - injectableTabs
    };
  }
  
  return {
    success: true,
    tabs: tabList,
    count: tabList.length,
    summary
  };
}

async function switchToTab(tabId) {
  // First, get tab info to ensure it exists
  const tab = await browser.tabs.get(tabId);
  
  if (!tab) {
    throw new Error(`Tab with ID ${tabId} not found`);
  }
  
  // Switch to the tab
  await browser.tabs.update(tabId, { active: true });
  
  // Also focus the window containing the tab
  await browser.windows.update(tab.windowId, { focused: true });
  
  return {
    success: true,
    tab_id: tabId,
    url: tab.url,
    title: tab.title,
    window_id: tab.windowId
  };
}

// Workspace and Reference Management Functions
async function getBookmarks(params) {
  const { query } = params;
  
  let bookmarks;
  if (query) {
    bookmarks = await browser.bookmarks.search(query);
  } else {
    bookmarks = await browser.bookmarks.getTree();
  }
  
  return {
    success: true,
    bookmarks,
    count: bookmarks.length
  };
}

async function addBookmark(params) {
  const { title, url, parentId } = params;
  
  const bookmark = await browser.bookmarks.create({
    title,
    url,
    parentId
  });
  
  return {
    success: true,
    bookmark
  };
}

// History Management Function
async function getHistory(params) {
  const {
    keywords = "",
    start_date,
    end_date,
    domains = [],
    min_visit_count = 1,
    max_results = 50,
    sort_by = "visit_time",
    sort_order = "desc"
  } = params;

  try {
    // Browser History API search configuration
    const searchQuery = {
      text: keywords,
      maxResults: Math.min(max_results * 3, 1000), // Over-fetch for filtering
    };

    // Add date range if specified
    if (start_date) {
      searchQuery.startTime = new Date(start_date).getTime();
    }
    if (end_date) {
      searchQuery.endTime = new Date(end_date).getTime();
    }

    // Execute history search
    const historyItems = await browser.history.search(searchQuery);
    
    // Apply advanced filters
    let filteredItems = historyItems.filter(item => {
      // Domain filter
      if (domains.length > 0) {
        try {
          const itemDomain = new URL(item.url).hostname;
          if (!domains.some(domain => itemDomain.includes(domain))) {
            return false;
          }
        } catch (e) {
          // Skip items with invalid URLs
          return false;
        }
      }
      
      // Visit count filter
      if (item.visitCount < min_visit_count) {
        return false;
      }
      
      return true;
    });

    // Sort results
    filteredItems.sort((a, b) => {
      let aVal, bVal;
      switch (sort_by) {
        case "visit_count":
          aVal = a.visitCount;
          bVal = b.visitCount;
          break;
        case "title":
          aVal = (a.title || "").toLowerCase();
          bVal = (b.title || "").toLowerCase();
          break;
        default: // visit_time
          aVal = a.lastVisitTime;
          bVal = b.lastVisitTime;
      }
      
      if (sort_order === "asc") {
        return aVal > bVal ? 1 : -1;
      } else {
        return aVal < bVal ? 1 : -1;
      }
    });

    // Limit results
    const results = filteredItems.slice(0, max_results);
    
    // Format response with comprehensive metadata
    return {
      success: true,
      history_items: results.map(item => {
        let domain;
        try {
          domain = new URL(item.url).hostname;
        } catch (e) {
          domain = "invalid-url";
        }
        
        return {
          id: item.id,
          url: item.url,
          title: item.title || "Untitled",
          last_visit_time: new Date(item.lastVisitTime).toISOString(),
          visit_count: item.visitCount,
          domain: domain,
          typed_count: item.typedCount || 0
        };
      }),
      metadata: {
        total_found: filteredItems.length,
        returned_count: results.length,
        search_params: {
          keywords: keywords || null,
          date_range: start_date && end_date ?
            `${start_date} to ${end_date}` :
            start_date ? `from ${start_date}` :
            end_date ? `until ${end_date}` : null,
          domains: domains.length > 0 ? domains : null,
          min_visit_count,
          sort_by,
          sort_order
        },
        execution_time: new Date().toISOString(),
        over_fetched: historyItems.length,
        filters_applied: {
          domain_filter: domains.length > 0,
          visit_count_filter: min_visit_count > 1,
          date_filter: !!(start_date || end_date),
          keyword_filter: !!keywords
        }
      }
    };

  } catch (error) {
    return {
      success: false,
      error: `History search failed: ${error.message}`,
      history_items: [],
      metadata: {
        total_found: 0,
        returned_count: 0,
        search_params: params,
        execution_time: new Date().toISOString()
      }
    };
  }
}

// Selected Text Management Function
async function getSelectedText(params) {
  const {
    include_metadata = true,
    max_length = 10000,
    tab_id
  } = params;

  try {
    let targetTab;
    
    if (tab_id) {
      // Use specific tab
      try {
        targetTab = await browser.tabs.get(tab_id);
      } catch (error) {
        return {
          success: false,
          error: `Tab ${tab_id} not found or inaccessible`,
          selected_text: "",
          metadata: {
            execution_time: new Date().toISOString()
          }
        };
      }
    } else {
      // Get the active tab
      const [activeTab] = await browser.tabs.query({
        active: true,
        currentWindow: true,
      });
      
      if (!activeTab) {
        return {
          success: false,
          error: "No active tab found",
          selected_text: "",
          metadata: {
            execution_time: new Date().toISOString()
          }
        };
      }
      targetTab = activeTab;
    }

    // Execute script to get selected text - handle browser differences
    let results;
    if (browser.scripting) {
      // Chrome MV3
      results = await browser.scripting.executeScript({
        target: { tabId: targetTab.id },
        func: getSelectionFunction
      });
    } else {
      // Firefox MV2
      results = await browser.tabs.executeScript(targetTab.id, {
        code: `(${getSelectionFunction.toString()})()`
      });
    }

    const result = results[0]?.result || results[0];
    
    if (!result) {
      return {
        success: false,
        error: "Failed to execute selection script",
        selected_text: "",
        metadata: {
          execution_time: new Date().toISOString()
        }
      };
    }

    if (!result.hasSelection) {
      return {
        success: true,
        selected_text: "",
        has_selection: false,
        message: "No text is currently selected on the page",
        metadata: {
          execution_time: new Date().toISOString(),
          tab_info: {
            id: targetTab.id,
            url: targetTab.url,
            title: targetTab.title
          }
        }
      };
    }

    // Truncate text if it exceeds max_length
    let selectedText = result.text;
    let truncated = false;
    if (selectedText.length > max_length) {
      selectedText = selectedText.substring(0, max_length);
      truncated = true;
    }

    const response = {
      success: true,
      selected_text: selectedText,
      has_selection: true,
      character_count: result.text.length,
      truncated: truncated,
      metadata: {
        execution_time: new Date().toISOString(),
        tab_info: {
          id: targetTab.id,
          url: targetTab.url,
          title: targetTab.title
        }
      }
    };

    // Include detailed metadata if requested
    if (include_metadata && result.metadata) {
      response.selection_metadata = result.metadata;
    }

    return response;

  } catch (error) {
    return {
      success: false,
      error: `Failed to get selected text: ${error.message}`,
      selected_text: "",
      has_selection: false,
      metadata: {
        execution_time: new Date().toISOString(),
        error_details: error.stack
      }
    };
  }
}

// Function to execute in page context
function getSelectionFunction() {
  const selection = window.getSelection();
  const selectedText = selection.toString();
  
  if (!selectedText) {
    return {
      text: "",
      hasSelection: false,
      metadata: null
    };
  }

  // Get metadata about the selection
  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  
  // Get parent element info
  const commonAncestor = range.commonAncestorContainer;
  const parentElement = commonAncestor.nodeType === Node.TEXT_NODE
    ? commonAncestor.parentElement
    : commonAncestor;
  
  const metadata = {
    length: selectedText.length,
    word_count: selectedText.trim().split(/\s+/).filter(word => word.length > 0).length,
    line_count: selectedText.split('\n').length,
    position: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height
    },
    parent_element: {
      tag_name: parentElement.tagName?.toLowerCase(),
      class_name: parentElement.className,
      id: parentElement.id,
      text_content_length: parentElement.textContent?.length || 0
    },
    page_info: {
      url: window.location.href,
      title: document.title,
      domain: window.location.hostname
    },
    selection_info: {
      anchor_offset: selection.anchorOffset,
      focus_offset: selection.focusOffset,
      range_count: selection.rangeCount,
      is_collapsed: selection.isCollapsed
    }
  };

  return {
    text: selectedText,
    hasSelection: true,
    metadata: metadata
  };
}

// Initialize connection when extension loads (with delay for server startup)
setTimeout(() => {
  connectionManager.connect();
}, 1000);

// Handle messages from popup
browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getStatus") {
    sendResponse(connectionManager.getStatus());
  } else if (request.action === "getToolCount") {
    const tools = getAvailableTools();
    sendResponse({
      toolCount: tools.length,
      tools: tools.map(t => t.name)
    });
  } else if (request.action === "reconnect") {
    connectionManager.manualReconnectNow();
    sendResponse({ success: true });
  } else if (request.action === "disconnect") {
    connectionManager.manualDisconnectNow();
    sendResponse({ success: true, manualDisconnect: true });
  } else if (request.action === "getPorts") {
    sendResponse({
      current: lastKnownPorts,
      websocketUrl: MCP_SERVER_URL
    });
  } else if (request.action === "setSafetyMode") {
    safetyModeEnabled = request.enabled;
    console.log(`🛡️ Safety Mode ${safetyModeEnabled ? 'ENABLED' : 'DISABLED'}`);
    sendResponse({ success: true });
  } else if (request.action === "test") {
    connectionManager.send({ type: "test", timestamp: Date.now() });
    sendResponse({ success: true });
  }
  return true; // Keep the message channel open
});