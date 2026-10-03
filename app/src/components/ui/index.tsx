// Base components. Keep screens on these so the look stays in one place.
import {
  createContext, useCallback, useContext, useEffect, useId, useRef, useState,
  type ButtonHTMLAttributes, type CSSProperties, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { copyText } from '../../platform';
import { usePresence } from './presence';
import './ui.css';

const cx = (...c: unknown[]) => c.filter(x => typeof x === 'string' && x).join(' ');

// ---------- Icon ----------
export function Icon({ name, size, style, className, label, fill }: { name: string; size?: number; style?: CSSProperties; className?: string; label?: string; fill?: boolean }) {
  return (
    <span className={cx('icon', className)} style={{ fontSize: size, fontVariationSettings: fill ? "'FILL' 1" : undefined, ...style }}
      aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label}>{name}</span>
  );
}
export function Spinner({ size = 18, color = 'var(--running)' }: { size?: number; color?: string }) {
  return <Icon name="progress_activity" size={size} className="spin" style={{ color }} label="Working" />;
}

// ---------- Buttons ----------
type BtnKind = 'primary' | 'secondary' | 'link' | 'danger' | 'dangerText' | 'ghost';
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> { kind?: BtnKind; icon?: string; iconAfter?: string; size?: 'sm' | 'md' | 'lg'; busy?: boolean }
export function Button({ kind = 'secondary', icon, iconAfter, size = 'md', busy, className, children, disabled, type = 'button', ...rest }: ButtonProps) {
  return (
    <button type={type} className={cx('btn', `btn-${kind}`, size !== 'md' && `btn-${size}`, className)} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy ? <Icon name="progress_activity" className="spin" /> : icon && <Icon name={icon} />}
      {children}
      {iconAfter && <Icon name={iconAfter} />}
    </button>
  );
}
export function IconButton({ icon, label, bordered, className, size, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: string; label: string; bordered?: boolean; size?: number }) {
  return (
    <button type="button" className={cx('icon-btn', bordered && 'bordered', className)} aria-label={label} title={label} {...rest}>
      <Icon name={icon} size={size} />
    </button>
  );
}

// ---------- Fields ----------
export function Field({ label, hint, error, children, htmlFor, style }: { label?: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; htmlFor?: string; style?: CSSProperties }) {
  return (
    <div className="field" style={style}>
      {label && <label className="field-label" htmlFor={htmlFor}>{label}</label>}
      {children}
      {error ? <div className="field-error" role="alert"><Icon name="error" />{error}</div> : hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}
export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> { label?: ReactNode; hint?: ReactNode; error?: ReactNode; mono?: boolean; leadIcon?: string }
export function TextInput({ label, hint, error, mono, leadIcon, className, id, ...rest }: TextInputProps) {
  const auto = useId(); const iid = id ?? auto;
  const input = <input id={iid} className={cx('input', mono && 'mono', error && 'invalid', leadIcon && 'has-lead', className)} aria-invalid={!!error || undefined} {...rest} />;
  const body = leadIcon ? <div className="input-wrap"><Icon name={leadIcon} className="lead" />{input}</div> : input;
  if (!label && !hint && !error) return body;
  return <Field label={label} hint={hint} error={error} htmlFor={iid}>{body}</Field>;
}
export function TextArea({ label, hint, error, mono, className, id, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: ReactNode; hint?: ReactNode; error?: ReactNode; mono?: boolean }) {
  const auto = useId(); const iid = id ?? auto;
  const el = <textarea id={iid} className={cx('input', mono && 'mono', error && 'invalid', className)} {...rest} />;
  if (!label && !hint && !error) return el;
  return <Field label={label} hint={hint} error={error} htmlFor={iid}>{el}</Field>;
}
export function Select({ label, hint, options, className, id, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { label?: ReactNode; hint?: ReactNode; options: { value: string; label: string }[] }) {
  const auto = useId(); const iid = id ?? auto;
  const el = (
    <div className="select-wrap">
      <select id={iid} className={cx('input', className)} {...rest}>{options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
      <Icon name="expand_more" />
    </div>
  );
  if (!label && !hint) return el;
  return <Field label={label} hint={hint} htmlFor={iid}>{el}</Field>;
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" className="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} />;
}
/**
 * A checkbox with its label shown beside it; the label is clickable too. `hideLabel` only where
 * the same words are already on screen next to it (a list row's name), so they aren't said twice.
 * The box's click is preventDefault()ed: unticking removes the tick icon that was clicked, and the
 * label, no longer seeing the click inside its box, would click the box again and tick it back.
 */
export function Checkbox({ checked, onChange, label, hideLabel }: { checked: boolean; onChange: (v: boolean) => void; label: string; hideLabel?: boolean }) {
  const box = (
    <button type="button" role="checkbox" className="checkbox" aria-checked={checked} aria-label={label} onClick={e => { e.preventDefault(); onChange(!checked); }}>
      {checked && <Icon name="check" />}
    </button>
  );
  if (hideLabel) return box;
  return <label className="checkbox-row">{box}<span className="checkbox-label">{label}</span></label>;
}

// ---------- Status ----------
export type Status = 'passed' | 'fixed' | 'failed' | 'running' | 'never' | 'waiting' | 'notRun' | 'replaced' | 'passedWithFixes' | 'offline' | 'paused';
const STATUS: Record<Status, { icon: string; word: string; cls: string; color: string }> = {
  passed: { icon: 'check_circle', word: 'Passed', cls: 'pill-passed', color: 'var(--passed)' },
  fixed: { icon: 'auto_fix_high', word: 'Fixed automatically', cls: 'pill-fixed', color: 'var(--fixed)' },
  passedWithFixes: { icon: 'auto_fix_high', word: 'Passed with fixes', cls: 'pill-fixed', color: 'var(--fixed)' },
  failed: { icon: 'cancel', word: 'Failed', cls: 'pill-failed', color: 'var(--failed)' },
  running: { icon: 'progress_activity', word: 'Running', cls: 'pill-running', color: 'var(--running)' },
  never: { icon: 'radio_button_unchecked', word: 'Never run', cls: 'pill-neutral', color: 'var(--text-faint)' },
  waiting: { icon: 'schedule', word: 'Waiting', cls: 'pill-neutral', color: 'var(--text-faint)' },
  notRun: { icon: 'block', word: 'Not run', cls: 'pill-neutral', color: 'var(--text-faint)' },
  replaced: { icon: 'block', word: 'Replaced', cls: 'pill-neutral', color: 'var(--text-faint)' },
  offline: { icon: 'cloud_off', word: 'Offline', cls: 'pill-failed', color: 'var(--failed)' },
  paused: { icon: 'pause_circle', word: 'Paused', cls: 'pill-fixed', color: 'var(--fixed)' },
};
export function statusInfo(s: Status) { return STATUS[s]; }
/** Tinted pill: icon + word, never colour alone. */
export function StatusPill({ status, children, style }: { status: Status; children?: ReactNode; style?: CSSProperties }) {
  const s = STATUS[status];
  return <span className={cx('pill', s.cls)} style={style}><Icon name={s.icon} className={status === 'running' ? 'spin' : undefined} />{children ?? s.word}</span>;
}
/** Icon + word without the pill (tables). */
export function StatusText({ status, children, size = 18 }: { status: Status; children?: ReactNode; size?: number }) {
  const s = STATUS[status];
  return <span className="row" style={{ gap: 6 }}><Icon name={s.icon} size={size} className={status === 'running' ? 'spin' : undefined} style={{ color: s.color }} /><span>{children ?? s.word}</span></span>;
}
export function SharedChip({ published }: { published: boolean }) {
  return published
    ? <span className="chip-shared chip-team"><Icon name="groups" />In team suite</span>
    : <span className="chip-shared chip-you"><Icon name="person" />Only you</span>;
}

// ---------- Navigation ----------
export function Segmented<T extends string>({ items, value, onChange, label }: { items: { value: T; label: ReactNode; dot?: string }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="tablist" aria-label={label}>
      {items.map(i => (
        <button key={i.value} role="tab" aria-selected={i.value === value} onClick={() => onChange(i.value)}>
          {i.label}{i.dot && <span className="nav-dot" style={{ background: i.dot }} aria-hidden />}
        </button>
      ))}
    </div>
  );
}
export function Tabs<T extends string>({ items, value, onChange, label }: { items: { value: T; label: ReactNode }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {items.map(i => <button key={i.value} role="tab" aria-selected={i.value === value} onClick={() => onChange(i.value)}>{i.label}</button>)}
    </div>
  );
}

// ---------- Dialog ----------
/**
 * Modal dialog. Focus starts on the first field, or on `[data-autofocus]` when there is one: a
 * confirmation that deletes something marks its Cancel button so Enter never deletes by accident.
 */
/** `stays`: Esc and a click outside don't close it (a dialog whose closing loses something for good);
 *  only its own buttons and ✕ (onClose) do. */
export function Dialog({ open, onClose, title, sub, children, actions, width = 520, contained, icon, iconColor, labelledBy, stays }: {
  open: boolean; onClose: () => void; title?: ReactNode; sub?: ReactNode; children?: ReactNode; actions?: ReactNode; width?: number; contained?: boolean; icon?: string; iconColor?: string; labelledBy?: string; stays?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const tid = useId();
  const { mounted, closing } = usePresence(open);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>('input, textarea, select, button:not([data-close])');
    (first ?? el)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); if (!stays) onClose(); }
      if (e.key === 'Tab' && el) {
        const f = [...el.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(x => !x.hasAttribute('disabled'));
        if (!f.length) return;
        const [a, z] = [f[0], f[f.length - 1]];
        if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
        else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('keydown', onKey, true); prev?.focus?.(); };
  }, [open, onClose, stays]);
  if (!mounted) return null;
  const body = (
    <div className={cx('scrim', contained && 'contained', closing && 'closing')} aria-hidden={closing || undefined} inert={closing || undefined}
      onMouseDown={e => { if (open && !stays && e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className={cx('dialog', closing && 'closing')} role="dialog" aria-modal="true" aria-labelledby={labelledBy ?? (title ? tid : undefined)} style={{ width }} tabIndex={-1}>
        {title && (
          <div className="dialog-head">
            <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
              {icon && <Icon name={icon} size={26} style={{ color: iconColor ?? 'var(--accent)', marginTop: 1 }} />}
              <div><div className="dialog-title" id={tid}>{title}</div>{sub && <div className="dialog-sub">{sub}</div>}</div>
            </div>
            <IconButton icon="close" label="Close" onClick={onClose} data-close />
          </div>
        )}
        {children}
        {actions && <div className="dialog-actions">{actions}</div>}
      </div>
    </div>
  );
  return contained ? body : createPortal(body, document.body);
}

// ---------- Menu ----------
/** `checked` makes it one of a set of choices (menuitemradio), ticked when true. */
/** `detail`: a second, smaller line, such as why it's disabled. */
export interface MenuItem { label: string; icon?: string; onSelect: () => void; danger?: boolean; disabled?: boolean; checked?: boolean; detail?: string }
export type MenuEntry = MenuItem | { group: string } | 'sep';
/** Pop-up menu with keyboard navigation. Place inside a `position: relative` wrapper. */
export function Menu({ open, onClose, items, style, width = 240, label }: { open: boolean; onClose: () => void; items: MenuEntry[]; style?: CSSProperties; width?: number; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const { mounted, closing } = usePresence(open);
  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    const prev = document.activeElement as HTMLElement | null;
    (el?.querySelector<HTMLElement>('[aria-checked="true"]') ?? el?.querySelector<HTMLElement>('[role^="menuitem"]'))?.focus();
    const onDown = (e: MouseEvent) => { if (el && !el.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => {
      if (!el) return;
      const list = [...el.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])')];
      const i = list.indexOf(document.activeElement as HTMLElement);
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
      else if (e.key === 'Home') { e.preventDefault(); list[0]?.focus(); }
      else if (e.key === 'End') { e.preventDefault(); list[list.length - 1]?.focus(); }
    };
    // Listen from the next tick so the click that opened the menu doesn't close it; cleared if the
    // menu closes first, so a stale listener never outlives it.
    const t = setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    document.addEventListener('keydown', onKey, true);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true);
      // Closed from the keyboard or by picking an item: focus goes back to the button that opened it.
      // (By now the menu may be gone, taking focus with it to <body>.) A click elsewhere keeps its focus.
      const a = document.activeElement;
      if (!a || a === document.body || el?.contains(a)) prev?.focus?.();
    };
  }, [open, onClose]);
  if (!mounted) return null;
  return (
    <div ref={ref} className={cx('menu', closing && 'closing')} role="menu" aria-label={label} aria-hidden={closing || undefined} inert={closing || undefined}
      style={{ width, transformOrigin: originFor(style), ...style }}>
      {items.map((it, k) => it === 'sep' ? <div key={k} className="menu-sep" role="separator" />
        : 'group' in it ? <div key={k} className="menu-group">{it.group}</div>
        : <button key={k} type="button" role={it.checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={it.checked} className={cx('menu-item', it.danger && 'danger')} disabled={it.disabled}
            onClick={() => { if (!open) return; onClose(); it.onSelect(); }}>
            {it.icon && <Icon name={it.icon} />}
            {it.detail ? <span className="menu-text"><span>{it.label}</span><span className="menu-detail">{it.detail}</span></span>
              : it.checked === undefined ? it.label : <span className="grow">{it.label}</span>}
            {it.checked && <Icon name="check" className="menu-check" />}
          </button>)}
    </div>
  );
}

/**
 * A choice shown as a chip (or a field) that opens the app's own menu of choices, anchored to it
 * and growing from its corner (DES-14). Keyboard: Enter, Space or Down opens it; the arrows move;
 * Enter picks; Esc closes and focus goes back to the chip.
 */
export function ChipSelect<T extends string>({ id, value, options, onChange, label, className, up, width = 260, disabled, field }: {
  id?: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void;
  /** What it chooses, for screen readers when no <label> points at it. */
  label?: string; className?: string;
  /** Opens upward (a chip near the bottom of the window). */
  up?: boolean; width?: number; disabled?: boolean;
  /** Drawn as a full-width form field instead of a chip. */
  field?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const cur = options.find(o => o.value === value);
  return (
    <span className={cx('chip-select', field && 'field-like')}>
      <button id={id} type="button" className={cx('chip-select-btn', field && 'input', className)} aria-haspopup="menu" aria-expanded={open} aria-label={label ? `${label}: ${cur?.label ?? ''}` : undefined}
        disabled={disabled} onClick={() => setOpen(o => !o)} onKeyDown={e => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true); } }}>
        <span className="chip-select-text">{cur?.label ?? ''}</span><Icon name="expand_more" size={16} />
      </button>
      <Menu open={open} onClose={() => setOpen(false)} label={label ?? 'Choices'} width={width}
        style={up ? { left: 0, bottom: 'calc(100% + 4px)' } : { left: 0, top: 'calc(100% + 4px)' }}
        items={options.map(o => ({ label: o.label, checked: o.value === value, onSelect: () => onChange(o.value) }))} />
    </span>
  );
}

/** The menu's corner nearest its trigger, from how it's placed: `bottom` opens upward, `right` aligns right. */
function originFor(style?: CSSProperties) {
  const v = style?.bottom !== undefined && style?.top === undefined ? 'bottom' : 'top';
  const h = style?.right !== undefined && style?.left === undefined ? 'right' : 'left';
  return `${v} ${h}`;
}

// ---------- Banner ----------
export function Banner({ tone, icon, title, children, actions }: { tone: 'accent' | 'fixed' | 'failed' | 'running'; icon: string; title: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className={cx('banner', `banner-${tone}`)} role="status">
      <Icon name={icon} />
      <div className="grow row" style={{ gap: 8, flexWrap: 'wrap' }}><span className="banner-title">{title}</span>{children && <span className="banner-text">{children}</span>}</div>
      {actions && <div className="row" style={{ gap: 8 }}>{actions}</div>}
    </div>
  );
}

// ---------- Toasts ----------
/** A button in a toast, such as Undo. Pressing it also closes the toast. */
export interface ToastAction { label: string; onClick: () => void }
export interface ToastOptions { error?: boolean; actions?: ToastAction[] }
interface ToastItem { id: number; text: string; error?: boolean; actions?: ToastAction[]; leaving?: boolean }
/** How long a toast stays: longer when it has buttons, so there's time to press one. */
export const TOAST_MS = 2400;
export const TOAST_ACTIONS_MS = 8000;
const TOAST_OUT_MS = 180;
const ToastCtx = createContext<(text: string, opts?: ToastOptions) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const remove = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    setItems(x => x.map(t => (t.id === id ? { ...t, leaving: true } : t)));
    timers.current.set(id, setTimeout(() => { timers.current.delete(id); setItems(x => x.filter(t => t.id !== id)); }, TOAST_OUT_MS));
  }, []);
  const later = useCallback((id: number, ms: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.set(id, setTimeout(() => remove(id), ms));
  }, [remove]);
  const push = useCallback((text: string, opts?: ToastOptions) => {
    const id = Date.now() + Math.random();
    setItems(x => [...x, { id, text, error: opts?.error, actions: opts?.actions }]);
    later(id, opts?.actions?.length ? TOAST_ACTIONS_MS : TOAST_MS);
  }, [later]);
  useEffect(() => { const t = timers.current; return () => t.forEach(clearTimeout); }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map(t => (
          // While the pointer or focus is on a toast with buttons, it stays; it goes a moment after.
          <div key={t.id} className={cx('toast', t.error && 'error', t.leaving && 'leaving')}
            onMouseEnter={t.actions && !t.leaving ? () => clearTimeout(timers.current.get(t.id)) : undefined}
            onMouseLeave={t.actions && !t.leaving ? () => later(t.id, TOAST_MS) : undefined}
            onFocus={t.actions && !t.leaving ? () => clearTimeout(timers.current.get(t.id)) : undefined}
            onBlur={t.actions && !t.leaving ? () => later(t.id, TOAST_MS) : undefined}>
            <Icon name={t.error ? 'error' : 'check_circle'} />
            <span className="toast-text">{t.text}</span>
            {t.actions?.map(a => (
              <button key={a.label} type="button" className="toast-action" onClick={() => { remove(t.id); a.onClick(); }}>{a.label}</button>
            ))}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export function useToast() { return useContext(ToastCtx); }

// ---------- Progress, skeleton, avatar ----------
export function ProgressBar({ value, tone, label, style }: { value: number; tone?: 'running' | 'passed' | 'failed'; label?: string; style?: CSSProperties }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return <div className={cx('progress', tone)} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={label} style={style}><div style={{ transform: `scaleX(${pct / 100})` }} /></div>;
}
export function Skeleton({ w = '100%', h = 14, r, style }: { w?: number | string; h?: number | string; r?: number; style?: CSSProperties }) {
  return <div className="skeleton" style={{ width: w, height: h, borderRadius: r, ...style }} aria-hidden />;
}
export function initials(name: string) { return name.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]!.toUpperCase()).join(''); }
export function Avatar({ name, size = 32, onClick, title }: { name: string; size?: number; onClick?: () => void; title?: string }) {
  const style = { width: size, height: size, fontSize: size < 30 ? 11 : 12 };
  return onClick
    ? <button type="button" className="avatar" style={style} onClick={onClick} title={title} aria-label={title ?? name}>{initials(name)}</button>
    : <span className="avatar" style={style} aria-hidden>{initials(name)}</span>;
}
export function Disc({ icon, size = 44, iconSize, color, bg, style }: { icon: string; size?: number; iconSize?: number; color?: string; bg?: string; style?: CSSProperties }) {
  return <span className="disc" style={{ width: size, height: size, background: bg, ...style }}><Icon name={icon} size={iconSize ?? Math.round(size / 2)} style={{ color }} /></span>;
}

// ---------- Empty state ----------
export function EmptyState({ icon, title, text, action }: { icon: string; title: ReactNode; text: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <Disc icon={icon} size={72} iconSize={34} />
      <div className="empty-title">{title}</div>
      <div className="empty-text">{text}</div>
      {action}
    </div>
  );
}

// ---------- Brand ----------
/** The folded dog ear: radii 55% 12% 55% 55% of its size, rotated −14°. */
export function EarMark({ size = 16, color }: { size?: number; color?: string }) {
  const big = Math.round(size * 0.55), small = Math.max(2, Math.round(size * 0.12));
  return <span className="ear" style={{ width: size, height: size, borderRadius: `${big}px ${small}px ${big}px ${big}px`, background: color }} aria-hidden />;
}
export function Wordmark({ size = 17, ear = true }: { size?: number; ear?: boolean }) {
  return (
    <span className="row" style={{ gap: Math.round(size * 0.4) }} aria-label="breakpatch">
      {ear && <EarMark size={Math.round(size * 0.95)} />}
      <span className="wordmark" style={{ fontSize: size }}><b>break</b><span>patch</span></span>
    </span>
  );
}

// ---------- Copy button ----------
export function CopyButton({ text, label = 'Copy', copiedLabel = 'Copied', kind = 'secondary', size = 'sm', onCopy }: { text: string | (() => string); label?: string; copiedLabel?: string; kind?: BtnKind; size?: 'sm' | 'md' | 'lg'; onCopy?: (t: string) => Promise<void> | void }) {
  const [done, setDone] = useState(false);
  useEffect(() => { if (!done) return; const t = setTimeout(() => setDone(false), 1600); return () => clearTimeout(t); }, [done]);
  return (
    <Button kind={kind} size={size} icon={done ? 'check' : 'content_copy'} onClick={async () => {
      const v = typeof text === 'function' ? text() : text;
      await (onCopy ? onCopy(v) : copyText(v)); setDone(true);
    }}>{done ? copiedLabel : label}</Button>
  );
}
