// Compact a11y/DOM snapshot for the SPEC `browser_snapshot` tool.
// Pure traversal: given a node-like root (Element or Document or plain
// {tagName, attrs, children, textContent} fixture for tests), produces:
//   { schema_version: "1", text, ref_map, truncated, source }
//
// UMD-ish: works both as `node --test`-importable CJS and as a
// content-script `<script src="snapshot.js">` (attaches to globalThis).
//
// Spec: docs/specs/everywhere-replace-agent-browser.md §4.1.

"use strict";

(function (globalRoot, moduleRef) {

// Idempotence guard for re-injection (Firefox SPA, content-script
// dynamic re-load). The module is pure today, but a future state
// addition would silently double-bind without this.
if (moduleRef === null && globalRoot && globalRoot.OpenDiaSnapshot) {
  return;
}

const ACTIONABLE_TAGS = new Set([
  "a", "button", "input", "textarea", "select", "label",
  "summary", "details",
]);
const ACTIONABLE_ROLES = new Set([
  "button", "link", "checkbox", "radio", "textbox", "combobox",
  "menuitem", "tab", "switch", "searchbox",
]);
const SKIP_TAGS = new Set([
  "script", "style", "noscript", "template", "head", "meta",
  "link", "title",
]);

const DEFAULT_OPTS = {
  maxNodes: 400,
  maxNameLen: 80,
  interactiveOnly: false,
};

function tagOf(node) {
  if (!node) return null;
  if (typeof node.tagName === "string") return node.tagName.toLowerCase();
  if (typeof node.nodeName === "string") return node.nodeName.toLowerCase();
  return null;
}

function attr(node, name) {
  if (!node) return null;
  if (typeof node.getAttribute === "function") {
    return node.getAttribute(name);
  }
  if (node.attrs && Object.prototype.hasOwnProperty.call(node.attrs, name)) {
    return node.attrs[name];
  }
  return null;
}

function visibleText(node) {
  if (!node) return "";
  if (typeof node.textContent === "string") return node.textContent;
  return "";
}

function childrenOf(node) {
  if (!node) return [];
  if (Array.isArray(node.children)) return node.children;
  if (node.childNodes && typeof node.childNodes.length === "number") {
    return Array.from(node.childNodes).filter((c) => c.nodeType === 1);
  }
  return [];
}

function roleOf(node) {
  const explicit = attr(node, "role");
  if (explicit) return explicit;
  const tag = tagOf(node);
  switch (tag) {
    case "a": return "link";
    case "button": return "button";
    case "input": {
      const t = (attr(node, "type") || "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "submit" || t === "button") return "button";
      if (t === "search") return "searchbox";
      return "textbox";
    }
    case "textarea": return "textbox";
    case "select": return "combobox";
    case "label": return "label";
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
      return "heading";
    case "img": return "image";
    case "ul": case "ol": return "list";
    case "li": return "listitem";
    case "nav": return "navigation";
    case "main": return "main";
    case "header": return "banner";
    case "footer": return "contentinfo";
    case "form": return "form";
    default: return tag || "generic";
  }
}

function nameOf(node, role) {
  const aria = attr(node, "aria-label");
  if (aria) return aria;
  const labelled = attr(node, "aria-labelledby");
  if (labelled && node.ownerDocument && node.ownerDocument.getElementById) {
    const ref = node.ownerDocument.getElementById(labelled);
    if (ref) return (ref.textContent || "").trim();
  }
  const placeholder = attr(node, "placeholder");
  if (placeholder && (role === "textbox" || role === "searchbox")) return placeholder;
  const alt = attr(node, "alt");
  if (alt && role === "image") return alt;
  const title = attr(node, "title");
  if (title) return title;
  const txt = (visibleText(node) || "").replace(/\s+/g, " ").trim();
  return txt;
}

function isActionable(node, role) {
  const tag = tagOf(node);
  if (ACTIONABLE_TAGS.has(tag)) return true;
  if (ACTIONABLE_ROLES.has(role)) return true;
  const tabindex = attr(node, "tabindex");
  if (tabindex && parseInt(tabindex, 10) >= 0) return true;
  const onclick = attr(node, "onclick");
  if (onclick) return true;
  return false;
}

function compactSnapshot(root, opts) {
  const o = Object.assign({}, DEFAULT_OPTS, opts || {});
  const refMap = {};
  const refElements = []; // index = refN; only populated when opts.recordElements
  const lines = [];
  let nextRef = 0;
  let truncated = false;

  function walk(node, depth) {
    if (!node) return;
    const tag = tagOf(node);
    if (SKIP_TAGS.has(tag)) return;
    if (nextRef >= o.maxNodes) {
      truncated = true;
      return;
    }
    const role = roleOf(node);
    const actionable = isActionable(node, role);
    if (!o.interactiveOnly || actionable) {
      const rawName = nameOf(node, role);
      const name = rawName.length > o.maxNameLen
        ? rawName.slice(0, o.maxNameLen) + "…"
        : rawName;
      const ref = "@ref" + nextRef;
      const entry = { role, name, frame_id: null };
      if (o.includeRects && typeof node.getBoundingClientRect === "function") {
        const r = node.getBoundingClientRect();
        if (r && (r.width > 0 || r.height > 0)) {
          entry.rect = { x: Math.round(r.left), y: Math.round(r.top),
                         w: Math.round(r.width), h: Math.round(r.height) };
        }
      }
      refMap[ref] = entry;
      if (o.recordElements) refElements[nextRef] = node;
      const prefix = "  ".repeat(depth);
      const nameTok = name ? ' "' + name.replace(/"/g, "'") + '"' : "";
      lines.push(prefix + "- " + ref + " " + role + nameTok);
      nextRef += 1;
    }
    for (const child of childrenOf(node)) walk(child, depth + 1);
  }

  walk(root, 0);

  const out = {
    schema_version: "1",
    text: lines.join("\n"),
    ref_map: refMap,
    truncated,
    source: { kind: "browser", id: (opts && opts.source_id) || "active-tab" },
  };
  if (o.recordElements) out._elements = refElements;
  return out;
}

// SPEC: shared @refN / @findN → live element resolver consumed by
// click/fill/type. @refN comes from a snapshot/diff_snapshot call;
// @findN comes from find/find_by_*. They live in separate tables so a
// later snapshot does not invalidate prior find handles.
function resolveRef(refStr, snapshotTable, opName, findTable) {
  const op = opName || "ref";
  if (!refStr) throw new Error(op + ": ref required (e.g. \"@ref3\" or \"@find2\")");
  const s = String(refStr);
  // Stale-navigation guard: a snapshot's URL is stamped on the global at
  // snap time. If location.href has since changed and the navigation
  // invalidator missed it (some frameworks bypass pushState), fail fast
  // rather than dispatch into a detached node.
  if (typeof window !== "undefined" && globalThis.__openDiaSnapshotUrl &&
      window.location && window.location.href !== globalThis.__openDiaSnapshotUrl) {
    throw new Error(op + ": stale snapshot — page navigated since the last snapshot (call snapshot again)");
  }
  let m;
  if ((m = s.match(/^@ref(\d+)$/))) {
    const idx = parseInt(m[1], 10);
    const el = (snapshotTable || [])[idx];
    if (!el) throw new Error(op + ": " + refStr + " not in current snapshot (call snapshot first)");
    if (typeof el.isConnected === "boolean" && !el.isConnected) {
      throw new Error(op + ": " + refStr + " element is detached from the document (page changed; call snapshot again)");
    }
    return el;
  }
  if ((m = s.match(/^@find(\d+)$/))) {
    const idx = parseInt(m[1], 10);
    const el = (findTable || [])[idx];
    if (!el) throw new Error(op + ": " + refStr + " not in current find table (call find/find_by_* first)");
    if (typeof el.isConnected === "boolean" && !el.isConnected) {
      throw new Error(op + ": " + refStr + " element is detached from the document (page changed; call find again)");
    }
    return el;
  }
  throw new Error(op + ": invalid ref \"" + refStr + "\" (expected @refN or @findN)");
}

const api = {
  compactSnapshot,
  resolveRef,
  _internals: { roleOf, nameOf, isActionable },
};
if (moduleRef) {
  moduleRef.exports = api;
} else {
  globalRoot.OpenDiaSnapshot = api;
}

})(typeof globalThis !== "undefined" ? globalThis : this,
   typeof module !== "undefined" && module.exports ? module : null);
