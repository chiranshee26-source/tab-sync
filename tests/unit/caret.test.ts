import { describe, expect, it } from 'vitest';
import { adjustCaret } from '../../src/app/components/SyncedText';

describe('adjustCaret (remote edits while you type)', () => {
  it('keeps the caret when the edit happens after it', () => {
    expect(adjustCaret('hello', 'hello world', 2)).toBe(2);
  });

  it('shifts the caret when text is inserted before it', () => {
    expect(adjustCaret('world', 'Hello world', 5)).toBe(11);
  });

  it('shifts the caret back when text before it is deleted', () => {
    expect(adjustCaret('Hello world', 'world', 8)).toBe(2);
  });

  it('clamps when the text gets shorter than the caret', () => {
    expect(adjustCaret('abcdef', 'xy', 4)).toBe(2);
  });
});
