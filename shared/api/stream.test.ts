import { describe, expect, it } from 'vitest';

import { extractDelta, MAX_SSE_EVENT_BYTES, parseSseStream, ToolCallAccumulator } from './stream';

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

  it('reads reasoning from the vLLM-style delta.reasoning field without duplicating it into content', () => {
    const delta = extractDelta({
      data: JSON.stringify({
        choices: [{ delta: { reasoning: 'thinking…', content: 'answer' }, finish_reason: null }],
      }),
    });
    expect(delta.reasoning).toBe('thinking…');
    expect(delta.content).toBe('answer');

    // When both spellings are present the canonical llama.cpp field wins and
    // the text is reported once, never concatenated from the two fields.
    const both = extractDelta({
      data: JSON.stringify({
        choices: [{ delta: { reasoning: 'duplicate', reasoning_content: 'canonical', content: null } }],
      }),
    });
    expect(both.reasoning).toBe('canonical');
    expect(both.content).toBeUndefined();
  });

  it('flags a conflicting tool-call id or name on one index as overflow instead of merging two calls', () => {
    const accumulator = new ToolCallAccumulator();
    accumulator.add(deltaEvent({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'files_list', arguments: '{}' } }] } }],
    }));
    accumulator.add(deltaEvent({
      choices: [{
        delta: { tool_calls: [{ index: 0, id: 'call-2', function: { name: 'code_execute', arguments: '{}' } }] },
        finish_reason: 'tool_calls',
      }],
    }));
    const assembled = accumulator.finish();
    expect(assembled.overflow).toBe(true);
    expect(assembled.calls).toHaveLength(0);
  });

  it('an abort wakes a read that is still waiting for the next chunk', async () => {
    const hanging = new ReadableStream<Uint8Array>({
      start() {
        // Never enqueue and never close: only cancellation can end this.
      },
    });
    const controller = new AbortController();
    const collected = (async () => {
      const events = [];
      for await (const event of parseSseStream(hanging, controller.signal)) events.push(event);
      return events;
    })();
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const outcome = await Promise.race([
      collected.then(() => 'ended' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 500)),
    ]);
    expect(outcome).toBe('ended');
  });

  it('survives malformed events without throwing', () => {
    const accumulator = new ToolCallAccumulator();
    accumulator.add(extractDelta({ data: 'not json' }));
    accumulator.add(deltaEvent({ choices: [{ delta: { tool_calls: 'nope' } }] }));
    expect(accumulator.finish().calls).toHaveLength(0);
  });
});

describe('parseSseStream event-size and encoding boundaries', () => {
  function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
  }

  it('rejects a single event that grows past the limit without terminating', async () => {
    // No blank-line separator: the buffer would otherwise grow for the whole
    // request timeout. Just over MAX_SSE_EVENT_BYTES (4 MiB) must reject.
    const stream = streamOf(['data: ', 'x'.repeat(4 * 1024 * 1024 + 100)]);
    let events = 0;
    const consume = async () => {
      for await (const frame of parseSseStream(stream)) events += frame.data.length;
    };
    await expect(consume()).rejects.toThrow(/maximum size of a single event/i);
    expect(events).toBe(0);
  });

  it('delivers a large-but-terminated event below the limit', async () => {
    // 1 MiB of payload, correctly terminated: must pass through unchanged.
    const payload = 'x'.repeat(1024 * 1024);
    const stream = streamOf([`data: ${payload}\n\n`]);
    const events = [];
    for await (const event of parseSseStream(stream)) events.push(event);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toBe(payload);
  });

  it('reads a stream that uses bare CR line ends', async () => {
    const stream = streamOf(['data: a\r\rdata: b\r\r']);
    const events = [];
    for await (const event of parseSseStream(stream)) events.push(event);
    expect(events.map((event) => event.data)).toEqual(['a', 'b']);
  });

  it('does not corrupt a multi-byte character split across chunk boundaries', async () => {
    // "前" is 3 UTF-8 bytes at offsets 6,7,8 of this frame; split the frame
    // after 8 bytes so the second chunk starts mid-character.
    const bytes = new TextEncoder().encode('data: 前半\n\n');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 8));
        controller.enqueue(bytes.subarray(8));
        controller.close();
      },
    });
    const events = [];
    for await (const event of parseSseStream(stream)) events.push(event);
    expect(events.map((event) => event.data)).toEqual(['前半']);
  });

  it('delivers a final well-formed frame that lacks a trailing blank line', async () => {
    // On clean completion the parser flushes a terminal frame even without a
    // trailing blank line, so the last delta is not silently dropped.
    const stream = streamOf(['data: a\n\ndata: b']);
    const events = [];
    for await (const event of parseSseStream(stream)) events.push(event);
    expect(events.map((event) => event.data)).toEqual(['a', 'b']);
  });

  async function consumeCount(stream: ReadableStream<Uint8Array>): Promise<number> {
    let count = 0;
    for await (const frame of parseSseStream(stream)) {
      expect(frame.data).toBeTypeOf('string');
      count += 1;
    }
    return count;
  }

  it('rejects a multi-byte event that exceeds the byte limit although it fits in code units', async () => {
    // '汉' is 3 UTF-8 bytes per code unit: 1.5 million units is far below
    // MAX_SSE_EVENT_BYTES if that number were read as code units, but
    // 4,500,000 actual bytes, over the 4 MiB byte limit.
    const stream = streamOf(['data: ', '汉'.repeat(1_500_000)]);
    await expect(consumeCount(stream)).rejects.toThrow(/maximum size of a single event/i);
  });

  it('delivers a large multi-byte event that stays below the byte limit', async () => {
    // 1M CJK characters are 3 MiB of UTF-8 bytes: under the cap, so the
    // byte-aware accounting must not reject a legal event.
    const payload = '汉'.repeat(1_000_000);
    const stream = streamOf([`data: ${payload}\n\n`]);
    const events = [];
    for await (const event of parseSseStream(stream)) events.push(event);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toBe(payload);
  });

  it('treats the event limit as inclusive: exactly the limit passes, one byte more is rejected', async () => {
    // Unterminated events at stream end (the cap counts the event text,
    // `data: ` included): exactly MAX_SSE_EVENT_BYTES passes, +1 fails.
    const atLimit = streamOf([`data: ${'x'.repeat(MAX_SSE_EVENT_BYTES - 6)}`]);
    await expect(consumeCount(atLimit)).resolves.toBe(1);

    const overLimit = streamOf([`data: ${'x'.repeat(MAX_SSE_EVENT_BYTES - 5)}`]);
    await expect(consumeCount(overLimit)).rejects.toThrow(/maximum size of a single event/i);
  });

  it('delivers many small complete events that arrive in one oversized chunk', async () => {
    // One 5 MiB network chunk made of 5,120 exactly-1,024-byte events: no
    // single event is anywhere near the cap, so the cap must bound one
    // unterminated event, not the size of a chunk.
    const event = `data: ${'z'.repeat(1016)}\n\n`;
    expect(new TextEncoder().encode(event).byteLength).toBe(1024);
    const stream = streamOf([event.repeat(5120)]);
    await expect(consumeCount(stream)).resolves.toBe(5120);
  });

  it('rejects a multi-byte event over the byte limit when it arrives in many chunks', async () => {
    // The over-limit event from above fed in 512-byte chunks, so chunk
    // boundaries fall inside multi-byte characters regularly (512 is not a
    // multiple of 3): the byte accounting must stay exact across
    // partial-character chunking and still reject.
    const bytes = new TextEncoder().encode(`data: ${'汉'.repeat(1_500_000)}`);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.byteLength; offset += 512) {
          controller.enqueue(bytes.subarray(offset, offset + 512));
        }
        controller.close();
      },
    });
    await expect(consumeCount(stream)).rejects.toThrow(/maximum size of a single event/i);
  });

  it('rejects a pending event that the final decoder flush pushes over the limit', async () => {
    // The event crosses the limit only at the very end: the last chunk ends
    // inside a multi-byte character, so those bytes are only decoded (as a
    // replacement character) when the stream closes. The cap must also hold
    // on the final flush, not only between chunks.
    const head = new TextEncoder().encode(`data: ${'x'.repeat(MAX_SSE_EVENT_BYTES - 7)}`);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(head);
        controller.enqueue(new Uint8Array([0xe6, 0xb5])); // first 2 bytes of '汉'
        controller.close();
      },
    });
    await expect(consumeCount(stream)).rejects.toThrow(/maximum size of a single event/i);
  });

  it('cancels the reader when the limit is exceeded so no connection stays open', async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: ok\n\n'));
        controller.enqueue(encoder.encode(`data: ${'x'.repeat(MAX_SSE_EVENT_BYTES)}`));
        // The stream never closes: only the cap rejection can end iteration.
      },
      cancel() { cancelled = true; },
    });
    const collected: string[] = [];
    await expect(
      (async () => {
        for await (const frame of parseSseStream(stream)) collected.push(frame.data);
      })(),
    ).rejects.toThrow(/maximum size of a single event/i);
    expect(collected).toEqual(['ok']);
    expect(cancelled).toBe(true);
  });

  it('does not deliver a trailing partial event after an abort mid-stream', async () => {
    const hanging = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: done\n\n'));
        controller.enqueue(new TextEncoder().encode('data: half'));
        // never closes
      },
    });
    const controller = new AbortController();
    const collected = (async () => {
      const data: string[] = [];
      for await (const frame of parseSseStream(hanging, controller.signal)) data.push(frame.data);
      return data;
    })();
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(collected).resolves.toEqual(['done']);
  });

  it('splits multi-byte events on LF and CRLF separators within one stream', async () => {
    const stream = streamOf(['data: 前\r\n\r\n', 'data: 半\n\n']);
    const data: string[] = [];
    for await (const frame of parseSseStream(stream)) data.push(frame.data);
    expect(data).toEqual(['前', '半']);
  });
});


describe('extractDelta - structured proxy error codes', () => {
  it('derives the kind from the code, not from the message', () => {
    expect(extractDelta({
      data: JSON.stringify({ error: { code: 'stream_timeout', message: 'too slow' } }),
    })).toEqual({ error: 'too slow', errorCode: 'stream_timeout', errorKind: 'timeout' });
    expect(extractDelta({
      data: JSON.stringify({ error: { code: 'upstream_stream_failed', message: 'broken' } }),
    })).toEqual({ error: 'broken', errorCode: 'upstream_stream_failed', errorKind: 'inference' });
  });

  it('does not trust an unknown code or an error kind supplied by the payload', () => {
    expect(extractDelta({
      data: JSON.stringify({ error: { code: 'spoofed', kind: 'timeout', message: 'nope' } }),
    })).toEqual({ error: 'nope', errorCode: 'spoofed' });
    expect(extractDelta({ data: JSON.stringify({ error: { message: 'plain' } }) })).toEqual({ error: 'plain' });
  });

  it('ignores malformed, null and non-object error payloads', () => {
    expect(extractDelta({ data: 'null' })).toEqual({});
    expect(extractDelta({ data: '42' })).toEqual({});
    expect(extractDelta({ data: 'not json' })).toEqual({});
  });
});
