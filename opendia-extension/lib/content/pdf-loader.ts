/**
 * Lazy loader for Mozilla's pdf.js engine.
 *
 * Why a dedicated module: `pdfjs-dist` is ~2 MB and only needed when the
 * user actually opens a PDF. Importing it from a top-level module would
 * fatten every entry point's main chunk. By isolating the import here
 * behind `await import('pdfjs-dist')`, Vite/Rollup splits pdf.js into its
 * own chunk that is fetched on first call only.
 *
 * Worker registration is the other thing that must happen exactly once.
 * The worker file lives inside the installed pdfjs-dist package; we ask
 * Vite to emit it as a content-hashed asset via the `?url` import
 * (`pdfjs-dist/build/pdf.worker.mjs?url`). This guarantees the API and
 * Worker versions stay in lock-step — `pnpm update pdfjs-dist` refreshes
 * both at once. pdf.js v5 actively enforces this match and throws
 * `UnknownErrorException: API version does not match Worker version`
 * when they drift.
 *
 * Designed to be called from the offscreen document. Calling from a
 * Service Worker context will fail because pdf.js needs DOM-only APIs
 * (DOMMatrix, OffscreenCanvas, etc.).
 */

// `?url` import: Vite resolves the file inside `node_modules/pdfjs-dist/...`
// at build time and emits it as an asset, returning a URL string. WXT
// brings in `vite/client` types, which declares this module shape.
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

type PdfJs = typeof import('pdfjs-dist');

/** Singleton promise — concurrent callers share the same initialization. */
let modulePromise: Promise<PdfJs> | null = null;

export function loadPdfJs(): Promise<PdfJs> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const pdfjs = await import('pdfjs-dist');
      // Setting `workerSrc` is the canonical way to register a worker URL;
      // pdf.js itself does `new Worker(workerSrc, { type: 'module' })`
      // when a document is opened. Setting it more than once is a no-op
      // (last write wins) but our singleton guarantees we set it once.
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    })().catch((err) => {
      // Allow retry on next call instead of permanently caching a
      // rejected promise — a transient chunk-fetch failure shouldn't
      // permanently disable PDF support for the session.
      modulePromise = null;
      throw err;
    });
  }
  return modulePromise;
}
