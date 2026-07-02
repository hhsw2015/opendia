import { ChevronRight } from 'lucide-react';
import { navigateTo } from '../lib/path-utils';

export function Breadcrumbs({ path }: { path: string }) {
  const segments = path === '/' ? [] : path.split('/').filter(Boolean);

  return (
    <nav className="flex items-center gap-0.5 text-sm font-mono overflow-x-auto min-w-0 scrollbar-none">
      <button
        onClick={() => navigateTo('/')}
        className="shrink-0 px-1.5 py-0.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
      >
        /
      </button>
      {segments.map((seg, i) => {
        const segPath = '/' + segments.slice(0, i + 1).join('/');
        const isLast = i === segments.length - 1;
        return (
          <span key={segPath} className="flex items-center gap-0.5 min-w-0">
            <ChevronRight size={14} className="shrink-0 text-muted-foreground/40" />
            {isLast ? (
              <span className="text-foreground font-medium truncate">{seg}</span>
            ) : (
              <button
                onClick={() => navigateTo(segPath)}
                className="px-1.5 py-0.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors truncate max-w-48"
              >
                {seg}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}
