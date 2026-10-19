// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppProvider } from '../state/AppProvider';
import { SettingsPanel, type SettingsTab } from './SettingsPanel';

function Harness() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<SettingsTab>('connections');

  return (
    <AppProvider>
      <button type="button" onClick={() => setOpen(true)}>
        Open settings
      </button>
      <SettingsPanel
        open={open}
        tab={tab}
        onTabChange={setTab}
        onClose={() => setOpen(false)}
      />
    </AppProvider>
  );
}

function drawer(): HTMLElement {
  return screen.getByRole('dialog', { name: /^settings$/i });
}

describe('the settings drawer', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(cleanup);

  it('opens as a modal dialog, moves the focus inside and closes with Escape', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const opener = screen.getByRole('button', { name: /open settings/i });
    await user.click(opener);

    const dialog = drawer();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('switches the tabs with the arrow keys', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: /open settings/i }));

    const connections = within(drawer()).getByRole('tab', { name: 'Connections' });
    connections.focus();
    await user.keyboard('{ArrowRight}');

    expect(within(drawer()).getByRole('tab', { name: 'Inference' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(within(drawer()).getByRole('tabpanel')).toHaveAccessibleName('Inference');
  });

  it('explains the difference between the page address and the model API', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: /open settings/i }));

    expect(within(drawer()).getByText(/two addresses, one purpose/i)).toBeTruthy();
    expect(within(drawer()).getByText(window.location.origin)).toBeTruthy();

    // The model address is described, not hard coded.
    expect(within(drawer()).getByText(/base url of a profile/i)).toBeTruthy();
  });

  it('states which configuration changes require a proxy restart', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: /open settings/i }));

    const restart = within(drawer()).getByText(/when do i need to restart the proxy/i);
    expect(restart).toBeTruthy();
    expect(within(drawer()).getByText(/KAGGLE_KIT_ALLOWED_HOSTS/)).toBeTruthy();
  });
});
