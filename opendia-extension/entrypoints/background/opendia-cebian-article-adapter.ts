// Adapter: exposes Cebian's Readability-based article extraction to
// OpenDia's pre-merge background.js dispatch table without touching the
// browser_* wire schema. Only page_extract_content(content_type='article')
// is rerouted through Cebian; content_type='search_results' and 'posts'
// stay on OpenDia's heuristic content-script extractors (Cebian has no
// equivalent for those two shapes).
//
// The daemon's WS wire (input schema + output shape) is unchanged — this
// only swaps the underlying implementation for the "article" case where
// Cebian's Mozilla-Readability + turndown pipeline produces markedly
// cleaner output.
import { executeInTabWithArgs } from '@/lib/browser/tab-actions';
import { ensureOffscreen } from '@/lib/tools/offscreen';
import type { OffscreenRequest, OffscreenResponse } from '@/entrypoints/offscreen/main';

// In-tab extractors: pure functions injected via chrome.scripting.executeScript.
// Kept inline (not imported from lib/tools/read-page) because that module
// pulls in typebox / AgentTool types that don't belong in a plain adapter.

function getDocumentHtmlInTab(): { html: string; url: string } {
  const doctype = document.doctype
    ? `<!DOCTYPE ${document.doctype.name}${document.doctype.publicId ? ` PUBLIC "${document.doctype.publicId}"` : ''}${document.doctype.systemId ? ` "${document.doctype.systemId}"` : ''}>\n`
    : '';
  return { html: doctype + document.documentElement.outerHTML, url: location.href };
}

function extractPlainTextInTab(): string {
  return document.body?.innerText ?? '';
}

async function convertArticleViaOffscreen(html: string, url: string): Promise<string | null> {
  await ensureOffscreen();
  const req: OffscreenRequest = { type: 'html-to-markdown', html, readability: { url } };
  const resp = await new Promise<OffscreenResponse>((resolve) => {
    chrome.runtime.sendMessage(req, (r) => resolve((r as OffscreenResponse) ?? {}));
  });
  if (resp?.error || !resp?.result) return null;
  return resp.result;
}

// Public hook consumed by src/background/background.js (case
// "page_extract_content"). Falls back to plain-text extraction if
// Readability declines to parse the page — matches Cebian's own fallback.
(globalThis as any).__opendiaExtractArticle = async (tabId: number) => {
  const { html, url } = await executeInTabWithArgs(tabId, getDocumentHtmlInTab, []);
  const markdown = await convertArticleViaOffscreen(html, url);
  if (markdown) return { markdown, method: 'readability' as const, url };
  const text = await executeInTabWithArgs(tabId, extractPlainTextInTab, []);
  return { markdown: text, method: 'plaintext_fallback' as const, url };
};

export {};
