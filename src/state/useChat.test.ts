import { describe, expect, it } from 'vitest';

import type { ToolTraceRecord } from '../../shared/tools/types';
import { markToolTraceCancelled } from './useChat';

function trace(overrides: Partial<ToolTraceRecord> = {}): ToolTraceRecord {
  return {
    id: 'trace-1',
    toolName: 'http_request',
    status: 'awaiting_approval',
    approvalRequired: true,
    approvalState: 'pending',
    approvalId: 'approval-1',
    safeArguments: { path: '/resource' },
    requestedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('tool timeline cancellation state', () => {
  it('marks a not-yet-approved operation cancelled and records that it did not run', () => {
    const result = markToolTraceCancelled([trace()], '2026-01-01T00:01:00.000Z');

    expect(result.operationMayHaveStarted).toBe(false);
    expect(result.trace[0]).toMatchObject({
      status: 'cancelled',
      approvalState: 'stale',
      approvalId: undefined,
      completedAt: '2026-01-01T00:01:00.000Z',
      resultSummary: 'Cancelled by the user before approval; the operation was not run.',
    });
  });

  it('marks an approved operation interrupted and does not claim cancellation rolled it back', () => {
    const result = markToolTraceCancelled([trace({ status: 'approved', approvalState: 'approved' })]);

    expect(result.operationMayHaveStarted).toBe(true);
    expect(result.trace[0]?.status).toBe('interrupted');
    expect(result.trace[0]?.approvalId).toBeUndefined();
    expect(result.trace[0]?.resultSummary).toMatch(/may have started or completed/i);
  });

  it('preserves completed and denied outcomes while removing any stale denial ID', () => {
    const result = markToolTraceCancelled([
      trace({ status: 'succeeded', approvalState: 'approved', approvalId: undefined, resultSummary: 'Created one item.' }),
      trace({ id: 'trace-2', status: 'denied', approvalState: 'denied' }),
    ]);

    expect(result.operationMayHaveStarted).toBe(false);
    expect(result.trace[0]).toMatchObject({ status: 'succeeded', resultSummary: 'Created one item.' });
    expect(result.trace[1]).toMatchObject({ status: 'denied', approvalId: undefined, resultSummary: 'Denied by the user; the operation was not run.' });
  });
});
