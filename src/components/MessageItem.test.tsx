// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage } from '../../shared/domain';
import { MessageItem } from './MessageItem';

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: 'The operation needs your approval.',
    status: 'pending',
    createdAt: '2026-01-01T00:00:00.000Z',
    toolJobId: 'job-1',
    toolTrace: [{
      id: 'trace-1',
      toolName: 'code_execute',
      status: 'awaiting_approval',
      approvalRequired: true,
      approvalState: 'pending',
      approvalId: 'approval-1',
      safeArguments: { language: 'python', code: 'print(1)' },
      target: 'isolated Python sandbox',
      requestedAt: '2026-01-01T00:00:00.000Z',
    }],
    sourceCitations: [{ url: 'https://example.com/source', title: 'Example source' }],
    ...overrides,
  };
}

describe('accessible tool activity timeline', () => {
  afterEach(cleanup);

  it('announces the waiting state, exposes bounded arguments, and approves only once', async () => {
    const user = userEvent.setup();
    const onToolApproval = vi.fn();
    render(
      <MessageItem
        message={message()}
        isLast
        disabled
        onToolApproval={onToolApproval}
        onCopy={async () => true}
        onEdit={vi.fn()}
        onRetry={vi.fn()}
        onResend={vi.fn()}
        onRegenerate={vi.fn()}
      />,
    );

    expect(screen.getByText('Waiting for your approval')).toHaveAttribute('role', 'status');
    expect(screen.getByText('code_execute')).toBeTruthy();
    expect(screen.getByText('This exact operation has not run. Approving authorizes this call only.')).toBeTruthy();
    await user.click(screen.getByText('Review bounded arguments'));
    expect(screen.getByText(/"code": "print\(1\)"/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Approve once' }));
    expect(onToolApproval).toHaveBeenCalledWith('assistant-1', 'approval-1', true);
    expect(screen.getByRole('link', { name: 'Example source' })).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('does not offer a stale approval after the pending job has disappeared', () => {
    render(
      <MessageItem
        message={message({ toolJobId: undefined, toolTrace: [{
          ...message().toolTrace![0]!, status: 'interrupted', approvalState: 'stale', approvalId: undefined,
        }] })}
        isLast
        disabled={false}
        onToolApproval={vi.fn()}
        onCopy={async () => true}
        onEdit={vi.fn()}
        onRetry={vi.fn()}
        onResend={vi.fn()}
        onRegenerate={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Approve once' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
    expect(screen.getByText('Interrupted')).toBeTruthy();
  });

  it('announces that retention-restricted tool answers stay session-only', () => {
    render(
      <MessageItem
        message={message({
          status: 'complete',
          toolJobId: undefined,
          toolTrace: [],
          sourceCitations: [],
          transientToolContent: true,
        })}
        isLast
        disabled={false}
        onToolApproval={vi.fn()}
        onCopy={async () => true}
        onEdit={vi.fn()}
        onRetry={vi.fn()}
        onResend={vi.fn()}
        onRegenerate={vi.fn()}
      />,
    );

    const notice = screen.getByText(/visible in this session only/);
    expect(notice).toHaveAttribute('role', 'status');
    expect(notice).toHaveTextContent('will not be saved or exported');
    expect(screen.getByText('The operation needs your approval.')).toBeTruthy();
  });
});


describe('C1 - a persisted unverified-streaming notice is historical', () => {
  afterEach(cleanup);

  it('does not claim the current browser session is unverified', () => {
    render(
      <MessageItem
        message={message({
          status: 'complete',
          toolJobId: undefined,
          toolTrace: [],
          sourceCitations: [],
          streamUnverified: true,
        })}
        isLast
        disabled={false}
        onToolApproval={vi.fn()}
        onCopy={async () => true}
        onEdit={vi.fn()}
        onRetry={vi.fn()}
        onResend={vi.fn()}
        onRegenerate={vi.fn()}
      />,
    );

    expect(screen.getByText(/in the session that produced this answer/i)).toBeInTheDocument();
    expect(screen.queryByText(/this browser session/i)).toBeNull();
    expect(screen.getByText(/later answers/i)).toBeInTheDocument();
  });
});
