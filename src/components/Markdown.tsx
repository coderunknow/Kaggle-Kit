/**
 * Markdown renderer.
 *
 * Uses react-markdown with GFM support and syntax highlighting. Code blocks
 * get a copy button; the copy action never touches credentials because only
 * the rendered content is copied.
 */

import { Children, isValidElement, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

import { Icon } from './ui';

function extractText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return extractText(props.children);
  }
  return '';
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      className="button button--small code-block__copy"
      onClick={() => void copy()}
      aria-label={copied ? 'Code copied' : 'Copy code'}
    >
      <Icon name={copied ? 'check' : 'copy'} size={13} />
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

export interface MarkdownProps {
  content: string;
}

export function Markdown({ content }: MarkdownProps) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          code({ className, children, ...props }) {
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          pre({ children }) {
            const text = extractText(children);
            return (
              <div className="code-block">
                <CopyButton value={text.trim()} />
                <pre>{children}</pre>
              </div>
            );
          },
          a({ children, href, ...props }) {
            return (
              <a href={href} target="_blank" rel="noreferrer noopener" {...props}>
                {children}
              </a>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

/** Plain text of a message, used by the "copy message" action. */
export function messageToText(messages: { role: string; content: string }[]): string {
  return messages.map((message) => `${message.role}: ${message.content}`).join('\n\n');
}

export { Children };
