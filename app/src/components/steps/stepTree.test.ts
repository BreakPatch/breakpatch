import { describe, expect, it } from 'vitest';
import type { Step } from '../../data/types';
import {
  appendStep, countRows, duplicateStep, findStep, flatRows, fromTokens, hasRerecorded, moveAfter, moveBefore, moveBy,
  numberOf, removeStep, replaceStep, stepsBefore, stripUi, toTokens, updateStep,
} from './stepTree';
import { defaultLabel, friendlyText, repeatPreview, stepIcon, stepNote } from './stepText';

const st = (id: string, extra: Partial<Step> = {}): Step => ({ id, action: 'click', label: id, ...extra });
const loop = (id: string, steps: Step[], count = 5): Step => ({ id, action: 'loop', label: `Repeat ${count} times`, count, steps });
const ids = (steps: Step[]): unknown[] => steps.map(s => (s.action === 'loop' ? { [s.id]: ids(s.steps ?? []) } : s.id));

// a, [L: b, c], d
const sample = () => [st('a'), loop('L', [st('b'), st('c')]), st('d')];

describe('tokens', () => {
  it('round-trips nested loops', () => {
    const s = [st('a'), loop('L', [st('b'), loop('M', [st('x')])]), st('d')];
    expect(fromTokens(toTokens(s))).toEqual(s);
  });
  it('closes an unclosed loop at the end and drops a stray end', () => {
    const out = fromTokens([{ kind: 'end', loopId: 'zz' }, { kind: 'start', loop: loop('L', []) }, { kind: 'step', step: st('b') }]);
    expect(ids(out)).toEqual([{ L: ['b'] }]);
  });
});

describe('flatRows', () => {
  it('numbers rows in order, loop rows included, with depth and range', () => {
    const rows = flatRows(sample());
    expect(rows.map(r => [r.step.id, r.number, r.depth, r.loopId])).toEqual([
      ['a', 1, 0, undefined], ['L', 2, 0, undefined], ['b', 3, 1, 'L'], ['c', 4, 1, 'L'], ['d', 5, 0, undefined],
    ]);
    expect(rows[1].range).toEqual([3, 4]);
    expect(countRows(sample())).toBe(5);
    expect(numberOf(sample(), 'c')).toBe(4);
  });
  it('an empty loop has no range', () => {
    expect(flatRows([loop('L', [])])[0].range).toBeUndefined();
  });
});

describe('edits', () => {
  it('finds and updates a step inside a loop', () => {
    const s = updateStep(sample(), 'c', { target: 'Save button' });
    expect(findStep(s, 'c')?.target).toBe('Save button');
    expect(findStep(sample(), 'c')?.target).toBeUndefined();
  });
  it('appends into the open loop, else at the end', () => {
    expect(ids(appendStep(sample(), st('e'), 'L'))).toEqual(['a', { L: ['b', 'c', 'e'] }, 'd']);
    expect(ids(appendStep(sample(), st('e'), null))).toEqual(['a', { L: ['b', 'c'] }, 'd', 'e']);
    expect(ids(appendStep(sample(), st('e'), 'gone'))).toEqual(['a', { L: ['b', 'c'] }, 'd', 'e']);
  });
  it('removes a step; removing a loop keeps its steps', () => {
    expect(ids(removeStep(sample(), 'b'))).toEqual(['a', { L: ['c'] }, 'd']);
    expect(ids(removeStep(sample(), 'L'))).toEqual(['a', 'b', 'c', 'd']);
  });
  it('re-record replaces in place, keeps the id and marks it', () => {
    const out = replaceStep(sample(), 'c', { ...st('new'), label: 'Click Done', at: [1, 2] });
    const c = findStep(out, 'c')!;
    expect(c).toMatchObject({ id: 'c', label: 'Click Done', at: [1, 2], rerecorded: true });
    expect(ids(out)).toEqual(['a', { L: ['b', 'c'] }, 'd']);
    expect(hasRerecorded(out)).toBe(true);
    expect(hasRerecorded(stripUi(out))).toBe(false);
    expect('rerecorded' in findStep(stripUi(out), 'c')!).toBe(false);
  });
  it('duplicates after the original with fresh ids (loops deep)', () => {
    let n = 0;
    const { steps, copyId } = duplicateStep(sample(), 'L', () => 'n' + ++n);
    expect(copyId).toBe('n1');
    expect(ids(steps)).toEqual(['a', { L: ['b', 'c'] }, { n1: ['n2', 'n3'] }, 'd']);
  });
  it('stepsBefore lists what runs before a step', () => {
    expect(stepsBefore(sample(), 'c').map(s => s.id)).toEqual(['a', 'b']);
    expect(stepsBefore(sample(), 'L').map(s => s.id)).toEqual(['a']);
  });
});

describe('moving', () => {
  it('moves a step up into and out of a loop one position at a time', () => {
    let s = sample();
    s = moveBy(s, 'd', -1);                               // enters the loop at its end
    expect(ids(s)).toEqual(['a', { L: ['b', 'c', 'd'] }]);
    s = moveBy(s, 'd', -1);
    expect(ids(s)).toEqual(['a', { L: ['b', 'd', 'c'] }]);
    s = moveBy(moveBy(s, 'd', -1), 'd', -1);              // leaves the loop at its start
    expect(ids(s)).toEqual(['a', 'd', { L: ['b', 'c'] }]);
    expect(ids(moveBy(s, 'a', -1))).toEqual(ids(s));        // already first
  });
  it('moves down symmetrically', () => {
    let s = moveBy(sample(), 'a', 1);                     // enters the loop at its start
    expect(ids(s)).toEqual([{ L: ['a', 'b', 'c'] }, 'd']);
    s = moveBy(sample(), 'c', 1);                         // leaves the loop
    expect(ids(s)).toEqual(['a', { L: ['b'] }, 'c', 'd']);
    expect(ids(moveBy(sample(), 'd', 1))).toEqual(ids(sample()));
  });
  it('moves a whole loop block', () => {
    expect(ids(moveBy(sample(), 'L', -1))).toEqual([{ L: ['b', 'c'] }, 'a', 'd']);
    expect(ids(moveBefore(sample(), 'L', null))).toEqual(['a', 'd', { L: ['b', 'c'] }]);
  });
  it('drag drops before a row, or at the end outside loops', () => {
    expect(ids(moveBefore(sample(), 'd', 'b'))).toEqual(['a', { L: ['d', 'b', 'c'] }]);
    expect(ids(moveBefore(sample(), 'b', null))).toEqual(['a', { L: ['c'] }, 'd', 'b']);
    expect(ids(moveBefore(sample(), 'a', 'd'))).toEqual([{ L: ['b', 'c'] }, 'a', 'd']);
    expect(ids(moveBefore(sample(), 'L', 'b'))).toEqual(ids(sample()));   // into itself: no-op
  });
  it('drag drops after a row; after a loop row goes first inside it', () => {
    expect(ids(moveAfter(sample(), 'a', 'c'))).toEqual([{ L: ['b', 'c', 'a'] }, 'd']);
    expect(ids(moveAfter(sample(), 'd', 'L'))).toEqual(['a', { L: ['d', 'b', 'c'] }]);
    expect(ids(moveAfter(sample(), 'L', 'd'))).toEqual(['a', 'd', { L: ['b', 'c'] }]);
    expect(ids(moveAfter(sample(), 'L', 'c'))).toEqual(ids(sample()));
  });
});

describe('step text', () => {
  it('labels and notes', () => {
    expect(defaultLabel({ action: 'write', text: 'Note {i}' })).toBe('Write "Note {repeat}"');
    expect(defaultLabel({ action: 'write', secretRef: 'X' })).toBe('Write saved secret X');
    expect(defaultLabel({ action: 'write', generated: 'today' })).toBe("Write today's date");
    expect(defaultLabel({ action: 'waitFor', durationMs: 3000 })).toBe('Wait 3 seconds');
    expect(defaultLabel({ action: 'loop', count: 5 })).toBe('Repeat 5 times');
    expect(defaultLabel({ action: 'upload', sample: 'pdf' })).toBe('Upload PDF');
    expect(defaultLabel({ action: 'navigate', nav: 'reload' })).toBe('Reload the page');
    expect(friendlyText('a {i} b {i}')).toBe('a {repeat} b {repeat}');
    expect(repeatPreview('Note {i}')).toBe('Note 1, Note 2…');
    expect(repeatPreview('plain')).toBeUndefined();
    expect(stepNote(loop('L', []), { range: [3, 6] })).toBe('Steps 3 to 6');
    expect(stepNote({ id: 'g', action: 'group', label: 'Log in', groupVersion: 'latest' })).toBe('Shared steps · always latest');
    expect(stepNote({ id: 'g', action: 'group', label: 'Log in', groupVersion: 2 })).toBe('Shared steps · version 2');
    expect(stepIcon({ action: 'navigate', nav: 'back' })).toBe('arrow_back');
    expect(stepIcon({ action: 'write', secretRef: 'X' })).toBe('key');
    expect(stepIcon({ action: 'click' })).toBe('touch_app');
  });
});
