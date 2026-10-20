// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { useFocusTrap } from './useFocusTrap';

afterEach(cleanup);

function Fixture() {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true);

  return (
    <div>
      <button type="button">Outside</button>
      <div ref={ref} tabIndex={-1}>
        <button type="button">First</button>
        <button type="button">Last</button>
      </div>
    </div>
  );
}

describe('the modal focus trap', () => {
  it('wraps Tab from the last control to the first one', async () => {
    const user = userEvent.setup();
    render(<Fixture />);

    screen.getByRole('button', { name: 'Last' }).focus();
    await user.tab();

    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
  });

  it('wraps Shift+Tab from the first control to the last one', async () => {
    const user = userEvent.setup();
    render(<Fixture />);

    screen.getByRole('button', { name: 'First' }).focus();
    await user.tab({ shift: true });

    expect(screen.getByRole('button', { name: 'Last' })).toHaveFocus();
  });
});
