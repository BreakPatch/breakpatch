// Add step bar under the browser (README "Add step bar"): hint row, AI result / not found
// bars, the composer (describe box + action button + send), and action-specific inputs.
// Clicking the page and describing are always both available: no mode switch.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Direction, Generated, SampleFile, StepGroup } from '../../data/types';
import { secrets } from '../../platform';
import { actionInfo, GENERATED_CHOICES, SAMPLES } from '../../engine/labels';
import { countRows, findStep, TOKENS, numberOf } from '../../components/steps';
import { Button, ChipSelect, Icon } from '../../components/ui';
import { useLatched, usePresence } from '../../components/ui/presence';
import { ActionMenu } from './ActionMenu';
import { SharedStepsPicker } from './SharedStepsPicker';
import { composerInput, INSTANT, placeholderFor, shortName, toolHint, type MenuAction } from './actions';
import type { Recorder } from './useRecorder';

const CLICK_FAMILY = new Set(['click', 'doubleClick', 'longClick', 'rightClick', 'hover']);
const FILE_TYPES = [['', 'Any type'], ['pdf', 'PDF'], ['csv', 'CSV'], ['xlsx', 'Excel sheet'], ['docx', 'Word document'], ['jpeg', 'JPEG image'], ['mp4', 'MP4 video']];

type FloatBanner = { text: string; tone?: 'ok' | 'bad'; icon?: string; action?: { label: string; onClick: () => void } };
const sameBanner = (a: FloatBanner, b: FloatBanner) => a.text === b.text && a.tone === b.tone && a.icon === b.icon && a.action?.label === b.action?.label;
const leaving = (closing: boolean) => closing ? { 'aria-hidden': true, inert: true } : {};

export function AddStepBar({ rec, appId, allowGroups, onInsertGroup, frozen, banner: bannerNow }: {
  rec: Recorder; appId: string; allowGroups: boolean; onInsertGroup: (g: StepGroup, version: number | 'latest') => void;
  /** Adding steps waits (the test is playing in this browser): says why. */
  frozen?: string | null;
  /** A line floating over the page ("Playing steps 1–9 first…", "You're using the page directly…"). */
  banner?: FloatBanner | null;
}) {
  const [menu, setMenu] = useState<'closed' | 'menu' | 'picker'>('closed');
  const [secretNames, setSecretNames] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const actionBtn = useRef<HTMLButtonElement>(null);
  const { action, options: o } = rec;
  const input = composerInput(action);
  const busy = rec.busy || rec.ai.state === 'thinking' || !!frozen;

  // The bar that asks "Click Next button?": Enter confirms, Esc cancels (not while typing in a field).
  const asking = rec.ai.state === 'result' || rec.ai.state === 'proposal';
  // The floating bars stay a moment after they're answered, so they can leave the way they came.
  const bannerP = usePresence(!!bannerNow), banner = useLatched(bannerNow, sameBanner);
  const askP = usePresence(asking), askAi = useLatched(asking ? rec.ai : null), askText = useLatched(asking ? rec.ask : null);
  const lostP = usePresence(rec.ai.state === 'notfound'), lostText = useLatched(rec.ai.state === 'notfound' ? rec.notFound : null);
  // Only a key pressed after the bar appeared answers it: the Enter that sent a sentence can show the
  // bar during its own keydown (typing, an address, a scroll are proposed at once), and must not
  // confirm it too. So the listener starts after that event, and a held key's repeats don't count.
  useEffect(() => {
    if (!asking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && (el as HTMLInputElement).value !== ''));
      if (e.key === 'Escape') { e.preventDefault(); rec.cancelAi(); }
      else if (e.key === 'Enter' && !typing && !(el?.tagName === 'BUTTON')) { e.preventDefault(); rec.confirmAi(); }
    };
    const start = setTimeout(() => window.addEventListener('keydown', onKey), 0);
    return () => { clearTimeout(start); window.removeEventListener('keydown', onKey); };
  }, [asking, rec]);

  useEffect(() => { void secrets.list().then(setSecretNames).catch(() => setSecretNames([])); }, []);
  // Try again on a described step: its sentence is back in the box, ready to change.
  useEffect(() => { if (rec.refocus) inputRef.current?.focus(); }, [rec.refocus]);
  useEffect(() => { if (action === 'write' && o.writeSource === 'secret' && !o.secretRef && secretNames[0]) rec.setOptions({ secretRef: secretNames[0] }); }, [action, o.writeSource, o.secretRef, secretNames, rec]);

  const closeMenu = () => { setMenu('closed'); actionBtn.current?.focus(); };
  const pick = (a: MenuAction) => {
    if (INSTANT.has(a.id)) {
      setMenu('closed');
      void rec.record(a.nav ? { action: 'navigate', nav: a.nav } : { action: a.kind });
      return;
    }
    if (a.kind === 'loop') { setMenu('closed'); rec.addLoop(); return; }
    rec.setAction(a.kind);
    if (a.kind === 'group') { setMenu('picker'); return; }
    setMenu('closed');
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const insertToken = (token: string) => {
    const el = inputRef.current;
    const t = rec.text;
    const a = el?.selectionStart ?? t.length, b = el?.selectionEnd ?? t.length;
    const sep = a > 0 && t[a - 1] !== ' ' ? ' ' : '';
    rec.setText(t.slice(0, a) + sep + token + t.slice(b));
    setTimeout(() => { el?.focus(); const p = a + sep.length + token.length; el?.setSelectionRange(p, p); }, 0);
  };

  // Hint row: re-record, then tool hints, then the open loop, else the default.
  const rr = rec.rerecordId ? findStep(rec.steps, rec.rerecordId) : undefined;
  const loop = rec.openLoopId ? findStep(rec.steps, rec.openLoopId) : undefined;
  let hint: ReactNode = <><Icon name="ads_click" size={16} className="rec-hint-icon" />Click anything on the page to add a step, or describe it below.</>;
  const th = toolHint(action);
  if (rr) hint = <><Icon name="replay" size={16} className="rec-hint-icon" /><span className="grow">Do step {numberOf(rec.steps, rr.id)} again on the page, or describe it. It replaces "{rr.label}".</span><button type="button" className="rec-hint-link" onClick={rec.cancelRerecord}>Cancel</button></>;
  else if (th) hint = <><Icon name={actionInfo(action).icon} size={16} className="rec-hint-icon" />{th}</>;
  else if (loop) hint = <><Icon name="repeat" size={16} className="rec-hint-icon" />New steps go inside "{loop.label}" until you press Done repeating.</>;

  let field: ReactNode;
  if (action === 'write' && o.writeSource === 'secret') {
    field = (
      <span className="rec-field-chip">
        <ChipSelect label="Saved secret" up value={o.secretRef} onChange={v => rec.setOptions({ secretRef: v })}
          options={secretNames.length ? secretNames.map(n => ({ value: n, label: n })) : [{ value: '', label: 'No saved secrets on this Mac' }]} />
      </span>
    );
  } else if (action === 'write' && o.writeSource === 'generated') {
    field = (
      <span className="rec-field-chip">
        <ChipSelect<Generated> label="Generated value" up value={o.generated} onChange={v => rec.setOptions({ generated: v })} options={GENERATED_CHOICES} />
      </span>
    );
  } else if (input !== 'none') {
    field = (
      <input ref={inputRef} className={'rec-input' + (input === 'url' ? ' mono' : '')} value={rec.text} placeholder={placeholderFor(action)}
        aria-label={input === 'describe' ? 'Describe the next step' : input === 'url' ? 'Address' : 'Text to write'}
        onChange={e => rec.setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); rec.send(); } }} />
    );
  } else if (action === 'waitFor') {
    field = <label className="rec-inline">Wait<NumberBox value={o.seconds} min={1} max={600} label="Seconds" onChange={v => rec.setOptions({ seconds: v })} onEnter={rec.send} />seconds</label>;
  } else if (action === 'downloadCheck') {
    field = (
      <label className="rec-inline">Check a file downloaded, of type
        <select className="rec-mini-select" value={o.fileType} onChange={e => rec.setOptions({ fileType: e.target.value })} aria-label="File type">
          {FILE_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
    );
  } else if (action === 'group') {
    field = <span className="rec-inline faint">Pick shared steps from the list.</span>;
  } else {
    field = <span className="rec-inline faint">{action === 'drag' ? 'Drag on the page from the start point to the end point.' : placeholderFor(action)}</span>;
  }

  const extra = extraRow();
  function extraRow(): ReactNode {
    if (action === 'write') return (
      <div className="rec-extra">
        <div className="rec-chips" role="radiogroup" aria-label="What to write">
          {([['typed', 'Typed text'], ['secret', 'Saved secret'], ['generated', 'Generated']] as const).map(([v, l]) => (
            <button key={v} type="button" role="radio" aria-checked={o.writeSource === v} className={'rec-chip' + (o.writeSource === v ? ' on' : '')} onClick={() => rec.setOptions({ writeSource: v })}>{l}</button>
          ))}
        </div>
        {o.writeSource === 'typed' && (
          <div className="rec-chips"><span className="faint">Insert:</span>
            {TOKENS.map(t => <button key={t.token} type="button" className="rec-chip" onClick={() => insertToken(t.token)}>{t.name}</button>)}
          </div>
        )}
        {o.writeSource === 'secret' && <span className="faint">The value stays in this Mac's Keychain and is never shown.</span>}
      </div>
    );
    if (action === 'swipe' || action === 'scroll') return (
      <div className="rec-extra">
        <div className="rec-chips" role="radiogroup" aria-label="Direction"><span className="faint">Direction:</span>
          {(['up', 'down', 'left', 'right'] as Direction[]).map(d => (
            <button key={d} type="button" role="radio" aria-checked={o.direction === d} className={'rec-chip' + (o.direction === d ? ' on' : '')} onClick={() => rec.setOptions({ direction: d })}>
              <Icon name={{ up: 'arrow_upward', down: 'arrow_downward', left: 'arrow_back', right: 'arrow_forward' }[d]} size={15} />{d[0].toUpperCase() + d.slice(1)}
            </button>
          ))}
        </div>
        <label className="rec-inline small">Distance<NumberBox value={o.distance} min={20} max={5000} step={20} label="Distance" onChange={v => rec.setOptions({ distance: v })} />px</label>
      </div>
    );
    if (action === 'waitUntil') return (
      <div className="rec-extra"><label className="rec-inline small">Maximum wait<NumberBox value={o.maxWait} min={1} max={600} label="Maximum wait in seconds" onChange={v => rec.setOptions({ maxWait: v })} />seconds</label></div>
    );
    if (action === 'upload') return (
      <div className="rec-extra">
        <div className="rec-chips" role="radiogroup" aria-label="Sample file"><span className="faint">File:</span>
          {(Object.keys(SAMPLES) as SampleFile[]).map(k => (
            <button key={k} type="button" role="radio" aria-checked={o.sample === k} className={'rec-chip' + (o.sample === k ? ' on' : '')} onClick={() => rec.setOptions({ sample: k })}>{SAMPLES[k]}</button>
          ))}
        </div>
        <span className="faint">Then click the upload button on the page, or describe it.</span>
      </div>
    );
    return null;
  }

  const leadIcon = CLICK_FAMILY.has(action) ? 'auto_awesome' : actionInfo(action).icon;
  const canSend = !busy && (input === 'none' ? action !== 'drag' && action !== 'group' : action === 'write' && o.writeSource !== 'typed' ? true : !!rec.text.trim());

  if (rec.retryNote && !rr) hint = <><Icon name="ads_click" size={16} className="rec-hint-icon" />Click the page again to pick another spot.</>;
  // What the box can't do, by the box, until the sentence is changed (not a toast that goes).
  if (rec.unhandled && !rr) hint = <><Icon name="info" size={16} className="rec-hint-icon" /><span className="grow rec-hint-unhandled" role="status">{rec.unhandled}</span></>;
  if (frozen) hint = <><Icon name="play_arrow" size={16} className="rec-hint-icon" /><span className="grow">{frozen}</span></>;
  else if (rec.busy && !rr) hint = <><Icon name="hourglass_top" size={16} className="rec-hint-icon" /><span className="grow">{rec.phaseText ?? 'Working…'} You can add the next step when this one is done.</span></>;

  return (
    <div className="rec-bar">
      {/* Everything that comes and goes (AI bars, the chosen action's options) floats over the bottom of the
          page, never in the layout: the add step bar keeps one height and the page view never moves. */}
      <div className="rec-float">
      {bannerP.mounted && banner && (
        <div className={'rec-ai rec-banner' + (banner.tone ? ' ' + banner.tone : '') + (bannerP.closing ? ' closing' : '')} role="status" {...leaving(bannerP.closing)}>
          <Icon name={banner.icon ?? (banner.tone === 'bad' ? 'cancel' : banner.tone === 'ok' ? 'check_circle' : 'play_arrow')} size={20} className="rec-ai-icon" />
          <div className="grow">{banner.text}</div>
          {banner.action && <Button kind="primary" onClick={banner.action.onClick}>{banner.action.label}</Button>}
        </div>
      )}
      {askP.mounted && askAi && (
        <div className={'rec-ai rec-ai-result' + (askP.closing ? ' closing' : '')} role="status" {...leaving(askP.closing)}>
          <Icon name={askAi.state === 'proposal' ? actionInfo(askAi.params.action).icon : 'auto_awesome'} size={20} className="rec-ai-icon" />
          <div className="grow rec-ai-text">{askText}</div>
          <Button kind="primary" onClick={rec.confirmAi} autoFocus>Confirm</Button>
          <Button onClick={rec.retryAi}>Try again</Button>
          <span className="rec-ai-keys">Enter confirms · Esc cancels</span>
          <button type="button" className="rec-ai-link" onClick={rec.cancelAi}>Cancel</button>
        </div>
      )}
      {lostP.mounted && (
        <div className={'rec-ai rec-ai-notfound' + (lostP.closing ? ' closing' : '')} role="alert" {...leaving(lostP.closing)}>
          <Icon name="search_off" size={20} className="rec-ai-icon" />
          <div className="grow">{lostText}</div>
          <button type="button" className="rec-ai-link" onClick={() => { rec.cancelAi(); inputRef.current?.focus(); }}>OK</button>
        </div>
      )}
      {rec.secretAsk && rec.ai.state === 'idle' && !rec.busy && <SecretAsk rec={rec} taken={secretNames} />}
      {extra}
      </div>
      <div className="rec-hint">{hint}</div>
      <div className="rec-composer-wrap">
        <div className="rec-composer">
          <Icon name={leadIcon} size={18} className="rec-lead" />
          {field}
          <button ref={actionBtn} type="button" className={'rec-action-btn' + (menu !== 'closed' ? ' open' : '')} aria-haspopup="menu" aria-expanded={menu !== 'closed'}
            onClick={() => setMenu(m => (m === 'closed' ? 'menu' : 'closed'))}>
            <Icon name={actionInfo(action).icon} size={16} />{shortName(action)}<Icon name={menu !== 'closed' ? 'expand_less' : 'expand_more'} size={16} className="faint" />
          </button>
          <button type="button" className="rec-send" aria-label={input === 'describe' ? 'Ask the AI assistant' : 'Add step'}
            title={rec.busy ? 'Waiting for the last step to finish' : input === 'describe' ? 'Ask the AI assistant' : 'Add step'}
            onClick={rec.send} disabled={!canSend}>
            <Icon name="arrow_upward" size={18} />
          </button>
        </div>
        <ActionMenu open={menu === 'menu'} current={action} allowGroups={allowGroups} onPick={pick} onClose={closeMenu} />
        {menu === 'picker' && (
          <SharedStepsPicker appId={appId} insertAs={countRows(rec.steps) + 1}
            onInsert={(g, v) => { setMenu('closed'); onInsertGroup(g, v); }}
            onBack={() => setMenu('menu')} onClose={() => { setMenu('closed'); rec.setAction('click'); }} />
        )}
      </div>
    </div>
  );
}

const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;

/** "This looks like a password. Save it as a saved secret?" after a Write into a masked field. */
function SecretAsk({ rec, taken }: { rec: Recorder; taken: string[] }) {
  const [naming, setNaming] = useState(false);
  const free = (n: string) => { let x = n, i = 2; while (taken.includes(x)) x = `${n}_${i++}`; return x; };
  const [name, setName] = useState(() => free('TEST_PASSWORD'));
  const [error, setError] = useState<string | null>(null);
  const bad = !SECRET_NAME.test(name) ? 'Use capital letters, numbers and _ only, starting with a letter.'
    : taken.includes(name) ? 'There is already a saved secret with that name.' : null;
  const save = async () => {
    if (bad) return;
    try { await rec.saveAsSecret(name); } catch (e) { setError(e instanceof Error ? e.message : "Couldn't save the secret."); }
  };
  if (naming) return (
    <div className="rec-ai rec-ai-result" role="dialog" aria-label="Save as a saved secret">
      <Icon name="key" size={20} className="rec-ai-icon" />
      <label className="grow rec-secret-name">Name
        <input className="rec-num mono" style={{ width: 200 }} value={name} autoFocus onChange={e => setName(e.target.value.toUpperCase())}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void save(); } if (e.key === 'Escape') setNaming(false); }} aria-invalid={!!bad} />
        <span className={bad || error ? 'rec-secret-err' : 'faint'}>{bad ?? error ?? "Kept in this Mac's Keychain. The step then uses it."}</span>
      </label>
      <Button kind="primary" onClick={() => void save()} disabled={!!bad}>Save</Button>
      <button type="button" className="rec-ai-link" onClick={() => setNaming(false)}>Back</button>
    </div>
  );
  return (
    <div className="rec-ai rec-ai-result" role="status">
      <Icon name="password" size={20} className="rec-ai-icon" />
      <div className="grow rec-ai-text">This looks like a password. Save it as a saved secret?</div>
      <Button kind="primary" onClick={() => setNaming(true)}>Save as secret</Button>
      <Button onClick={() => rec.keepTyped()}>Keep as typed text</Button>
      <button type="button" className="rec-ai-link" onClick={() => rec.keepTyped(true)}>Don't ask again for this app</button>
    </div>
  );
}

function NumberBox({ value, onChange, min, max, step = 1, label, onEnter }: { value: number; onChange: (v: number) => void; min: number; max: number; step?: number; label: string; onEnter?: () => void }) {
  return (
    <input className="rec-num" type="number" value={value} min={min} max={max} step={step} aria-label={label}
      onChange={e => onChange(Math.max(min, Math.min(max, Number(e.target.value) || min)))}
      onKeyDown={e => { if (e.key === 'Enter' && onEnter) { e.preventDefault(); onEnter(); } }} />
  );
}
