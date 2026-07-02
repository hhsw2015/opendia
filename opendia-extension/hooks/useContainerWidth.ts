import { useLayoutEffect, useState, type RefObject } from 'react';

/**
 * Options for `useContainerWidth`.
 */
export interface UseContainerWidthOptions {
  /**
   * Coalesce strategy for ResizeObserver callbacks.
   *
   * - `undefined` (default): one `setState` per observer callback,
   *   raw float width.
   * - `'raf'`: coalesce to one `setState` per animation frame and
   *   `Math.floor` the value to dedup sub-pixel jitter. Use when the
   *   consumer drives expensive downstream work per width change —
   *   posting cross-iframe messages, re-laying out a heavy widget,
   *   etc. — and the savings of "once per frame" outweigh the (single
   *   frame) latency.
   */
  coalesce?: 'raf';
}

/**
 * useContainerWidth — observe an element's content-box width via ResizeObserver.
 *
 * Returns `null` until the element is mounted and measured at least once.
 * Uses `useLayoutEffect` so the first measurement runs before paint, avoiding
 * a layout flash when the consumer switches layout at a breakpoint.
 *
 * Useful for component-level responsive layouts where `window.innerWidth`
 * is the wrong signal (e.g. the Settings hub renders both inside a ~380px
 * sidepanel and inside a full-width tab page).
 */
export function useContainerWidth(
  ref: RefObject<HTMLElement | null>,
  opts?: UseContainerWidthOptions,
): number | null {
  const coalesce = opts?.coalesce;
  const [width, setWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const round = (w: number) => (coalesce === 'raf' ? Math.floor(w) : w);
    // Seed with current size so first render after mount already has a value.
    setWidth(round(el.getBoundingClientRect().width));

    let rafId: number | null = null;
    let pendingWidth = 0;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      if (coalesce === 'raf') {
        pendingWidth = entry.contentRect.width;
        if (rafId !== null) return;
        rafId = requestAnimationFrame(() => {
          rafId = null;
          setWidth(Math.floor(pendingWidth));
        });
      } else {
        setWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [ref, coalesce]);

  return width;
}
