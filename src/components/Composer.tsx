/**
 * Message composer.
 *
 * Enter sends, Shift+Enter inserts a newline. The textarea grows with the
 * content up to a maximum height.
 */

import { useEffect, useRef, useState } from 'react';

import { useApp } from '../state/AppProvider';
import { Icon } from './ui';

export interface ComposerProps {
  onSend: (content: string) => void;
  onCancel: () => void;
  pending: boolean;
  disabled?: boolean;
  placeholder?: string;
}

export function Composer({ onSend, onCancel, pending, disabled, placeholder }: ComposerProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sendOnEnter = useApp().state.preferences.sendOnEnter;

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
  }, [value]);

  const submit = () => {
    const content = value.trim();
    if (!content || pending || disabled) return;
    onSend(content);
    setValue('');
  };

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="composer__inner">
        <div className="composer__row">
          <label className="visually-hidden" htmlFor="composer-input">
            Message
          </label>
          <textarea
            id="composer-input"
            ref={textareaRef}
            className="composer__input"
            value={value}
            placeholder={placeholder ?? 'Send a message to the model…'}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && sendOnEnter) {
                event.preventDefault();
                submit();
              }
            }}
            disabled={disabled}
            rows={1}
          />

          {pending ? (
            <button type="button" className="button" onClick={onCancel}>
              <Icon name="stop" size={14} />
              Stop
            </button>
          ) : (
            <button type="submit" className="button button--primary" disabled={disabled || !value.trim()}>
              <Icon name="send" size={14} />
              Send
            </button>
          )}
        </div>

        <div className="composer__hint">
          <span>
            {sendOnEnter ? 'Enter to send · Shift+Enter for a new line' : 'Ctrl+Enter to send · Shift+Enter for a new line'}
          </span>
          <span>{value.length} characters</span>
        </div>
      </div>
    </form>
  );
}
