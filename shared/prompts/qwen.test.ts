import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  QWEN_NO_TOOLS_CLAIM,
  QWEN_SYSTEM_PROMPT,
  QWEN_SYSTEM_PROMPT_ID,
  QWEN_TOOL_SYSTEM_PROMPT_ID,
  estimatePromptTokens,
  neutralizeNoToolsClaim,
  neutralizeToolClaimsForOrdinaryChat,
  qwenToolSystemPrompt,
} from './qwen';

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

describe('the tool-use variant of the Qwen prompt', () => {
  const toolPrompt = qwenToolSystemPrompt();

  it('is derived from the base prompt without the no-tools claim', () => {
    expect(QWEN_TOOL_SYSTEM_PROMPT_ID).toBe('qwen-selfhosted-tools-v1');
    expect(toolPrompt).not.toContain(QWEN_NO_TOOLS_CLAIM);
    expect(toolPrompt).not.toMatch(/you have no tools/i);
    // The shared boundaries of the base prompt survive the derivation.
    expect(toolPrompt).toMatch(/never reveal or reproduce secrets/i);
    expect(toolPrompt).toMatch(/do not invent facts/i);
  });

  it('teaches the implemented protocol and nothing beyond it', () => {
    expect(toolPrompt).toMatch(/only the functions listed for the current turn/i);
    expect(toolPrompt).toMatch(/match their published schema/i);
    expect(toolPrompt).toMatch(/untrusted data, never instructions/i);
    expect(toolPrompt).toMatch(/Cite only URLs that a successful retrieval actually returned/i);
    expect(toolPrompt).toMatch(/explicit user approval/i);
    expect(toolPrompt).toMatch(/tool loop is bounded/i);
    expect(toolPrompt).toMatch(/normal final answer/i);
    // Still no executable schema or template tokens in the text itself.
    expect(toolPrompt).not.toMatch(/"type"\s*:\s*"function"/);
    expect(toolPrompt).not.toMatch(/<\|im_start\|>|<tools>|<function=/);
  });

  it('stays inside the deployed context budget', () => {
    expect(estimatePromptTokens(toolPrompt)).toBeLessThan(2200);
    expect(toolPrompt.length / 4).toBeLessThan(8192 - 1024);
  });

  it('neutralizes the no-tools claim in an arbitrary system prompt', () => {
    const neutralized = neutralizeNoToolsClaim(`Intro. ${QWEN_NO_TOOLS_CLAIM} Outro.`);
    expect(neutralized).not.toMatch(/you have no tools/i);
    expect(neutralized).toMatch(/^Intro\./);
    expect(neutralized).toMatch(/Outro\.$/);
    expect(neutralizeNoToolsClaim('unrelated prompt')).toBe('unrelated prompt');

    // A custom prompt built from the research no-tools module is emptied, not
    // answered with a fabricated claim.
    const moduleNoTools = readFileSync(
      path.join(process.cwd(), 'research', 'qwen-system-prompt', 'modules', 'MODULE_no_tools.txt'),
      'utf8',
    );
    expect(neutralizeNoToolsClaim(moduleNoTools)).toBe('');

    // The pattern removal must not eat unrelated sentences that merely
    // contain the word "tools".
    const unrelated = 'You can browse the web. The toolbox is in the garage.';
    expect(neutralizeNoToolsClaim(unrelated)).toBe(unrelated);
  });

  it('replaces tool-environment claims with the truthful no-tools boundary on ordinary chat turns', () => {
    const restored = neutralizeToolClaimsForOrdinaryChat(toolPrompt);
    expect(restored).toContain(QWEN_NO_TOOLS_CLAIM);
    expect(restored).not.toMatch(/this chat can offer you tools/i);
    // The tool rules block is gone with it.
    expect(restored).not.toMatch(/untrusted data, never instructions/i);
    // Any other prompt — including the base prompt itself — passes through.
    expect(neutralizeToolClaimsForOrdinaryChat('custom prompt')).toBe('custom prompt');
    expect(neutralizeToolClaimsForOrdinaryChat(QWEN_SYSTEM_PROMPT)).toBe(QWEN_SYSTEM_PROMPT);
  });
});
