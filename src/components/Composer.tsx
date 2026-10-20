/**
 * Message composer.
 *
 * The textarea grows with its content up to a maximum height. Enter sends and
 * Shift+Enter makes a new line, unless the user switched to Ctrl/⌘+Enter in
 * the preferences. Composition with an input method editor never sends the
 * message. The draft belongs to the caller, which persists it per
 * conversation.
 */

import { useEffect, useRef, type RefObject } from 'react';

import { useApp } from '../state/AppProvider';
import { Icon } from './ui';

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: (content: string) => void;
  onCancel: () => void;
  pending: boolean;
  disabled?: boolean;
  placeholder?: string;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
}

const MAX_HEIGHT = 224;

export function Composer({
  value,
  onChange,
  onSend,
  onCancel,
  pending,
  disabled,
  placeholder,
  inputRef,
}: ComposerProps) {
  const localRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = inputRef ?? localRef;
  const sendOnEnter = useApp().state.preferences.sendOnEnter;

  // Autosize: reset to `auto` first so the box can shrink again.
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    const next = Math.min(element.scrollHeight, MAX_HEIGHT);
    element.style.height = `${next}px`;
    element.style.overflowY = element.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden';
  }, [value, textareaRef]);

  const submit = () => {
    const content = value.trim();
    if (!content || pending || disabled) return;
    onSend(content);
    onChange('');
  };

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="composer__box" data-disabled={disabled ? 'true' : undefined}>
        <label className="visually-hidden" htmlFor="composer-input">
          Message
        </label>
        <textarea
          id="composer-input"
          ref={textareaRef}
          className="composer__input"
          value={value}
          placeholder={
            placeholder ??
            (disabled ? 'Connect a profile to start writing' : 'Send a message to the model…')
          }
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            // Enter during an IME composition inserts the candidate, not a send.
            if (event.nativeEvent.isComposing) return;

            const withModifier = event.metaKey || event.ctrlKey;
            const shouldSend = sendOnEnter
              ? event.key === 'Enter' && !event.shiftKey
              : event.key === 'Enter' && withModifier;

            if (shouldSend) {
              event.preventDefault();
              submit();
            }
          }}
          disabled={disabled}
          rows={1}
          aria-describedby="composer-hint"
          spellCheck
        />

        <div className="composer__foot">
          <span className="composer__hint" id="composer-hint">
            {sendOnEnter ? (
              <>
                <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
              </>
            ) : (
              <>
                <kbd>Ctrl</kbd>+<kbd>Enter</kbd> to send · <kbd>Enter</kbd> for a new line
              </>
            )}
            {value.trim() ? <span className="composer__draft">· draft saved locally</span> : null}
          </span>

          <div className="composer__actions">
            {pending ? (
              <button type="button" className="button composer__stop" onClick={onCancel}>
                <Icon name="stop" size={12} />
                Stop
              </button>
            ) : (
              <button
                type="submit"
                className="button button--primary composer__send"
                disabled={disabled || !value.trim()}
              >
                <Icon name="send" size={13} />
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </form>
  );
}
