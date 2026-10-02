import { describe, expect, it } from 'vitest';
import { askText, checkpointLabel, describeWhat, notFoundText, thinkingText } from './describe';
import { composerInput, menuGroups, toolFor } from './actions';

describe('describe flow text', () => {
  it('keeps the words for the thing', () => {
    expect(describeWhat('click the Done button')).toBe('the Done button');
    expect(describeWhat('Press the Done button.')).toBe('the Done button');
    expect(describeWhat('double click New project')).toBe('New project');
    expect(describeWhat('the Done button')).toBe('the Done button');
  });
  it('writes the prototype copy', () => {
    expect(thinkingText('the Done button')).toBe('Looking for the Done button…');
    expect(askText('the Done button')).toBe('Is this the Done button?');
    expect(notFoundText('the Archive button')).toBe('Couldn\'t find "the Archive button" on this screen. Rephrase, or click it on the page.');
  });
  it('names checkpoints', () => {
    expect(checkpointLabel('success message')).toBe('Success message shows');
    expect(checkpointLabel('Success message shows')).toBe('Success message shows');
    expect(checkpointLabel('')).toBe('Check something is visible');
  });
});

describe('action list', () => {
  it('groups per ui-requirements §5.6, with Checkpoint', () => {
    const g = menuGroups({ allowGroups: true });
    expect(g.map(x => x.title)).toEqual(['Gestures', 'Input', 'Waiting', 'Browser', 'Checkpoint', 'Structure']);
    expect(g[3].items.map(i => i.name)).toEqual(['Go to address', 'Reload', 'Back', 'Forward', 'Switch to new tab or popup', 'Upload file', 'Check a download']);
    expect(g[5].items.map(i => i.kind)).toEqual(['loop', 'group']);
  });
  it('leaves out shared steps inside shared steps', () => {
    expect(menuGroups({ allowGroups: false })[5].items.map(i => i.kind)).toEqual(['loop']);
  });
  it('maps actions to page tools and composer inputs', () => {
    expect(toolFor('click')).toBe('point');
    expect(toolFor('scroll')).toBe('drag');
    expect(toolFor('checkpoint')).toBe('box');
    expect(composerInput('write')).toBe('text');
    expect(composerInput('navigate')).toBe('url');
    expect(composerInput('waitFor')).toBe('none');
    expect(composerInput('upload', true)).toBe('describe');
    // The describe box is off: what acts on the page is added on the page.
    for (const k of ['click', 'hover', 'upload', 'scroll', 'waitUntil', 'checkpoint'] as const) expect(composerInput(k)).toBe('none');
    expect(composerInput('write')).toBe('text');
  });
});
