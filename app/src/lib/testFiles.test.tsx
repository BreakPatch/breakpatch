import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accepts, addOwnFile, filesDir, samplesFor, setFilesFs, type FilesFs } from './testFiles';
import { FileChooserDialog } from '../screens/recorder/FileChooserDialog';
import caps from '../../src-tauri/capabilities/default.json';

afterEach(() => setFilesFs(null));

function fakeFs(names: string[] = []): FilesFs & { ops: string[] } {
  const have = new Set(names.map(n => '/t/files/' + n));
  const ops: string[] = [];
  return {
    ops,
    async list() { return [...have].map(p => p.split('/').pop()!).sort(); },
    async mkdir(d) { ops.push('mkdir ' + d); },
    async exists(p) { return have.has(p); },
    async copy(a, b) { ops.push(`copy ${a} ${b}`); have.add(b); },
    async rename(a, b) { ops.push(`rename ${a} ${b}`); have.delete(a); have.add(b); },
    async pick() { return '/Users/maria/Pictures/photo.jpg'; },
  };
}

describe('files a test uploads', () => {
  it('keeps them in files/, next to apps/, in the tests folder', () => {
    expect(filesDir('/Users/maria/Tests')).toBe('/Users/maria/Tests/files');
    expect(filesDir(undefined)).toBeUndefined();
  });

  it('puts the samples the input accepts first', () => {
    expect(samplesFor('image/*')[0].kind).toBe('jpeg');
    expect(samplesFor('.pdf,.csv').filter(s => s.fits).map(s => s.kind)).toEqual(['pdf', 'csv']);
    expect(samplesFor('').every(s => s.fits)).toBe(true);
    expect(accepts('image/*', 'photo.JPG')).toBe(true);
    expect(accepts('.pdf', 'photo.jpg')).toBe(false);
  });

  it('copies a file from this Mac under a temporary name first, and never over another one', async () => {
    const fs = fakeFs(['photo.jpg']);
    setFilesFs(fs);
    const got = await addOwnFile('/t/files', '/Users/maria/Pictures/photo.jpg');
    expect(got).toEqual({ file: 'files/photo 2.jpg', path: '/t/files/photo 2.jpg' });
    const copy = fs.ops.find(o => o.startsWith('copy'))!;
    const tmp = copy.split(' ').slice(-1)[0];
    expect(tmp.split('/').pop()!.startsWith('.')).toBe(false);          // no dot files in the tests folder
    expect(fs.ops).toContain(`rename ${copy.slice(copy.indexOf('/t/'))} /t/files/photo 2.jpg`);
  });

  it('may copy files in the shell (inside the picked folder only, by the fs scope)', () => {
    expect(caps.permissions).toContain('fs:allow-copy-file');
  });

  it('asks which file: a sample, one of the user\'s files, or one from this Mac; Cancel just clicks', async () => {
    setFilesFs(fakeFs(['report.pdf', 'photo.jpg']));
    const onChoose = vi.fn();
    render(<FileChooserDialog ask={{ accept: 'image/*', multiple: false }} dir="/t/files" onChoose={onChoose} />);
    expect(screen.getByText('This button opens a file picker')).toBeInTheDocument();
    fireEvent.click(screen.getByText('JPEG image'));
    expect(onChoose).toHaveBeenLastCalledWith({ sample: 'jpeg' });
    await waitFor(() => expect(screen.getByText('photo.jpg')).toBeInTheDocument());
    const own = screen.getAllByRole('listitem').map(e => e.textContent);
    const at = (n: string) => own.findIndex(t => t?.endsWith(n));
    expect(at('photo.jpg')).toBeLessThan(at('report.pdf'));   // the type it takes first
    fireEvent.click(screen.getByText('photo.jpg'));
    expect(onChoose).toHaveBeenLastCalledWith({ file: 'files/photo.jpg', path: '/t/files/photo.jpg' });
    fireEvent.click(screen.getByText('Choose from this Mac…'));
    await waitFor(() => expect(onChoose).toHaveBeenLastCalledWith({ file: 'files/photo 2.jpg', path: '/t/files/photo 2.jpg' }));
    fireEvent.click(screen.getByText('Cancel, just click'));
    expect(onChoose).toHaveBeenLastCalledWith({ cancel: true });
  });
});
