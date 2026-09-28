// React version of design/Sample App.dc.html: the placeholder "app under test" shown in
// the live view in demo mode. Drawn at the test's viewport size; its clickable targets
// register with the demo engine so recording (`recordPoint`) and describing (`locate`)
// find them. Colours are the sample app's own: the app under test never follows the
// Breakpatch theme ("The web app you're testing always shows as it really is").
import { useEffect } from 'react';
import type { Viewport } from '../../../data/types';
import { demoEngine } from '../../../engine';
import type { DemoTarget } from '../../../engine/demoEngine';
import { boxOf, SAMPLE_TARGETS, type SampleState } from './sampleModel';
import { useSampleState } from './sampleStore';
import './sample.css';

const ROWS = [
  { n: 'Riverside block B', m: 'Created by J. Patel', d: '12 Sep' },
  { n: 'North yard extension', m: 'Created by A. Moreno', d: '09 Sep' },
  { n: 'Plant room upgrade', m: 'Created by L. Chen', d: '02 Sep' },
  { n: 'Level 3 fit-out', m: 'Created by R. Okafor', d: '28 Aug' },
  { n: 'Car park resurfacing', m: 'Created by S. Doyle', d: '21 Aug' },
];

export interface SampleAppProps {
  viewport: Pick<Viewport, 'width' | 'height'>;
  /** Show this state instead of the live one (report screenshots: "Expected" vs "What was on screen"). */
  state?: SampleState;
  /** Register targets with the demo engine (only the live, interactive copy should). */
  register?: boolean;
}

export function SampleApp({ viewport, state, register = true }: SampleAppProps) {
  const live = useSampleState();
  const s = state ?? live;
  useSampleTargets(viewport, register && !state);
  const rows = [...s.projects.map(n => ({ n, m: 'Created by you', d: 'Today' })), ...ROWS].slice(0, 5);
  return (
    <div className="sample" style={{ width: viewport.width, height: viewport.height }} aria-label="Sample app under test">
      <div className="sample-top">
        <div className="sample-logo" />
        <div className="sample-brand">Workspace</div>
        <div className="sample-nav"><span className="on">Projects</span><span>Reports</span><span>Team</span></div>
        <div style={{ flex: 1 }} />
        <div className="sample-clock">14:46</div>
        <div className="sample-avatar" />
      </div>
      {s.created && !s.dialog && (
        <div className="sample-success" role="status"><span className="icon">check_circle</span>“{s.created}” created</div>
      )}
      <div className="sample-body">
        <div className="sample-head">
          <div className="sample-h1">Projects</div>
          <div className="sample-btn dark">New project</div>
        </div>
        {rows.map((r, i) => (
          <div className="sample-row" key={r.n + i}>
            <div className="sample-thumb" />
            <div className="sample-row-main"><div className="sample-row-name">{r.n}</div><div className="sample-row-meta">{r.m}</div></div>
            <div className="sample-row-meta">{r.d}</div>
          </div>
        ))}
      </div>
      {s.dialog && (
        <>
          <div className="sample-scrim" />
          <div className="sample-dialog">
            <div className="sample-dialog-title">Create project</div>
            <div className="sample-field"><div className="sample-label">Project name</div><div className={'sample-input' + (s.focus === 'name' ? ' focus' : '')}>{s.name}{s.focus === 'name' && <span className="sample-caret" />}</div></div>
            <div className="sample-field"><div className="sample-label">Location</div><div className="sample-input" /></div>
            <div className="sample-field"><div className="sample-label">Start date</div><div className="sample-input" style={{ width: '50%' }} /></div>
            <div style={{ flex: 1 }} />
            <div className="sample-actions"><div className="sample-btn light">Cancel</div><div className="sample-btn dark wide">Done</div></div>
          </div>
        </>
      )}
    </div>
  );
}

function useSampleTargets(viewport: Pick<Viewport, 'width' | 'height'>, enabled: boolean) {
  const { width, height } = viewport;
  useEffect(() => {
    const engine = demoEngine();
    if (!engine || !enabled) return;
    const targets: DemoTarget[] = SAMPLE_TARGETS.map(d => ({
      key: d.key, words: d.words, box: boxOf(d, { width, height }), target: d.target, label: d.label,
      visible: () => d.visible(useSampleState.getState()),
    }));
    engine.targets = targets;
    return () => { if (engine.targets === targets) engine.targets = []; };
  }, [width, height, enabled]);
}
