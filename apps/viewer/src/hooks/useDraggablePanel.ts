/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

export interface DraggablePanel {
  /** Current dragged position (offset-parent relative), or null = use the
   *  panel's default CSS anchor. Spread onto the root via {@link style}. */
  position: { top: number; left: number } | null;
  /** Inline style for the panel root: pins top/left and clears the default
   *  right/bottom anchor once dragged. Empty object before the first drag. */
  style: React.CSSProperties;
  /** Attach to the drag handle (e.g. the panel header) `onMouseDown`. */
  onDragStart: (e: React.MouseEvent) => void;
  /** True while a drag is in progress. */
  isDragging: boolean;
  /** Snap back to the default CSS anchor. */
  reset: () => void;
}

/**
 * Reusable "drag a floating panel by its header" behaviour, generalised from
 * the Section 2D panel (issue #1107). The panel keeps its default CSS anchor
 * (e.g. `absolute bottom-4 left-4`) until the user drags it; then it switches
 * to explicit top/left, clamped to its offset parent. Local-only — position
 * resets when the panel unmounts.
 *
 * Usage:
 *   const ref = useRef<HTMLDivElement>(null);
 *   const drag = useDraggablePanel(ref);
 *   <div ref={ref} className="absolute bottom-4 left-4 ..." style={drag.style}>
 *     <header onMouseDown={drag.onDragStart} className="cursor-move">…</header>
 *   </div>
 *
 * Mousedowns that originate on interactive controls (button/input/select/a or
 * anything marked `data-no-drag`) are ignored, so header buttons keep working.
 */
export interface FloatingPanelOptions {
  /** localStorage key the dragged position is remembered under. */
  persistKey: string;
  /**
   * Where the panel starts before it was ever dragged, in window
   * coordinates. Receives the viewport's rect (`[data-viewport]`, or the
   * window when absent) and the panel's own size.
   */
  initial: (viewport: DOMRect, panel: { width: number; height: number }) => { top: number; left: number };
}

type Pos = { top: number; left: number };

function clampToWindow(pos: Pos, el: HTMLElement | null): Pos {
  const w = el?.offsetWidth ?? 0;
  const h = el?.offsetHeight ?? 0;
  return {
    left: Math.max(0, Math.min(Math.max(0, window.innerWidth - w), pos.left)),
    top: Math.max(0, Math.min(Math.max(0, window.innerHeight - h), pos.top)),
  };
}

function loadPos(key: string): Pos | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<Pos>;
    return Number.isFinite(p.top) && Number.isFinite(p.left) ? { top: p.top!, left: p.left! } : null;
  } catch {
    return null;
  }
}

function savePos(key: string, pos: Pos | null): void {
  try {
    if (pos) localStorage.setItem(key, JSON.stringify(pos));
    else localStorage.removeItem(key);
  } catch {
    // Private mode / blocked storage: position just isn't remembered.
  }
}

export function useDraggablePanel(
  panelRef: RefObject<HTMLElement | null>,
  opts?: {
    disabled?: boolean;
    /**
     * Free-floating mode: the panel is `position: fixed` (typically portaled
     * to `document.body`), moves over the whole app rather than its offset
     * parent, and its position is remembered across sessions.
     */
    floating?: FloatingPanelOptions;
  },
): DraggablePanel {
  const disabled = opts?.disabled ?? false;
  const floating = opts?.floating;
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const floatingRef = useRef(floating);
  floatingRef.current = floating;

  // Floating: restore the remembered position, else derive the start
  // position from the viewport; re-clamp whenever the window resizes.
  const persistKey = floating?.persistKey;
  useLayoutEffect(() => {
    const f = floatingRef.current;
    if (!f) return;
    const el = panelRef.current;
    const saved = loadPos(f.persistKey);
    if (saved) {
      setPosition(clampToWindow(saved, el));
    } else if (el) {
      const vp = document.querySelector('[data-viewport]')?.getBoundingClientRect()
        ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
      setPosition(clampToWindow(f.initial(vp, { width: el.offsetWidth, height: el.offsetHeight }), el));
    }
    const onResize = () => setPosition((p) => (p ? clampToWindow(p, panelRef.current) : p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [persistKey, panelRef]);
  const [isDragging, setIsDragging] = useState(false);
  const startRef = useRef({ x: 0, y: 0, top: 0, left: 0 });
  const handlersRef = useRef<{ move: ((e: MouseEvent) => void) | null; up: (() => void) | null }>({
    move: null,
    up: null,
  });

  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      if (disabled) return;
      const el = panelRef.current;
      if (!el) return;
      // Don't hijack clicks on interactive header controls.
      if ((e.target as HTMLElement).closest('button, input, select, textarea, a, [role="slider"], [data-no-drag]')) {
        return;
      }
      e.preventDefault();

      // Capture the *visual* position relative to the offset parent (via
      // getBoundingClientRect) rather than offsetTop/Left, so panels centred
      // with `left-1/2 -translate-x-1/2` don't jump when we switch to explicit
      // top/left + `transform: none` (handled in `style` below).
      const rect = el.getBoundingClientRect();
      const isFloating = floatingRef.current !== undefined;
      const parentRect = isFloating ? undefined : (el.offsetParent as HTMLElement | null)?.getBoundingClientRect();
      const baseLeft = rect.left - (parentRect?.left ?? 0);
      const baseTop = rect.top - (parentRect?.top ?? 0);

      startRef.current = { x: e.clientX, y: e.clientY, top: baseTop, left: baseLeft };
      setPosition({ top: baseTop, left: baseLeft });
      setIsDragging(true);

      if (handlersRef.current.move) window.removeEventListener('mousemove', handlersRef.current.move);
      if (handlersRef.current.up) window.removeEventListener('mouseup', handlersRef.current.up);

      const parent = isFloating ? null : (el.offsetParent as HTMLElement | null);
      const maxLeft = Math.max(0, (parent?.clientWidth ?? window.innerWidth) - el.offsetWidth);
      const maxTop = Math.max(0, (parent?.clientHeight ?? window.innerHeight) - el.offsetHeight);
      let last: Pos = { top: baseTop, left: baseLeft };

      const move = (ev: MouseEvent) => {
        const left = Math.max(0, Math.min(maxLeft, startRef.current.left + ev.clientX - startRef.current.x));
        const top = Math.max(0, Math.min(maxTop, startRef.current.top + ev.clientY - startRef.current.y));
        last = { top, left };
        setPosition(last);
      };
      const up = () => {
        setIsDragging(false);
        const f = floatingRef.current;
        if (f) savePos(f.persistKey, last);
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        handlersRef.current = { move: null, up: null };
      };

      handlersRef.current = { move, up };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    },
    [panelRef, disabled],
  );

  useEffect(
    () => () => {
      if (handlersRef.current.move) window.removeEventListener('mousemove', handlersRef.current.move);
      if (handlersRef.current.up) window.removeEventListener('mouseup', handlersRef.current.up);
    },
    [],
  );

  const reset = useCallback(() => {
    const f = floatingRef.current;
    if (!f) {
      setPosition(null);
      return;
    }
    savePos(f.persistKey, null);
    const el = panelRef.current;
    const vp = document.querySelector('[data-viewport]')?.getBoundingClientRect()
      ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    setPosition(el ? clampToWindow(f.initial(vp, { width: el.offsetWidth, height: el.offsetHeight }), el) : null);
  }, [panelRef]);

  const style: React.CSSProperties = position
    ? {
        top: position.top,
        left: position.left,
        right: 'auto',
        bottom: 'auto',
        // Clear any centering offset. Tailwind v4's `-translate-x-1/2` uses the
        // CSS `translate` property (not `transform`), so we must zero `translate`
        // too — otherwise the panel stays shifted half its width left of the
        // cursor after a drag begins.
        transform: 'none',
        translate: 'none',
      }
    : {};

  return { position, style, onDragStart, isDragging, reset };
}
