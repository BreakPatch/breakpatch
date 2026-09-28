// "Unsaved changes: warn on leaving the Recorder." In-app navigation goes through
// `guard()` (back, Run, Edit shared steps) and the title-bar avatar is caught here;
// closing or reloading the window uses the browser's beforeunload prompt.
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Dialog } from '../../components/ui';
import { hasFeature } from '../../edition';

export function useLeaveGuard(dirty: boolean, saveFirst?: () => Promise<boolean>) {
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [saving, setSaving] = useState(false);
  const navigate = useNavigate();
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;

  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty]);

  // The avatar opens Settings from the shared title bar; ask first.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!dirtyRef.current) return;
      if (!(e.target as HTMLElement).closest?.('.titlebar .avatar')) return;
      e.preventDefault(); e.stopPropagation();
      setPending(() => () => navigate('/settings'));
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [navigate]);

  const guard = (go: () => void) => { if (dirtyRef.current) setPending(() => go); else go(); };
  const close = () => setPending(null);

  const dialog = (
    <Dialog open={!!pending} onClose={close} icon="warning" iconColor="var(--fixed)" title="Leave without saving?"
      sub={hasFeature('versions') ? "Your changes aren't saved yet. Save them as a new version, or leave and lose them." : "Your changes aren't saved yet. Save them, or leave and lose them."}
      actions={<>
        <Button kind="ghost" onClick={close}>Keep editing</Button>
        <Button kind="danger" onClick={() => { const go = pending; setPending(null); go?.(); }}>Leave without saving</Button>
        {saveFirst && (
          <Button kind="primary" busy={saving} onClick={async () => {
            setSaving(true);
            const ok = await saveFirst().finally(() => setSaving(false));
            const go = pending; setPending(null);
            if (ok) go?.();
          }}>Save and leave</Button>
        )}
      </>} />
  );
  return { guard, dialog };
}
