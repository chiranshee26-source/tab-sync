import { useLayoutEffect, useRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';

type Field = HTMLInputElement | HTMLTextAreaElement;

/**
 * Where should the caret go when the text changes under it? Text before the
 * caret that is unchanged keeps the caret in place; otherwise it shifts with
 * the edit (so remote typing above the caret does not push you around).
 */
export function adjustCaret(oldText: string, newText: string, caret: number): number {
  if (oldText.slice(0, caret) === newText.slice(0, caret)) return Math.min(caret, newText.length);
  // Common suffix: the edit happened before the caret.
  const tail = oldText.length - caret;
  if (oldText.slice(caret) === newText.slice(newText.length - tail)) return newText.length - tail;
  return Math.min(caret, newText.length);
}

/**
 * Uncontrolled field that follows `value` from the store without ever
 * stealing focus or jumping the caret, and that leaves IME composition
 * (Japanese, Hindi, …) alone until it finishes.
 */
function useSyncedField<T extends Field>(value: string) {
  const ref = useRef<T>(null);
  const composing = useRef(false);
  // Only the first value: React re-applies a changed `defaultValue`, which
  // would replace the text (and reset the caret) before the effect below runs.
  const initial = useRef(value);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || el.value === value || composing.current) return;
    if (document.activeElement !== el) {
      el.value = value;
      return;
    }
    const start = adjustCaret(el.value, value, el.selectionStart ?? 0);
    const end = adjustCaret(el.value, value, el.selectionEnd ?? 0);
    el.value = value;
    el.setSelectionRange(start, end);
  }, [value]);

  return {
    ref,
    defaultValue: initial.current,
    onCompositionStart: () => (composing.current = true),
    onCompositionEnd: () => (composing.current = false),
  };
}

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'defaultValue' | 'onChange'> & {
  value: string;
  onValue: (value: string) => void;
};

export function SyncedInput({ value, onValue, ...rest }: InputProps) {
  const field = useSyncedField<HTMLInputElement>(value);
  return <input dir="auto" {...rest} {...field} onChange={(event) => onValue(event.target.value)} />;
}

type TextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'defaultValue' | 'onChange'> & {
  value: string;
  onValue: (value: string) => void;
};

export function SyncedTextarea({ value, onValue, ...rest }: TextareaProps) {
  const field = useSyncedField<HTMLTextAreaElement>(value);
  return <textarea dir="auto" {...rest} {...field} onChange={(event) => onValue(event.target.value)} />;
}
