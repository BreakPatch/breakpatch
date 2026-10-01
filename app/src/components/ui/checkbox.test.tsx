// Checkbox: its label beside it is clickable, and unticking by clicking the tick itself stays
// unticked. The tick goes as it's clicked, and Chromium's label, no longer seeing the click inside
// its box, clicks the box again unless the click is cancelled (jsdom doesn't do that second click,
// so this checks the cancel; the back office's browser smoke test, smoke_web.py, sees the real one).
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Checkbox } from '.';

afterEach(cleanup);

function Box({ start }: { start: boolean }) {
  const [on, setOn] = useState(start);
  return <Checkbox checked={on} onChange={setOn} label="Show revoked" />;
}

describe('Checkbox', () => {
  it('ticks and unticks from the box, the tick inside it, and the label', () => {
    render(<Box start={true} />);
    const box = screen.getByRole('checkbox', { name: 'Show revoked' });
    expect(fireEvent.click(box.querySelector('.icon')!)).toBe(false);   // cancelled: the label leaves it
    expect(box.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(box);
    expect(box.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByText('Show revoked'));
    expect(box.getAttribute('aria-checked')).toBe('false');
  });
});
