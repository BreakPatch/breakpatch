// Small reusable pieces built on the base components: times, result chips,
// filter chips, search, screen sizes and a confirm dialog.
import { useState, type ReactNode } from 'react';
import { Button, Dialog, Icon, Menu, statusInfo, TextInput, type Status } from '../ui';
import type { Viewport } from '../../data/types';
import { flakyWord, type Flakiness } from '../../lib/flaky';
import { DEVICES, deviceViewport } from '../../data/devices';
import { formatDateTime, formatDay, formatUpdated, formatWhen, sizeLabel, type ResultCounts } from './format';
import './common.css';

export * from './format';
export * from './runs';

// ---------- Time ----------
const KINDS = { when: formatWhen, day: formatDay, updated: formatUpdated, dateTime: formatDateTime };
/** A timestamp in plain words ("Today, 14:52"), with the full date on hover. */
export function RelativeTime({ ts, kind = 'when', className }: { ts: number; kind?: keyof typeof KINDS; className?: string }) {
  const d = new Date(ts);
  return <time className={className} dateTime={d.toISOString()} title={d.toLocaleString()}>{KINDS[kind](ts)}</time>;
}

// ---------- Result chips ----------
const CHIP_ORDER: { key: keyof ResultCounts; status: Status; word: string }[] = [
  { key: 'passed', status: 'passed', word: 'passed' },
  { key: 'fixed', status: 'fixed', word: 'fixed' },
  { key: 'failed', status: 'failed', word: 'failed' },
];
/** "9 passed" "1 fixed" "1 failed" tinted pills, or "Never run" when nothing has run. */
export function ResultChips({ counts }: { counts: ResultCounts }) {
  const shown = CHIP_ORDER.filter(c => counts[c.key] > 0);
  if (!shown.length) return <div className="cm-chips"><span className="pill pill-neutral cm-chip"><Icon name="radio_button_unchecked" />Never run</span></div>;
  return (
    <div className="cm-chips">
      {shown.map(c => {
        const s = statusInfo(c.status);
        return <span key={c.key} className={`pill ${s.cls} cm-chip`}><Icon name={s.icon} />{counts[c.key]} {c.word}</span>;
      })}
    </div>
  );
}
/** The same counts as quiet icon + text, for toolbars. */
export function ResultTally({ counts }: { counts: ResultCounts }) {
  const shown = CHIP_ORDER.filter(c => counts[c.key] > 0);
  return (
    <div className="cm-tally" aria-label="Last results">
      {shown.map(c => {
        const s = statusInfo(c.status);
        return <span key={c.key}><Icon name={s.icon} style={{ color: s.color }} />{counts[c.key]} {c.word}</span>;
      })}
    </div>
  );
}

// ---------- Filter chip ----------
export interface FilterOption<T extends string> { value: T; label: string }
/** "Shared: all ▾" chip that opens a small menu. The first option is the "all" value. */
export function FilterChip<T extends string>({ name, value, options, onChange, allLabel }: {
  name?: string; value: T; options: FilterOption<T>[]; onChange: (v: T) => void; allLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const cur = options.find(o => o.value === value) ?? options[0];
  const isAll = cur === options[0];
  const text = name ? `${name}: ${isAll && allLabel ? allLabel : cur.label}` : cur.label;
  return (
    <div className="cm-rel">
      <button type="button" className={`chip-filter cm-filter${isAll ? '' : ' active'}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        {text}<Icon name="expand_more" />
      </button>
      <Menu open={open} onClose={() => setOpen(false)} label={name ?? 'Filter'} width={220} style={{ top: 'calc(100% + 6px)', left: 0 }}
        items={options.map(o => ({ label: o.label, icon: o.value === value ? 'radio_button_checked' : 'radio_button_unchecked', onSelect: () => onChange(o.value) }))} />
    </div>
  );
}

// ---------- Search ----------
export function SearchBox({ value, onChange, placeholder, width = 280 }: { value: string; onChange: (v: string) => void; placeholder: string; width?: number }) {
  return (
    <div className="cm-search" style={{ width }}>
      <TextInput leadIcon="search" value={value} placeholder={placeholder} aria-label={placeholder} onChange={e => onChange(e.target.value)}
        onKeyDown={e => { if (e.key === 'Escape' && value) { e.stopPropagation(); onChange(''); } }} />
    </div>
  );
}

// ---------- Screen sizes ----------
/** Computer screens: the page as a desktop browser shows it, with a mouse. */
export const SCREEN_SIZES: { name: string; viewport: Viewport }[] = [
  { name: 'Laptop', viewport: { width: 1440, height: 900, dpr: 1 } },
  { name: 'Desktop', viewport: { width: 1920, height: 1080, dpr: 1 } },
  { name: 'Small screen', viewport: { width: 1024, height: 768, dpr: 1 } },
];
/**
 * A computer screen size, or a phone or tablet (data/devices.ts): its size, its user agent and a
 * touch screen. A device that this app doesn't know (a test from a newer app) shows no choice on.
 */
export function SizePicker({ value, onChange, label = 'Screen size' }: { value: Viewport; onChange: (v: Viewport) => void; label?: string }) {
  return (
    <div className="cm-sizes-wrap" role="radiogroup" aria-label={label}>
      <div className="cm-sizes">
        {SCREEN_SIZES.map(s => {
          const on = !value.device && s.viewport.width === value.width && s.viewport.height === value.height;
          return (
            <button key={s.name} type="button" role="radio" aria-checked={on} className="cm-size" onClick={() => onChange(s.viewport)}>
              <span className="cm-size-name">{s.name}</span><span className="cm-size-px">{sizeLabel(s.viewport)}</span>
            </button>
          );
        })}
      </div>
      <div className="cm-sizes-title" id="cm-devices">Phones and tablets, with a touch screen</div>
      <div className="cm-sizes cm-devices" role="group" aria-labelledby="cm-devices">
        {DEVICES.map(d => {
          const on = value.device === d.id;
          return (
            <button key={d.id} type="button" role="radio" aria-checked={on} className="cm-size cm-device" onClick={() => onChange(deviceViewport(d))}>
              <span className="cm-size-name"><Icon name="smartphone" size={16} />{d.name}</span>
              <span className="cm-size-px">{sizeLabel(d)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Confirm ----------
/** "Delete …?" style confirmation. `danger` makes the confirm button red. */
export function ConfirmDialog({ open, onClose, onConfirm, title, children, confirmLabel, danger, icon }: {
  open: boolean; onClose: () => void; onConfirm: () => Promise<void> | void; title: ReactNode; children?: ReactNode; confirmLabel: string; danger?: boolean; icon?: string;
}) {
  const [busy, setBusy] = useState(false);
  const go = async () => { setBusy(true); try { await onConfirm(); onClose(); } finally { setBusy(false); } };
  return (
    <Dialog open={open} onClose={onClose} title={title} width={480} icon={icon ?? (danger ? 'delete' : undefined)} iconColor={danger ? 'var(--failed)' : undefined}
      actions={<><Button onClick={onClose} data-autofocus={danger || undefined}>Cancel</Button><Button kind={danger ? 'danger' : 'primary'} busy={busy} onClick={go}>{confirmLabel}</Button></>}>
      {children && <div className="cm-confirm-text">{children}</div>}
    </Dialog>
  );
}

export { ImpactDialog, impactSummary } from './ImpactDialog';
export { useMoveToBin, RECENTLY_DELETED_PATH } from './moveToBin';

// ---------- Flaky ----------
/**
 * The Flaky marker (lib/flaky.ts): an icon and the word, with why on hover and for screen readers.
 * "Known flaky" once someone said so, quieter.
 */
export function FlakyChip({ f, className }: { f: Flakiness; className?: string }) {
  if (!f.flaky) return null;
  const word = flakyWord(f);
  return (
    <span className={`cm-flaky${f.known ? ' known' : ''}${className ? ` ${className}` : ''}`} title={f.why || undefined} aria-label={f.why ? `${word}. ${f.why}` : word} role="note">
      <Icon name="swap_vert" size={14} />{word}
    </span>
  );
}
