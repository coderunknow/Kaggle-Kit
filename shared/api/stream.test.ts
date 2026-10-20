import { describe, expect, it } from 'vitest';

import { extractDelta, parseSseStream, ToolCallAccumulator } from './stream';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe('parseSseStream', () => {
  it('parses OpenAI compatible chunks', async () => {
    const stream = streamOf([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: [DONE]\n\n',
    ]);

    const events = [];
    for await (const event of parseSseStream(stream)) events.push(event);

    expect(events).toHaveLength(3);
    expect(extractDelta(events[0]!).content).toBe('Hel');
    expect(extractDelta(events[1]!).content).toBe('lo');
    expect(extractDelta(events[2]!).finishReason).toBe('stop');
  });

  it('reassembles chunks that split an event in the middle', async () => {
    const stream = streamOf(['data: {"choices":[{"delta":{"cont', 'ent":"split"}}]}\n\n']);

    const events = [];
    for await (const event of parseSseStream(stream)) events.push(event);

    expect(events).toHaveLength(1);
    expect(extractDelta(events[0]!).content).toBe('split');
  });

  it('ignores comment lines', async () => {
    const stream = streamOf([': keep alive\n\n', 'data: {"choices":[]}\n\n']);

    const events = [];
    for await (const event of parseSseStream(stream)) events.push(event);

    expect(events).toHaveLength(1);
  });

  it('reads a stream that uses CRLF line ends', async () => {
    const stream = streamOf([
      'data: {"choices":[{"delta":{"content":"a"}}]}\r\n\r\n',
      'data: {"choices":[{"delta":{"content":"b"}}]}\r\n\r\n',
      'data: [DONE]\r\n\r\n',
    ]);

    const events = [];
    for await (const event of parseSseStream(stream)) events.push(event);

    expect(events).toHaveLength(3);
    expect(extractDelta(events[0]!).content).toBe('a');
    expect(extractDelta(events[2]!).finishReason).toBe('stop');
  });

  it('reads a frame that is split over several chunks', async () => {
    const stream = streamOf(['data: {"choices":[{"delta":', '{"content":"split"}}]}\n', '\n']);

    const events = [];
    for await (const event of parseSseStream(stream)) events.push(event);

    expect(events).toHaveLength(1);
    expect(extractDelta(events[0]!).content).toBe('split');
  });

});

describe('ToolCallAccumulator', () => {
  function deltaEvent(payload: unknown) {
    return extractDelta({ data: JSON.stringify(payload) });
  }

  it('assembles argument JSON split across streamed fragments', () => {
    const accumulator = new ToolCallAccumulator();
    accumulator.add(deltaEvent({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'calculator_calculate', arguments: '{"expr' } }] } }],
    }));
    accumulator.add(deltaEvent({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ession":"2+' } }] } }],
    }));
    accumulator.add(deltaEvent({
      choices: [{
        delta: { tool_calls: [{ index: 0, function: { arguments: '3"}' } }] },
        finish_reason: 'tool_calls',
      }],
    }));
    const assembled = accumulator.finish();
    expect(assembled.announced).toBe(true);
    expect(assembled.overflow).toBe(false);
    expect(assembled.calls).toEqual([{
      id: 'call-1',
      type: 'function',
      function: { name: 'calculator_calculate', arguments: '{"expression":"2+3"}' },
    }]);
    // The assembled arguments are a complete JSON document only at the end.
    expect(JSON.parse(assembled.calls[0]!.function.arguments)).toEqual({ expression: '2+3' });
  });

  it('keeps interleaved calls apart by index and sorts them', () => {
    const accumulator = new ToolCallAccumulator();
    accumulator.add(deltaEvent({
      choices: [{
        delta: {
          tool_calls: [
            { index: 1, id: 'call-b', function: { name: 'files_list', arguments: '{}' } },
            { index: 0, id: 'call-a', function: { name: 'calculator_calculate', arguments: '{"expression":"1"}' } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    }));
    const assembled = accumulator.finish();
    expect(assembled.calls.map((call) => call.id)).toEqual(['call-a', 'call-b']);
  });

  it('does not announce calls without finish_reason=tool_calls', () => {
    const accumulator = new ToolCallAccumulator();
    accumulator.add(deltaEvent({
      choices: [{
        delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'files_list', arguments: '{}' } }] },
        finish_reason: 'stop',
      }],
    }));
    expect(accumulator.finish().announced).toBe(false);
  });

  it('flags oversized arguments and incomplete calls as overflow', () => {
    const oversized = new ToolCallAccumulator(8, 8);
    oversized.add(deltaEvent({
      choices: [{
        delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'code_execute', arguments: '{"code":"aaaaaaaaaaaaaaaa"}' } }] },
        finish_reason: 'tool_calls',
      }],
    }));
    expect(oversized.finish().overflow).toBe(true);

    const incomplete = new ToolCallAccumulator();
    incomplete.add(deltaEvent({
      choices: [{
        delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] },
        finish_reason: 'tool_calls',
      }],
    }));
    const result = incomplete.finish();
    expect(result.calls).toHaveLength(0);
    expect(result.overflow).toBe(true);
  });

  it('survives malformed events without throwing', () => {
    const accumulator = new ToolCallAccumulator();
    accumulator.add(extractDelta({ data: 'not json' }));
    accumulator.add(deltaEvent({ choices: [{ delta: { tool_calls: 'nope' } }] }));
    expect(accumulator.finish().calls).toHaveLength(0);
  });
});
