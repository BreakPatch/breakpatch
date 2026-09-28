// "This will affect N tests." Shown before editing shared steps, from the Shared steps
// list or from "Edit shared steps" in a test (ui-requirements §5.8).
import { Button, Dialog, Icon } from '../ui';
import type { StepGroup, Test } from '../../data/types';
import { plural } from './format';

export function impactSummary(group: Pick<StepGroup, 'name' | 'usedBy'>): { title: string; text: string } {
  const latest = group.usedBy.filter(u => u.version === 'latest').length;
  const pinned = group.usedBy.filter(u => u.version !== 'latest');
  const versions = [...new Set(pinned.map(u => u.version))];
  const title = `This will affect ${plural(group.usedBy.length, 'test')}.`;
  const parts: string[] = [];
  if (latest) parts.push(`${latest} ${latest === 1 ? 'uses' : 'use'} the latest "${group.name}" and will pick up your changes on their next run.`);
  if (pinned.length) {
    const where = versions.length === 1 ? `version ${versions[0]}` : 'earlier versions';
    parts.push(`${pinned.length} ${pinned.length === 1 ? 'is' : 'are'} kept on ${where} and won't change.`);
  }
  return { title, text: parts.join(' ') };
}

export function ImpactDialog({ open, group, tests, onClose, onContinue }: {
  open: boolean; group: StepGroup | null; tests: Pick<Test, 'id' | 'name'>[]; onClose: () => void; onContinue: () => void;
}) {
  if (!group) return null;
  const { title, text } = impactSummary(group);
  const nameOf = (id: string) => tests.find(t => t.id === id)?.name ?? id;
  const rows = [...group.usedBy].sort((a, b) => (a.version === 'latest' ? 0 : 1) - (b.version === 'latest' ? 0 : 1));
  return (
    <Dialog open={open} onClose={onClose} title={title} sub={text} icon="warning" iconColor="var(--fixed)" width={520}
      actions={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" icon="edit" onClick={onContinue}>Edit shared steps</Button></>}>
      <ul className="cm-impact" aria-label="Tests that use these steps">
        {rows.map(u => {
          const latest = u.version === 'latest';
          return (
            <li key={u.testId} className={latest ? 'latest' : 'pinned'}>
              <Icon name={latest ? 'sync' : 'push_pin'} size={17} />
              <span className="grow ellipsis">{nameOf(u.testId)}</span>
              <span className="cm-impact-mode">{latest ? 'Always latest' : `Kept on version ${u.version}`}</span>
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}
