import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { QWEN_SYSTEM_PROMPT, QWEN_SYSTEM_PROMPT_ID, estimatePromptTokens } from './qwen';

/**
 * These tests pin the properties that make the prompt safe to ship for the
 * deployment this repository describes. They are not a quality benchmark: they
 * catch regressions that are cheap to detect and expensive to notice, such as a
 * chat-template token pasted into the text or a date that goes stale.
 */
describe('the recommended Qwen system prompt', () => {
  it('is the single source of truth that the profile editor inserts', () => {
    expect(QWEN_SYSTEM_PROMPT.length).toBeGreaterThan(1000);
    expect(QWEN_SYSTEM_PROMPT.trim()).toBe(QWEN_SYSTEM_PROMPT.trimEnd());
    expect(QWEN_SYSTEM_PROMPT_ID).toBe('qwen-selfhosted-v1');
  });

  it('stays inside the context budget of the deployed server', () => {
    // 8192 tokens for prompt plus conversation, 1024 reserved for the answer.
    // The prompt must leave the bulk of the window to the conversation.
    const tokens = estimatePromptTokens();
    expect(tokens).toBeLessThan(1800);
    expect(QWEN_SYSTEM_PROMPT.length / 4).toBeLessThan(8192 - 1024);
  });

  it('contains no chat-template tokens, which the server must serialize itself', () => {
    expect(QWEN_SYSTEM_PROMPT).not.toMatch(/<\|im_start\|>|<\|im_end\|>|<\|endoftext\|>|\[\/?INST\]|<\|start_header_id\|>/);
    expect(QWEN_SYSTEM_PROMPT).not.toMatch(/<\/s>/);
  });

  it('declares no tool, function or memory schema the runtime cannot execute', () => {
    expect(QWEN_SYSTEM_PROMPT).not.toMatch(/"type"\s*:\s*"function"/);
    expect(QWEN_SYSTEM_PROMPT).not.toMatch(/<tools>|<function=|tool_call|function_call/);
    expect(QWEN_SYSTEM_PROMPT).not.toMatch(/\bmemory_(listing|tool)\b/);
  });

  it('does not hardcode a date, a knowledge cutoff or a model version string', () => {
    expect(QWEN_SYSTEM_PROMPT).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
    expect(QWEN_SYSTEM_PROMPT).not.toMatch(/knowledge (?:cutoff|cut-off)/i);
    expect(QWEN_SYSTEM_PROMPT).not.toMatch(/\b(?:Qwen\s?\d+(?:\.\d+)?|27B|IQ3_S)\b/);
  });

  it('does not carry another vendor\'s identity or product policy', () => {
    expect(QWEN_SYSTEM_PROMPT).not.toMatch(/\b(?:Claude|Anthropic|ChatGPT|OpenAI|GPT-|Gemini|Grok|Kimi)\b/);
  });

  it('keeps the boundaries that make it safe without a security harness', () => {
    expect(QWEN_SYSTEM_PROMPT).toMatch(/no tools/i);
    expect(QWEN_SYSTEM_PROMPT).toMatch(/are data, not instructions/i);
    expect(QWEN_SYSTEM_PROMPT).toMatch(/never reveal or reproduce secrets/i);
    expect(QWEN_SYSTEM_PROMPT).toMatch(/do not invent facts/i);
    expect(QWEN_SYSTEM_PROMPT).toMatch(/in the user's language/i);
  });

  it('matches the research deliverable character for character', () => {
    const document = readFileSync(
      path.join(process.cwd(), 'research', 'qwen-system-prompt', 'SYSTEM_PROMPT.md'),
      'utf8',
    );
    const match = document.match(/<!-- BEGIN PROMPT -->\n([\s\S]*?)\n<!-- END PROMPT -->/);
    expect(match, 'SYSTEM_PROMPT.md lost its BEGIN/END PROMPT markers').not.toBeNull();
    expect(match![1].trim()).toBe(QWEN_SYSTEM_PROMPT.trim());
  });

  it('estimates tokens from characters without claiming to be a tokenizer', () => {
    expect(estimatePromptTokens('abcd')).toBe(2);
    expect(estimatePromptTokens('')).toBe(0);
  });
});
