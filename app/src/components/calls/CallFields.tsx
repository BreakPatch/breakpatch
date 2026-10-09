// A call's fields: method and address, headers (typed or from a saved secret), a body when it takes
// one, and Try it. Used by New test's set-up and clean-up calls and by a Call step's editor
// (CallStepDialog), so both make the same request under the same rules (lib/calls.ts).
import { useEffect, useState, type ReactNode } from 'react';
import type { CallHeader, HttpCall } from '../../data/types';
import { getEngine } from '../../engine';
import type { CallStepOptions } from '../../engine/engine';
import { cleanCall, describeReply, tryCall, type Reply } from '../../lib/calls';
import { secretsForRequest } from '../../lib/secretScope';
import { osText } from '../../lib/osWords';
import { Button, Field, Icon, IconButton, Select, Spinner, TextArea, TextInput } from '../ui';
import './calls.css';

const METHODS: HttpCall['method'][] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export interface CallFieldsProps {
  /** Starts each field's accessible name: "Before: set up data: method". */
  title: string;
  call: HttpCall;
  onChange: (c: HttpCall) => void;
  /** Under the address: why it would be refused. */
  error?: string;
  appUrl: string;
  /** "Allow other hosts" for this call (New test's switch, or the step's own). */
  otherHosts: boolean;
  secretNames: string[];
  /** A Call step's call takes a body (not on a GET). */
  body?: boolean;
  /** A Call step's own options, which Try it checks too. */
  step?: CallStepOptions;
  /** Beside Add header and Try it (the step's other options). */
  children?: ReactNode;
}

export function CallFields({ title, call, onChange, error, appUrl, otherHosts, secretNames, body, step, children }: CallFieldsProps) {
  const [reply, setReply] = useState<Reply | null>(null);
  const [trying, setTrying] = useState(false);
  const headers = call.headers ?? [];
  const stepKey = JSON.stringify(step ?? null);
  useEffect(() => { setReply(null); }, [call.url, call.method, call.headers, call.body, otherHosts, stepKey]);
  const tryIt = async () => {
    setTrying(true);
    const c = cleanCall(call, otherHosts);
    const names = (c.headers ?? []).map(h => h.secretRef).filter((n): n is string => !!n);
    const { secrets: values, ...scope } = await secretsForRequest(names).catch(() => ({ secrets: {} }));
    setReply(await tryCall(c, { engine: getEngine(), appUrl, secrets: values, scope, ...(step ? { step } : {}) }));
    setTrying(false);
  };
  const setHeader = (i: number, h: CallHeader) => onChange({ ...call, headers: headers.map((x, j) => (j === i ? h : x)) });
  const timeoutS = step?.timeoutMs ? Math.round(step.timeoutMs / 1000) : 15;

  return (<>
    <Field error={error}>
      <div className="app-call-row">
        <div className="app-call-method">
          <Select aria-label={`${title}: method`} value={call.method} onChange={e => onChange({ ...call, method: e.target.value as HttpCall['method'] })}
            options={METHODS.map(m => ({ value: m, label: m }))} />
        </div>
        <TextInput aria-label={`${title}: address`} mono value={call.url} placeholder="https://api.example.com/test/seed" spellCheck={false} autoCapitalize="off"
          onChange={e => onChange({ ...call, url: e.target.value })} />
      </div>
    </Field>
    {headers.map((h, i) => (
      <div className="app-call-header" key={i}>
        <TextInput aria-label={`${title}: header ${i + 1} name`} mono value={h.name} placeholder="Authorization" spellCheck={false} autoCapitalize="off"
          onChange={e => setHeader(i, { ...h, name: e.target.value })} />
        <div className="app-call-method">
          <Select aria-label={`${title}: header ${i + 1} value from`} value={h.secretRef !== undefined ? 'secret' : 'text'}
            onChange={e => setHeader(i, e.target.value === 'secret' ? { name: h.name, secretRef: secretNames[0] ?? '' } : { name: h.name, value: '' })}
            options={[{ value: 'text', label: 'Text' }, { value: 'secret', label: 'Saved secret' }]} />
        </div>
        {h.secretRef !== undefined
          ? <Select aria-label={`${title}: header ${i + 1} secret`} value={h.secretRef} onChange={e => setHeader(i, { ...h, secretRef: e.target.value })}
              options={secretNames.length ? secretNames.map(n => ({ value: n, label: n })) : [{ value: '', label: osText('No saved secrets on this Mac') }]} />
          : <TextInput aria-label={`${title}: header ${i + 1} value`} mono value={h.value ?? ''} spellCheck={false} autoCapitalize="off"
              onChange={e => setHeader(i, { ...h, value: e.target.value })} />}
        <IconButton icon="close" label={`Remove header ${h.name || i + 1}`} onClick={() => onChange({ ...call, headers: headers.filter((_, j) => j !== i) })} />
      </div>
    ))}
    {body && call.method !== 'GET' && (
      <TextArea aria-label={`${title}: body`} className="app-call-body" mono value={call.body ?? ''} rows={3} spellCheck={false} autoCapitalize="off"
        placeholder={'Body, optional. For example: {"paid": true}'} onChange={e => onChange({ ...call, body: e.target.value })} />
    )}
    {children}
    <div className="app-call-try">
      <div className="grow" aria-live="polite">
        {trying ? <span className="app-reply"><Spinner size={16} />Calling…</span>
          : reply && <span className={`app-reply ${reply.ok ? 'ok' : 'bad'}`}><Icon name={reply.ok ? 'check_circle' : 'error'} size={16} />{describeReply(reply, timeoutS)}</span>}
      </div>
      <Button kind="link" size="sm" icon="add" onClick={() => onChange({ ...call, headers: [...headers, { name: '', value: '' }] })}>Add header</Button>
      <Button kind="link" size="sm" icon="send" disabled={!call.url.trim() || trying} onClick={tryIt}>Try it</Button>
    </div>
  </>);
}
