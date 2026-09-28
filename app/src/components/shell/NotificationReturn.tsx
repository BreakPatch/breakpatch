// macOS gives Breakpatch no event for a click on its notification; the click brings the app forward.
// So when the window gets the focus soon after a notification, it opens that run's report.
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { takePendingReport } from '../../lib/notify';

export function NotificationReturn() {
  const navigate = useNavigate();
  useEffect(() => {
    const onFocus = () => { const path = takePendingReport(); if (path) navigate(path); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [navigate]);
  return null;
}
