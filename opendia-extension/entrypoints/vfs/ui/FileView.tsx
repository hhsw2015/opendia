import { useMemo, useState } from 'react';
import { Code, Eye } from 'lucide-react';
import { CopyButton } from '@/components/common/CopyButton';
import { MarkdownRenderer } from '@/components/common/MarkdownRenderer';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { parseFrontmatter } from '@/lib/content/frontmatter';
import { t } from '@/lib/i18n';
import { fileExtension, formatSize, pickFileIcon } from '../lib/path-utils';
import type { FileMedia } from '../types';

export function FileView({ path, media }: { path: string; media: FileMedia }) {
  const name = path.split('/').pop() ?? path;
  const ext = fileExtension(name);
  const Icon = pickFileIcon(ext);

  // Header is shared across all media types. Each branch passes only the
  // bits that apply to its type (copy / line count / size / toggle), keeping
  // the per-type header rules colocated with the body.
  const renderHeader = (right: React.ReactNode) => (
    <div className="flex items-center justify-between px-4 py-2.5 bg-card border-b border-border">
      <div className="flex items-center gap-2.5 min-w-0">
        <Icon size={18} strokeWidth={1.5} className="shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium truncate">{name}</span>
      </div>
      <div className="flex items-center gap-2 shrink-0">{right}</div>
    </div>
  );

  const sizeBadge = (
    <span className="text-xs text-muted-foreground tabular-nums">{formatSize(media.size)}</span>
  );

  switch (media.type) {
    case 'text': {
      const lineCount = media.content.length === 0 ? 0 : media.content.split('\n').length;
      return (
        <div className="border border-border rounded-lg overflow-hidden">
          {renderHeader(
            <>
              <CopyButton text={media.content} />
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="tabular-nums">{t('vfs.lines', [lineCount])}</span>
                <span className="text-border">·</span>
                <span className="tabular-nums">{formatSize(media.size)}</span>
              </div>
            </>,
          )}
          <div className="relative overflow-auto max-h-[calc(100vh-12rem)]">
            <pre className="p-4 text-[13px] leading-relaxed font-mono text-foreground/90 whitespace-pre-wrap wrap-break-word selection:bg-primary/20">
              {media.content}
            </pre>
          </div>
        </div>
      );
    }
    case 'markdown':
      return <MarkdownFileView media={media} renderHeader={renderHeader} />;
    case 'image':
      return (
        <div className="border border-border rounded-lg overflow-hidden">
          {renderHeader(sizeBadge)}
          <div className="bg-muted/30 flex items-center justify-center overflow-auto max-h-[calc(100vh-12rem)]">
            <img
              src={media.url}
              alt={name}
              className="max-w-full max-h-[calc(100vh-12rem)] object-contain"
            />
          </div>
        </div>
      );
    case 'video':
      return (
        <div className="border border-border rounded-lg overflow-hidden">
          {renderHeader(sizeBadge)}
          <div className="bg-muted/30 flex items-center justify-center">
            <video
              src={media.url}
              controls
              className="max-w-full max-h-[calc(100vh-12rem)]"
            />
          </div>
        </div>
      );
    case 'audio':
      return (
        <div className="border border-border rounded-lg overflow-hidden">
          {renderHeader(sizeBadge)}
          <div className="bg-muted/30 flex items-center justify-center p-6">
            <audio src={media.url} controls className="w-full max-w-md" />
          </div>
        </div>
      );
    case 'binary':
      return (
        <div className="border border-border rounded-lg overflow-hidden">
          {renderHeader(sizeBadge)}
          <div className="p-4 text-[13px] text-muted-foreground italic">
            {t('vfs.binaryFile', [formatSize(media.size)])}
          </div>
        </div>
      );
    case 'tooLarge':
      return (
        <div className="border border-border rounded-lg overflow-hidden">
          {renderHeader(sizeBadge)}
          <div className="p-4 text-[13px] text-muted-foreground">
            {t('vfs.tooLargeToPreview', [formatSize(media.size)])}
          </div>
        </div>
      );
    default: {
      // Exhaustiveness guard — if a new FileMedia variant is added without
      // a matching case, TS will flag this assignment at compile time
      // rather than letting React silently render `undefined` at runtime.
      const _exhaustive: never = media;
      return _exhaustive;
    }
  }
}

/** Markdown variant lives in its own component so it can own the
 *  preview/source toggle state without polluting `FileView`'s switch.
 *
 *  The toggle state persists across markdown-to-markdown navigation by
 *  design: React keeps `MarkdownFileView` mounted at the same JSX slot,
 *  so `useState` survives a prop-only change. We rely on this — a user
 *  stepping through several `.md` files with their preferred view (raw
 *  source while reviewing, preview while reading) shouldn't have to
 *  re-toggle each time. State naturally resets only when leaving the
 *  markdown branch entirely (different file class / dir / error). */
function MarkdownFileView({
  media,
  renderHeader,
}: {
  media: Extract<FileMedia, { type: 'markdown' }>;
  renderHeader: (right: React.ReactNode) => React.ReactNode;
}) {
  const [mode, setMode] = useState<'preview' | 'source'>('preview');
  const lineCount = media.content.length === 0 ? 0 : media.content.split('\n').length;
  const showingPreview = mode === 'preview';

  // Split frontmatter out so we can render it as a GitHub-style table in
  // preview mode. Memoize because parsing scans the whole document.
  const { frontmatterData, body } = useMemo(() => {
    const { data, body: rest } = parseFrontmatter(media.content);
    return { frontmatterData: data, body: rest };
  }, [media.content]);
  const hasFrontmatter = Object.keys(frontmatterData).length > 0;

  const toggle = (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => setMode(showingPreview ? 'source' : 'preview')}
          aria-label={showingPreview ? t('vfs.viewSource') : t('vfs.preview')}
          className="size-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        >
          {showingPreview ? <Code className="size-4" /> : <Eye className="size-4" />}
        </button>
      </TooltipTrigger>
      <TooltipContent>{showingPreview ? t('vfs.viewSource') : t('vfs.preview')}</TooltipContent>
    </Tooltip>
  );

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      {renderHeader(
        <>
          {toggle}
          {/* Copy always copies the raw source, regardless of mode — that's
           *  what users want to paste elsewhere. */}
          <CopyButton text={media.content} />
          {/* Line count + size always shown in both modes — hiding lines in
           *  preview mode would shift the toggle button horizontally on every
           *  click, which makes repeated toggling a frustrating moving target. */}
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="tabular-nums">{t('vfs.lines', [lineCount])}</span>
            <span className="text-border">·</span>
            <span className="tabular-nums">{formatSize(media.size)}</span>
          </div>
        </>,
      )}
      <div className="relative overflow-auto max-h-[calc(100vh-12rem)]">
        {showingPreview ? (
          // Prose neutralizers (prose-code: + prose-pre:) cancel out
          // typography defaults that conflict with MarkdownRenderer's own
          // styling: prose injects literal backticks around inline <code>
          // and gives <pre> a dark slate background that overrides our
          // CodeBlock's container. We keep typography for headings / lists
          // / blockquotes / tables, but hand code rendering back to
          // MarkdownRenderer.
          <div
            className={
              'prose prose-sm dark:prose-invert max-w-none p-4 ' +
              'prose-code:before:content-none prose-code:after:content-none prose-code:font-normal ' +
              'prose-pre:bg-transparent prose-pre:text-inherit prose-pre:p-0 prose-pre:m-0 prose-pre:rounded-none prose-pre:font-normal'
            }
          >
            {hasFrontmatter && <FrontmatterTable data={frontmatterData} />}
            <MarkdownRenderer content={body} />
          </div>
        ) : (
          <pre className="p-4 text-[13px] leading-relaxed font-mono text-foreground/90 whitespace-pre-wrap wrap-break-word selection:bg-primary/20">
            {media.content}
          </pre>
        )}
      </div>
    </div>
  );
}

/** GitHub-style frontmatter renderer.
 *
 *  Scalars render as plain text in the right column; nested values (objects
 *  and arrays) fall back to a `<pre>` that shows the value as JSON-formatted
 *  text so the structure stays readable without pulling in a YAML
 *  serializer at render time. The `not-prose` opt-out keeps `@tailwindcss/
 *  typography`'s defaults from re-styling our table padding / borders. */
function FrontmatterTable({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="not-prose mb-4 overflow-hidden rounded-md border border-border">
      <table className="w-full text-[13px] table-fixed">
        <tbody>
          {Object.entries(data).map(([key, value], i, arr) => (
            <tr key={key} className={i < arr.length - 1 ? 'border-b border-border' : undefined}>
              <th className="w-1/3 px-3 py-2 text-left font-mono text-muted-foreground align-top bg-muted/30">
                {key}
              </th>
              <td className="px-3 py-2 align-top wrap-break-word">
                {renderFrontmatterValue(value)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderFrontmatterValue(value: unknown): React.ReactNode {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground italic">null</span>;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return <span>{String(value)}</span>;
  }
  // Dates come back from `front-matter`/js-yaml as real Date instances for
  // ISO-8601 scalars (`date: 2024-05-15` etc.). Render the ISO string
  // directly rather than letting them fall into the JSON branch where
  // they'd render as quoted strings inside a <pre>.
  if (value instanceof Date) {
    return <span>{value.toISOString()}</span>;
  }
  // Objects and arrays: pretty-print as JSON inside a pre. Wrapping in
  // <pre> keeps newlines/indentation; `whitespace-pre-wrap` lets very long
  // lines wrap instead of pushing the table wider than the viewport.
  return (
    <pre className="font-mono text-xs text-foreground/80 whitespace-pre-wrap wrap-break-word">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
