/**
 * Clipboard helper.
 *
 * `navigator.clipboard` is only available in a secure context (HTTPS or
 * localhost) and can be blocked by a permission policy. Copy actions must
 * report whether the copy really happened instead of showing "Copied" for a
 * call that silently failed.
 */

export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }

  try {
    if (typeof document === 'undefined' || typeof document.execCommand !== 'function') {
      return false;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-1000px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}
