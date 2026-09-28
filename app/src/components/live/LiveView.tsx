// The live browser view: 44 px browser bar, then the page at the test's locked viewport,
// scaled to fit the pane. Used by the Recorder (interactive) and by the Run view and
// Report (read-only, with "Clicking here" and status markers).
//
// Two sources (Engine.liveMode): 'frames' shows the latest `frame` JPEG from the engine;
// 'sample' shows the built-in sample app (demo). Either way, clicks are reported in
// viewport pixels at DPR 1, and markers are given in viewport pixels too.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { Box, Point, Viewport } from '../../data/types';
import { demoEngine, getEngine, type Frame } from '../../engine';
import { Icon } from '../ui';
import { distance, fitScale, inside, nextZoom, normBox, PAGE_PAD, toViewport } from './geometry';
import { SampleApp } from './sample/SampleApp';
import type { SampleState } from './sample/sampleModel';
import './live.css';

export interface LiveMarker {
  /**
   * locked: the selected step's locked area (2 px dashed accent, pulsing ring, numbered badge).
   * failed: red dashed "Expected here". old: grey dashed "Old position". new: amber "New position".
   */
  kind: 'locked' | 'failed' | 'old' | 'new';
  box: Box;
  /** Badge number (locked only). */
  n?: number;
  /** Label under the box, e.g. "Click locked here", "Clicking here", "Is this it?". */
  label?: string;
}

/** What a pointer on the page does. point: click adds a step. drag: from → to. box: draw an area. */
export type LiveTool = 'point' | 'drag' | 'box' | 'none';

export interface LiveViewProps {
  /** Shown in the address pill (no protocol), e.g. "app.example.com/projects". */
  address: string;
  /** The test's locked viewport. */
  viewport: Pick<Viewport, 'width' | 'height'>;
  /** Defaults to the engine's live mode. */
  source?: 'frames' | 'sample';
  /** Run view and report: no pointer tools, no hover. */
  readOnly?: boolean;
  tool?: LiveTool;
  onPoint?: (p: Point) => void;
  onDrag?: (from: Point, to: Point) => void;
  /** A drawn box, or `null` with the point when the user only clicked. */
  onBox?: (box: Box | null, at: Point) => void;
  markers?: LiveMarker[];
  /** The AI assistant's candidate box while it asks "Is this …?". */
  candidate?: Box | null;
  /** Thinking bubble text, e.g. "Looking for the Done button…". */
  thinking?: string | null;
  /** Browser-bar status pills (see CheckingPill, SavedPill). */
  status?: ReactNode;
  /** Anything else to draw over the page, positioned in viewport pixels. */
  overlay?: ReactNode;
  /** Sample source only: show this state instead of the live one (report screenshots). */
  sampleState?: SampleState;
  /** A screenshot to show instead of the live page (report, run history). */
  image?: string;
  /** Show "Opening the browser…" over the page. */
  loading?: boolean;
  hideBar?: boolean;
  hideZoom?: boolean;
  /** Space around the page inside the pane (default 16 px; 0 for report thumbnails). */
  pad?: number;
  className?: string;
}

export function LiveView(props: LiveViewProps) {
  const { viewport: vp, readOnly, markers = [], candidate, thinking, status, overlay, hideBar, hideZoom, className } = props;
  const engine = getEngine();
  const source = props.source ?? engine.liveMode;
  const tool: LiveTool = readOnly ? 'none' : props.tool ?? 'point';

  const paneRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [pane, setPane] = useState({ width: 900, height: 560 });
  const [zoom, setZoom] = useState<'fit' | number>('fit');
  const pad = props.pad ?? PAGE_PAD;
  const scale = zoom === 'fit' ? fitScale(pane, vp, pad) : zoom;

  useLayoutEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const measure = () => setPane({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [frame, setFrame] = useState<Frame | null>(null);
  useEffect(() => (source === 'frames' && !props.image ? engine.on('frame', setFrame) : undefined), [engine, source, props.image]);

  const pointer = usePagePointer({ tool, scale, vp, frameRef, source, onPoint: props.onPoint, onDrag: props.onDrag, onBox: props.onBox });

  const pct = Math.round(scale * 100);
  const pageStyle = { width: vp.width, height: vp.height, transform: `scale(${scale})`, '--s': scale } as CSSProperties;

  let page: ReactNode;
  if (props.image) page = <img className="live-img" src={props.image} alt="Screenshot of the page" draggable={false} />;
  else if (source === 'sample') page = <SampleApp viewport={vp} state={props.sampleState} />;
  else page = frame ? <img className="live-img" src={`data:image/jpeg;base64,${frame.jpeg}`} alt="Live page" draggable={false} /> : null;
  const loading = props.loading || (source === 'frames' && !props.image && !frame);

  return (
    <div className={'live' + (className ? ' ' + className : '')}>
      {!hideBar && (
        <div className="live-bar">
          <div className="live-address" title={props.address}><Icon name="lock" size={16} /><span className="ellipsis">{props.address}</span></div>
          {status}
          <div className="live-size"><Icon name="aspect_ratio" size={16} />{vp.width} × {vp.height}</div>
          {!hideZoom && (
            <div className="live-zoom" role="group" aria-label="Zoom">
              <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => setZoom(nextZoom(scale, -1))} disabled={scale <= 0.25}><Icon name="remove" size={18} /></button>
              <button type="button" className="live-pct" onClick={() => setZoom(zoom === 'fit' ? 1 : 'fit')}
                title={zoom === 'fit' ? 'Show at 100 %' : 'Fit to the window'} aria-label={zoom === 'fit' ? `Fit, ${pct} %. Show at 100 %` : `${pct} %. Fit to the window`}>{pct}%</button>
              <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => setZoom(nextZoom(scale, 1))} disabled={scale >= 1.5}><Icon name="add" size={18} /></button>
            </div>
          )}
        </div>
      )}
      <div className="live-pane" ref={paneRef} style={props.pad !== undefined ? { padding: pad } : undefined}>
        <div className="live-frame" ref={frameRef} style={{ width: vp.width * scale, height: vp.height * scale }}>
          <div className="live-page" style={pageStyle}>
            {page}
            <div className="live-overlays" aria-hidden>
              {pointer.hover && <div className={'live-hover' + (pointer.pressed ? ' pressed' : '')} style={boxStyle(pointer.hover)} />}
              {markers.map((m, i) => <Marker key={i} m={m} />)}
              {candidate && <Candidate box={candidate} />}
              {pointer.preview}
              {overlay}
            </div>
            {thinking && (
              <div className="live-thinking-scrim">
                <div className="live-thinking" role="status"><span className="icon">auto_awesome</span>{thinking}</div>
              </div>
            )}
            {loading && <div className="live-loading"><Icon name="progress_activity" className="spin" />Opening the browser…</div>}
          </div>
          {tool !== 'none' && (
            <div className={'live-hit tool-' + tool + (pointer.hover ? ' on-target' : '')} aria-label="Live page. Click anything on the page to add a step."
              onPointerDown={pointer.down} onPointerMove={pointer.move} onPointerUp={pointer.up} onPointerLeave={pointer.leave}
              onWheel={source === 'frames' ? pointer.wheel : undefined} />
          )}
        </div>
      </div>
    </div>
  );
}

const boxStyle = (b: Box): CSSProperties => ({ left: b[0], top: b[1], width: b[2] - b[0], height: b[3] - b[1] });

function Marker({ m }: { m: LiveMarker }) {
  const icon = { locked: 'lock', failed: 'cancel', old: undefined, new: 'auto_fix_high' }[m.kind];
  return (
    <div className={'live-mark mark-' + m.kind} style={boxStyle(m.box)}>
      {m.kind === 'locked' && m.n !== undefined && <div className="live-mark-badge">{m.n}</div>}
      {m.label && <div className="live-mark-label">{icon && <span className="icon">{icon}</span>}{m.label}</div>}
    </div>
  );
}

function Candidate({ box }: { box: Box }) {
  return (
    <div className="live-candidate" style={boxStyle(box)}>
      <span className="dot tl" /><span className="dot br" />
    </div>
  );
}

// ---------- pointer handling ----------

interface PointerOpts {
  tool: LiveTool; scale: number; vp: Pick<Viewport, 'width' | 'height'>; source: 'frames' | 'sample';
  frameRef: React.RefObject<HTMLDivElement | null>;
  onPoint?: (p: Point) => void; onDrag?: (from: Point, to: Point) => void; onBox?: (box: Box | null, at: Point) => void;
}

/** A press that moves less than this (viewport px) counts as a click. */
const CLICK_SLOP = 6;

function usePagePointer({ tool, scale, vp, frameRef, source, onPoint, onDrag, onBox }: PointerOpts) {
  const [start, setStart] = useState<Point | null>(null);      // pointer is down here
  const [now, setNow] = useState<Point | null>(null);
  const [pending, setPending] = useState<Point | null>(null);  // drag tool: first of two clicks
  const [hover, setHover] = useState<Box | null>(null);
  const wheelAcc = useRef<{ dx: number; dy: number; at: Point } | null>(null);

  useEffect(() => { setPending(null); setStart(null); }, [tool]);
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPending(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending]);

  const at = (e: { clientX: number; clientY: number }): Point => {
    const r = frameRef.current!.getBoundingClientRect();
    return toViewport({ x: e.clientX - r.left, y: e.clientY - r.top }, scale, vp);
  };

  const down = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const p = at(e); setStart(p); setNow(p);
  };
  const move = (e: ReactPointerEvent) => {
    const p = at(e);
    if (start) setNow(p);
    if (tool === 'point' && source === 'sample' && !start) {
      const t = demoEngine()?.targets.find(x => x.visible() && inside(p, x.box));
      const b = t?.box ?? null;
      setHover(h => (h === b || (h && b && h.join() === b.join()) ? h : b));
    }
  };
  const up = (e: ReactPointerEvent) => {
    if (!start) return;
    const p = at(e); const s = start;
    setStart(null); setNow(null);
    setHover(null);                        // the page usually changes; the next move finds the new target
    const click = distance(s, p) < CLICK_SLOP;
    if (tool === 'point') onPoint?.(s);
    else if (tool === 'box') onBox?.(click ? null : normBox(s, p), click ? s : p);
    else if (tool === 'drag') {
      if (!click) { setPending(null); onDrag?.(s, p); }
      else if (pending) { onDrag?.(pending, s); setPending(null); }
      else setPending(s);
    }
  };
  const leave = () => { if (!start) setHover(null); };
  const wheel = (e: React.WheelEvent) => {
    const p = at(e);
    const acc = wheelAcc.current ?? { dx: 0, dy: 0, at: p };
    acc.dx += e.deltaX; acc.dy += e.deltaY; acc.at = p;
    if (!wheelAcc.current) {
      wheelAcc.current = acc;
      requestAnimationFrame(() => {
        const a = wheelAcc.current; wheelAcc.current = null;
        if (a) void getEngine().pointer('scroll', a.at, Math.round(a.dx), Math.round(a.dy));
      });
    }
  };

  let preview: ReactNode = null;
  if (tool === 'box' && start && now && distance(start, now) >= CLICK_SLOP) preview = <div className="live-drawbox" style={boxStyle(normBox(start, now))} />;
  if (tool === 'drag' && (pending || (start && now && distance(start, now) >= CLICK_SLOP))) {
    const a = start && now && distance(start, now) >= CLICK_SLOP ? start : pending!;
    const b = start && now && distance(start, now) >= CLICK_SLOP ? now : null;
    preview = (
      <svg className="live-dragline" viewBox={`0 0 ${vp.width} ${vp.height}`} width={vp.width} height={vp.height}>
        {b && <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />}
        <circle cx={a[0]} cy={a[1]} r={9} />
        {b && <circle cx={b[0]} cy={b[1]} r={6} className="end" />}
      </svg>
    );
  }
  // Pressed on a target: the highlight answers on pointer-down; the step is added on release.
  return { down, move, up, leave, wheel, hover: tool === 'point' ? hover : null, pressed: tool === 'point' && !!start, preview };
}

// ---------- browser-bar pills ----------

/** "Checking the screen…" with the sweeping radar icon and pulsing text. */
export function CheckingPill({ text = 'Checking the screen…' }: { text?: string }) {
  return <div className="live-pill live-checking" role="status"><span className="icon sweep">radar</span><span className="anim-pulse">{text}</span></div>;
}
/** Green pill that pops in, e.g. "Step 5 saved". */
export function SavedPill({ text }: { text: string }) {
  return <div className="live-pill live-saved" role="status"><Icon name="check_circle" size={16} />{text}</div>;
}
