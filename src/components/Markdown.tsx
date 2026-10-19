/**
 * Markdown renderer.
 *
 * Uses react-markdown with GFM support and syntax highlighting. During a
 * stream the highlighting is skipped: reparsing and highlighting the whole
 * answer for every token is the most expensive work of the chat view. The
 * finished answer is highlighted normally.
 *
 * Every code block gets a language label and a copy button. The copy button
 * reports a failure instead of claiming that the copy happened.
 */

import { Children, isValidElement, memo, useCallback, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

import { copyText } from '../lib/clipboard';
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

/** Read the fence language from a `<code className="language-x">` child. */
function languageOf(children: ReactNode): string | null {
  const first = Children.toArray(children)[0];
  if (!isValidElement(first)) return null;
  const className = (first.props as { className?: string }).className ?? '';
  const match = /language-([\w+#.-]+)/.exec(className);
  return match?.[1] ?? null;
}

type CopyState = 'idle' | 'copied' | 'failed';

function CodeCopyButton({ value }: { value: string }) {
  const [state, setState] = useState<CopyState>('idle');

  const copy = useCallback(async () => {
    const copied = await copyText(value);
    setState(copied ? 'copied' : 'failed');
    window.setTimeout(() => setState('idle'), 2000);
  }, [value]);

  return (
    <button
      type="button"
      className={`code-block__copy button button--ghost button--small${state === 'failed' ? ' is-failed' : ''}`}
      onClick={() => void copy()}
      aria-label={
        state === 'copied' ? 'Code copied' : state === 'failed' ? 'Copying failed' : 'Copy code'
      }
      title={state === 'failed' ? 'The browser did not allow the copy. Select the code and copy it manually.' : undefined}
    >
      <Icon name={state === 'copied' ? 'check' : state === 'failed' ? 'alert' : 'copy'} size={13} />
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Failed' : 'Copy'}
    </button>
  );
}

export interface MarkdownProps {
  content: string;
  /** True while the answer is still streaming. */
  streaming?: boolean;
}

export const Markdown = memo(function Markdown({ content, streaming = false }: MarkdownProps) {
  return (
    <div className="markdown" data-streaming={streaming ? 'true' : undefined}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={streaming ? [] : [rehypeHighlight]}
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
            const language = languageOf(children);
            return (
              <div className="code-block">
                <div className="code-block__bar">
                  <span className="code-block__language">{language ?? 'code'}</span>
                  <CodeCopyButton value={text.replace(/\n$/, '')} />
                </div>
                <pre>{children}</pre>
              </div>
            );
          },
          table({ children }) {
            return (
              <div className="table-scroll" tabIndex={0} role="region" aria-label="Table">
                <table>{children}</table>
              </div>
            );
          },
          a({ children, href, ...props }) {
            return (
              <a href={href} target="_blank" rel="noreferrer noopener" {...props}>
                {children}
                <Icon name="external" size={11} className="markdown__external" />
              </a>
            );
          },
          img({ src, alt }) {
            // Remote images are not loaded: the content security policy only
            // allows images from this application. Showing a link is honest,
            // a broken image icon is not useful.
            return (
              <span className="markdown__image" title={typeof src === 'string' ? src : undefined}>
                [image: {alt || 'without description'}]
              </span>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
