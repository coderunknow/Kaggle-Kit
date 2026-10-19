/**
 * Conversation export.
 *
 * The export is plain Markdown: it keeps headings, lists, tables and code
 * fences of the answers and it is readable without this application. Only
 * the data of the conversation is written; no key, no hidden state and no
 * provider specific metadata is included.
 */

import type { ApiProfile, ChatMessage, Conversation } from '../../shared/domain';
import { formatTimestamp } from './id';

function statusNote(message: ChatMessage): string | null {
  if (message.status === 'cancelled') return '_The request was cancelled. The text above is the partial answer._';
  if (message.status === 'error') {
    const reason = message.errorMessage ? ` ${message.errorMessage}` : '';
    return `_The request failed.${reason}_`;
  }
  return null;
}

/** Render a conversation as a self-contained Markdown document. */
export function conversationToMarkdown(
  conversation: Conversation,
  profile?: ApiProfile,
): string {
  const lines: string[] = [];
  lines.push(`# ${conversation.title}`);
  lines.push('');
  lines.push(`- Exported: ${new Date().toISOString()}`);
  lines.push(`- Conversation started: ${conversation.createdAt}`);
  lines.push(`- Last activity: ${conversation.updatedAt}`);
  if (profile) {
    lines.push(`- Connection: ${profile.name} (${profile.baseUrl})`);
  }
  if (profile?.modelId) {
    lines.push(`- Model: ${profile.modelId}`);
  }
  lines.push('');
  lines.push('---');

  for (const message of conversation.messages) {
    lines.push('');
    lines.push(message.role === 'user' ? '## You' : '## Assistant');
    lines.push('');
    lines.push(`_${formatTimestamp(message.createdAt)}_`);
    lines.push('');
    if (message.content.trim()) {
      lines.push(message.content.trimEnd());
    } else {
      lines.push('_(no text)_');
    }
    const note = statusNote(message);
    if (note) {
      lines.push('');
      lines.push(note);
    }
    if (message.usage && typeof message.usage.total_tokens === 'number') {
      lines.push('');
      lines.push(`_Tokens reported by the server: ${message.usage.total_tokens}_`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

/** A file name that is safe on every common platform. */
export function exportFileName(title: string): string {
  const cleaned = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${cleaned || 'conversation'}.md`;
}

/**
 * Start a download of the conversation. Returns false when the browser does
 * not support creating an object URL, so the caller does not claim success.
 */
export function downloadConversation(
  conversation: Conversation,
  profile?: ApiProfile,
): boolean {
  try {
    const markdown = conversationToMarkdown(conversation, profile);
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = exportFileName(conversation.title);
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Revoke on the next task; revoking synchronously can cancel the
    // download in some browsers.
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
  } catch {
    return false;
  }
}
