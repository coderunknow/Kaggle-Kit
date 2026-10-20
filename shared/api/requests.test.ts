import { describe, expect, it } from 'vitest';

import { buildChatCompletionBody, type ServerCapabilities } from './requests';
import type { ToolDefinition } from '../tools/types';

const noCapabilities: ServerCapabilities = {
  streamingVerified: false,
  reasoningEffortSupported: false,
  notes: [],
};

describe('buildChatCompletionBody', () => {
  it('includes the core generation parameters', () => {
    const { body } = buildChatCompletionBody({
      model: 'model-a',
      messages: [{ role: 'user', content: 'hello' }],
      params: {
        maxTokens: 256,
        temperature: 0.4,
        topP: 0.9,
        stream: false,
      },
      capabilities: noCapabilities,
    });

    expect(body.model).toBe('model-a');
    expect(body.max_tokens).toBe(256);
    expect(body.temperature).toBe(0.4);
    expect(body.top_p).toBe(0.9);
  });

  it('omits penalties that are not configured', () => {
    const { body, omitted } = buildChatCompletionBody({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      params: { maxTokens: 16, temperature: 0, topP: 1, stream: false },
      capabilities: noCapabilities,
    });

    expect(body.frequency_penalty).toBeUndefined();
    expect(body.presence_penalty).toBeUndefined();
    expect(omitted).toContain('frequency_penalty');
    expect(omitted).toContain('presence_penalty');
  });

  it('sends penalties that are configured', () => {
    const { body } = buildChatCompletionBody({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      params: {
        maxTokens: 16,
        temperature: 0,
        topP: 1,
        frequencyPenalty: 0.2,
        presencePenalty: 0.1,
        stream: false,
      },
      capabilities: noCapabilities,
    });

    expect(body.frequency_penalty).toBe(0.2);
    expect(body.presence_penalty).toBe(0.1);
  });

  it('never sends stream:true when streaming was not verified', () => {
    const { body, omitted } = buildChatCompletionBody({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      params: { maxTokens: 16, temperature: 0, topP: 1, stream: true },
      capabilities: noCapabilities,
    });

    expect(body.stream).toBeUndefined();
    expect(omitted).toContain('stream');
  });

  it('sends stream:true when streaming was verified', () => {
    const { body } = buildChatCompletionBody({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      params: { maxTokens: 16, temperature: 0, topP: 1, stream: true },
      capabilities: { ...noCapabilities, streamingVerified: true },
    });

    expect(body.stream).toBe(true);
  });

  it('never sends reasoning_effort when the server does not support it', () => {
    const { body, omitted } = buildChatCompletionBody({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      params: { maxTokens: 16, temperature: 0, topP: 1, reasoningEffort: 'medium', stream: false },
      capabilities: noCapabilities,
    });

    expect(body.reasoning_effort).toBeUndefined();
    expect(omitted).toContain('reasoning_effort');
  });

  it('sends reasoning_effort when the server supports it', () => {
    const { body } = buildChatCompletionBody({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      params: { maxTokens: 16, temperature: 0, topP: 1, reasoningEffort: 'medium', stream: false },
      capabilities: { ...noCapabilities, reasoningEffortSupported: true },
    });

    expect(body.reasoning_effort).toBe('medium');
  });

  it('omits tools until native tool calling is explicitly verified', () => {
    const tool = { type: 'function' as const, function: { name: 'calculator_calculate', parameters: { type: 'object' } } };
    const { body, omitted } = buildChatCompletionBody({
      model: 'm', messages: [{ role: 'user', content: 'x' }],
      params: { maxTokens: 16, temperature: 0, topP: 1, stream: false },
      capabilities: noCapabilities, tools: [tool],
    });
    expect(body.tools).toBeUndefined();
    expect(omitted).toContain('tools');
  });

  it('sends verified tools non-streaming and strips local permission metadata', () => {
    const tool = { type: 'function' as const, permission: 'read_only', function: { name: 'calculator_calculate', parameters: { type: 'object' } } } as ToolDefinition;
    const { body, omitted } = buildChatCompletionBody({
      model: 'm', messages: [{ role: 'user', content: 'x' }],
      params: { maxTokens: 16, temperature: 0, topP: 1, stream: true },
      capabilities: { ...noCapabilities, streamingVerified: true, toolCalling: { status: 'supported_verified', detail: 'verified' } },
      tools: [tool],
    });
    expect(body.tools?.[0]?.function.name).toBe('calculator_calculate');
    expect(body.tools?.[0]).not.toHaveProperty('permission');
    expect(body.stream).toBeUndefined();
    expect(body.parallel_tool_calls).toBe(false);
    expect(omitted).toContain('stream (tool turns use non-streaming requests; streamed tool-call support is reported separately by the capability probe)');
  });
});
