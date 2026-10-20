// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Markdown } from './Markdown';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the Markdown renderer', () => {
  it('renders headings, lists, tables and fenced code', () => {
    render(
      <Markdown
        content={[
          '## Result',
          '',
          '- one',
          '- two',
          '',
          '| a | b |',
          '| --- | --- |',
          '| 1 | 2 |',
          '',
          '```ts',
          'const answer = 42;',
          '```',
        ].join('\n')}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Result' })).toBeTruthy();
    expect(screen.getByText('one')).toBeTruthy();
    expect(screen.getByRole('table')).toBeTruthy();
    expect(document.body.textContent).toContain('const answer = 42;');
  });

  it('copies a code block and reports the real outcome', async () => {
    // userEvent installs its own clipboard stub, so the spy has to come after
    // it was set up.
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    render(<Markdown content={'```python\nprint("hi")\n```'} />);

    await user.click(screen.getByRole('button', { name: /copy code/i }));

    expect(writeText).toHaveBeenCalledWith('print("hi")');
    expect(await screen.findByRole('button', { name: /code copied/i })).toBeTruthy();
  });

  it('does not claim a copy when the browser refuses it', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    // The fallback is unavailable as well.
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn().mockReturnValue(false),
    });

    render(<Markdown content={'```python\nprint("hi")\n```'} />);

    await user.click(screen.getByRole('button', { name: /copy code/i }));

    expect(await screen.findByRole('button', { name: /copying failed/i })).toBeTruthy();
  });

  it('marks external links and keeps image sources from loading', () => {
    render(
      <Markdown content={'[docs](https://example.com/docs)\n\n![diagram](https://example.com/a.png)'} />,
    );

    const link = screen.getByRole('link', { name: /docs/i });
    expect(link.getAttribute('href')).toBe('https://example.com/docs');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');

    // An inline image is shown as a labelled placeholder, not fetched.
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText(/diagram/i)).toBeTruthy();
  });

  it('renders raw HTML as text instead of executing it', () => {
    const { container } = render(
      <Markdown content={'<script>window.hacked = true</script>\n\n<b>bold</b>'} />,
    );

    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText(/window\.hacked = true/)).toBeTruthy();
    expect(screen.getByText(/<b>bold<\/b>/)).toBeTruthy();
  });

  it('does not highlight code while the answer is still streaming', () => {
    const { container } = render(<Markdown content={'```python\nprint(1)\n```'} streaming />);
    expect(container.querySelector('.hljs-keyword')).toBeNull();
  });
});
