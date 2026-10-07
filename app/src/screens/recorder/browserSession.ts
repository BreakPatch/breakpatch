// Opens the controlled browser for the Recorder and the Shared steps editor, and closes it on leave.
import { useEffect, useRef, useState } from 'react';
import type { Viewport } from '../../data/types';
import { getEngine } from '../../engine';
import { sampleApp, SAMPLE_PATH } from '../../components/live';

/** The address pill text: no protocol. The demo sample app opens on its Projects page. */
export function addressOf(url: string | undefined): string {
  if (!url) return '';
  const bare = url.replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '');
  if (getEngine().liveMode === 'sample' && !bare.includes('/')) return bare + SAMPLE_PATH;
  return bare;
}

export function useBrowserSession(url: string | undefined, viewport: Pick<Viewport, 'width' | 'height' | 'device'> | undefined, onError: (m: string) => void) {
  const [ready, setReady] = useState(false);
  const onErr = useRef(onError); onErr.current = onError;
  const w = viewport?.width, h = viewport?.height, device = viewport?.device;
  useEffect(() => {
    if (!url || !w || !h) return;
    const engine = getEngine();
    let live = true;
    setReady(false);
    if (engine.liveMode === 'sample') sampleApp.reset();
    engine.openBrowser(url, { width: w, height: h, dpr: 1, ...(device ? { device } : {}) })
      .then(() => { if (live) setReady(true); })
      .catch(e => { if (live) { setReady(true); onErr.current(e instanceof Error ? e.message : "Couldn't open the browser."); } });
    return () => { live = false; void engine.closeBrowser().catch(() => {}); };
  }, [url, w, h, device]);
  return { ready };
}
