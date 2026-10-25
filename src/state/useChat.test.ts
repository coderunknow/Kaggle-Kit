import { describe, expect, it } from 'vitest';

import { ApiError } from '../../shared/api/errors';
import type { ChatMessage } from '../../shared/domain';
import type { ToolTraceRecord } from '../../shared/tools/types';
import { approvalFailureStates, droppedToolJobIds, markToolTraceCancelled, streamingFallbackAllowed } from './useChat';

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

describe('approval failure states', () => {
  it('never records a failed request as an approval', () => {
    // An aborted action stays stale: nothing was decided.
    expect(approvalFailureStates(new ApiError('aborted', 'aborted'), true, true)).toEqual({
      status: 'cancelled',
      approvalState: 'stale',
    });

    // A failed approve without the 410 evidence is stale, not approved and
    // not expired: the server-side outcome is unknown.
    const network = approvalFailureStates(new ApiError('network', 'unreachable'), true, false);
    expect(network).toEqual({ status: 'failed', approvalState: 'stale' });

    // The evidence-based expiry signal is exactly HTTP 410.
    const expired = approvalFailureStates(
      new ApiError('not_found', 'This tool approval is no longer active.', { httpStatus: 410 }),
      true,
      false,
    );
    expect(expired).toEqual({ status: 'failed', approvalState: 'expired', failureKind: 'approval_expired' });

    // A 404 or a message that merely mentions expiry is not treated as the
    // 410 evidence: no free-text heuristic.
    const notExpiredByStatus = approvalFailureStates(
      new ApiError('not_found', 'This approval expired before it was confirmed.', { httpStatus: 404 }),
      true,
      false,
    );
    expect(notExpiredByStatus).toEqual({ status: 'failed', approvalState: 'stale' });
    const notExpiredByText = approvalFailureStates(new ApiError('server', 'expired'), true, false);
    expect(notExpiredByText).toEqual({ status: 'failed', approvalState: 'stale' });
  });

  it('keeps the user denial when the deny request itself fails', () => {
    const failedDeny = approvalFailureStates(new ApiError('network', 'unreachable'), false, false);
    expect(failedDeny).toEqual({ status: 'denied', approvalState: 'denied' });
    const expiredDeny = approvalFailureStates(
      new ApiError('not_found', 'gone', { httpStatus: 410 }),
      false,
      false,
    );
    expect(expiredDeny).toEqual({ status: 'denied', approvalState: 'denied' });
  });

  it('treats a non-ApiError failure as stale for an approve and as a denial for a deny', () => {
    expect(approvalFailureStates(new Error('boom'), true, false)).toEqual({ status: 'failed', approvalState: 'stale' });
    expect(approvalFailureStates(new Error('boom'), false, false)).toEqual({ status: 'denied', approvalState: 'denied' });
  });
});

describe('dropped tool job ids', () => {
  function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
    return {
      id: 'm1',
      role: 'assistant',
      content: '',
      status: 'pending',
      createdAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('collects only the job ids at or after the drop index', () => {
    const messages = [
      message({ id: 'm1', toolJobId: 'job-kept' }),
      message({ id: 'm2', toolJobId: 'job-dropped' }),
      message({ id: 'm3' }),
      message({ id: 'm4', toolJobId: 'job-dropped-2' }),
    ];
    expect(droppedToolJobIds(messages, 1)).toEqual(['job-dropped', 'job-dropped-2']);
    expect(droppedToolJobIds(messages, 0)).toEqual(['job-kept', 'job-dropped', 'job-dropped-2']);
    expect(droppedToolJobIds(messages, 4)).toEqual([]);
    expect(droppedToolJobIds([], 0)).toEqual([]);
  });
});

describe('streaming fallback guard', () => {
  const refusal = new ApiError('bad_request', 'Streaming has not been verified for this endpoint.');

  it('retries without streaming only for a 409 refusal before any delta', () => {
    const refused = new ApiError('bad_request', 'Streaming has not been verified for this endpoint.', { httpStatus: 409 });
    expect(streamingFallbackAllowed({ wantsStream: true, receivedDelta: false, error: refused })).toBe(true);
  });

  it('never retries after a delta, because a partial answer already exists', () => {
    const refused = new ApiError('bad_request', 'Streaming has not been verified for this endpoint.', { httpStatus: 409 });
    expect(streamingFallbackAllowed({ wantsStream: true, receivedDelta: true, error: refused })).toBe(false);
  });

  it('refuses every other status, kind, request mode and error type', () => {
    expect(streamingFallbackAllowed({ wantsStream: false, receivedDelta: false, error: refusal })).toBe(false);
    expect(streamingFallbackAllowed({ wantsStream: true, receivedDelta: false, error: refusal })).toBe(false);
    expect(streamingFallbackAllowed({
      wantsStream: true,
      receivedDelta: false,
      error: new ApiError('server', 'failed', { httpStatus: 409 }),
    })).toBe(false);
    expect(streamingFallbackAllowed({
      wantsStream: true,
      receivedDelta: false,
      error: new ApiError('bad_request', 'bad', { httpStatus: 400 }),
    })).toBe(false);
    expect(streamingFallbackAllowed({ wantsStream: true, receivedDelta: false, error: new Error('boom') })).toBe(false);
  });
});
