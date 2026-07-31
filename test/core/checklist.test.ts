import { describe, it, expect } from 'vitest';
import { toggleChecklistItem } from '../../src/core/checklist.js';

describe('toggleChecklistItem', () => {
  it('toggles an unchecked item to checked', () => {
    const body = '- [ ] first task\n- [ ] second task';
    const result = toggleChecklistItem(body, 'first');
    expect(result.checked).toBe(true);
    expect(result.matched).toBe('first task');
    expect(result.body).toBe('- [x] first task\n- [ ] second task');
  });

  it('toggles a checked item to unchecked', () => {
    const body = '- [x] first task\n- [ ] second task';
    const result = toggleChecklistItem(body, 'first');
    expect(result.checked).toBe(false);
    expect(result.body).toBe('- [ ] first task\n- [ ] second task');
  });

  it('matches by partial text', () => {
    const body = '- [ ] update the README file';
    const result = toggleChecklistItem(body, 'README');
    expect(result.checked).toBe(true);
    expect(result.matched).toBe('update the README file');
  });

  it('honours explicit checked state', () => {
    const body = '- [x] first task';
    const result = toggleChecklistItem(body, 'first', false);
    expect(result.checked).toBe(false);
    expect(result.body).toBe('- [ ] first task');
  });

  it('throws when no item matches', () => {
    const body = '- [ ] one\n- [ ] two';
    expect(() => toggleChecklistItem(body, 'three')).toThrow(
      'no checklist item matching "three" found'
    );
  });

  it('throws when multiple items match', () => {
    const body = '- [ ] update docs\n- [ ] update tests';
    expect(() => toggleChecklistItem(body, 'update')).toThrow(
      'ambiguous match'
    );
  });

  it('does not confuse non-checkbox lines', () => {
    const body = 'update docs\n- [ ] update docs';
    const result = toggleChecklistItem(body, 'docs');
    expect(result.checked).toBe(true);
    expect(result.body).toBe('update docs\n- [x] update docs');
  });
});
