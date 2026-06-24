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
  // MV3 page CSP forbids constructing a function from a string. Without
  // CSP bypass via chrome.debugger, we can't honor arbitrary JS in the
  // page world. Tell the caller to use dom_query / dom_query_all /
  // dispatch_keys instead.
  return {
    success: false,
    error: "evaluate_js requires Function-from-string, which MV3 + page CSP forbid. Use browser_dom_query / browser_dom_query_all / browser_dispatch_keys / browser_wait_for_selector for DOM operations."
  };
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
    timeoutMs: params.timeout_ms || 8000,
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
  const tabId = params.tab_id ? await _resolveTabId(params.tab_id) : null;
  const format = params.format === 'jpeg' ? 'jpeg' : 'png';
  const quality = format === 'jpeg' ? (params.quality || 90) : undefined;
  let windowId;
  if (tabId) {
    const tab = await browser.tabs.get(tabId);
    windowId = tab.windowId;
  } else {
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
  // Strip the data: prefix and just return base64 + mime.
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
  if (params.name) {
    const r = await new Promise(res => chrome.cookies.remove({ url: params.url, name: params.name }, res));
    return { success: !!r, removed: r };
  }
  // Remove all cookies for this URL.
  const all = await new Promise(res => chrome.cookies.getAll({ url: params.url }, res));
  const removed = [];
  for (const c of all) {
    await new Promise(res => chrome.cookies.remove({ url: params.url, name: c.name }, () => res()));
    removed.push(c.name);
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