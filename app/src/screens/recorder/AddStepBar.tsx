// Add step bar under the browser (README "Add step bar"): hint row, AI result / not found
// bars, the composer (describe box + action button + send), and action-specific inputs.
// Clicking the page and describing are always both available: no mode switch.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Direction, Generated, SampleFile, StepGroup } from '../../data/types';
import { secrets } from '../../platform';
import { actionInfo, SAMPLES } from '../../engine/labels';
import { countRows, findStep, TOKENS, numberOf } from '../../components/steps';
import { Button, Icon } from '../../components/ui';
import { ActionMenu } from './ActionMenu';
import { SharedStepsPicker } from './SharedStepsPicker';
import { composerInput, INSTANT, placeholderFor, shortName, toolHint, type MenuAction } from './actions';
import type { Recorder } from './useRecorder';

const CLICK_FAMILY = new Set(['click', 'doubleClick', 'longClick', 'rightClick', 'hover']);
const FILE_TYPES = [['', 'Any type'], ['pdf', 'PDF'], ['csv', 'CSV'], ['xlsx', 'Excel sheet'], ['docx', 'Word document'], ['jpeg', 'JPEG image'], ['mp4', 'MP4 video']];
const GEN: [Generated, string][] = [['uniqueName', 'A unique name'], ['timeNow', 'The time now'], ['today', "Today's date"], ['repeatNumber', 'The repeat number']];

export function AddStepBar({ rec, appId, allowGroups, onInsertGroup, frozen }: {
  rec: Recorder; appId: string; allowGroups: boolean; onInsertGroup: (g: StepGroup, version: number | 'latest') => void;
  /** Adding steps waits (the test is playing in this browser): says why. */
  frozen?: string | null;
}) {
  const [menu, setMenu] = useState<'closed' | 'menu' | 'picker'>('closed');
  const [secretNames, setSecretNames] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const actionBtn = useRef<HTMLButtonElement>(null);
  const { action, options: o } = rec;
  const input = composerInput(action);
  const busy = rec.busy || rec.ai.state === 'thinking' || !!frozen;

  useEffect(() => { void secrets.list().then(setSecretNames).catch(() => setSecretNames([])); }, []);
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
      <select className="rec-field-select" aria-label="Saved secret" value={o.secretRef} onChange={e => rec.setOptions({ secretRef: e.target.value })}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); rec.send(); } }}>
        {secretNames.length === 0 && <option value="">No saved secrets on this Mac</option>}
        {secretNames.map(n => <option key={n} value={n}>{n}</option>)}
      </select>
    );
  } else if (action === 'write' && o.writeSource === 'generated') {
    field = (
      <select className="rec-field-select" aria-label="Generated value" value={o.generated} onChange={e => rec.setOptions({ generated: e.target.value as Generated })}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); rec.send(); } }}>
        {GEN.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
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

  if (frozen) hint = <><Icon name="play_arrow" size={16} className="rec-hint-icon" /><span className="grow">{frozen}</span></>;
  else if (rec.busy && !rr) hint = <><Icon name="hourglass_top" size={16} className="rec-hint-icon" /><span className="grow">{rec.phaseText ?? 'Working…'} You can add the next step when this one is done.</span></>;

  return (
    <div className="rec-bar">
      {/* Over the bottom of the page, not in the layout: the page view never moves when it comes and goes. */}
      <div className="rec-float">
      {rec.ai.state === 'result' && (
        <div className="rec-ai rec-ai-result" role="status">
          <Icon name="auto_awesome" size={20} className="rec-ai-icon" />
          <div className="grow rec-ai-text">{rec.ask}</div>
          <Button kind="primary" onClick={rec.confirmAi} autoFocus>Confirm</Button>
          <Button onClick={rec.retryAi}>Try again</Button>
          <button type="button" className="rec-ai-link" onClick={rec.cancelAi}>Cancel</button>
        </div>
      )}
      {rec.ai.state === 'notfound' && (
        <div className="rec-ai rec-ai-notfound" role="alert">
          <Icon name="search_off" size={20} className="rec-ai-icon" />
          <div className="grow">{rec.notFound}</div>
          <button type="button" className="rec-ai-link" onClick={() => { rec.cancelAi(); inputRef.current?.focus(); }}>OK</button>
        </div>
      )}
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
      {extra}
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
