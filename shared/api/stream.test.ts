import { describe, expect, it } from 'vitest';

import { extractDelta, parseSseStream } from './stream';

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
