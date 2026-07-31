export interface ChecklistToggleResult {
  body: string;
  matched: string;
  checked: boolean;
}

const CHECKBOX_PATTERN = /^- \[([xX ])\] /;

export function toggleChecklistItem(
  body: string,
  itemText: string,
  checked?: boolean
): ChecklistToggleResult {
  const needle = itemText.toLowerCase().trim();
  if (needle.length === 0) {
    throw new Error('checklist item text must not be empty');
  }

  const lines = body.split('\n');
  let matchIndex = -1;
  let matchedLine = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const checkbox = CHECKBOX_PATTERN.exec(line);
    if (!checkbox) continue;

    const text = line.replace(CHECKBOX_PATTERN, '').toLowerCase().trim();
    if (!text.includes(needle)) continue;

    if (matchIndex !== -1) {
      throw new Error(
        `ambiguous match: multiple checklist items contain "${itemText}"`
      );
    }

    matchIndex = i;
    matchedLine = line.replace(CHECKBOX_PATTERN, '').trim();
  }

  if (matchIndex === -1) {
    throw new Error(
      `no checklist item matching "${itemText}" found`
    );
  }

  const originalLine = lines[matchIndex];
  const wasChecked = /- \[[xX]\] /.test(originalLine);
  const newChecked = checked !== undefined ? checked : !wasChecked;

  lines[matchIndex] = newChecked
    ? originalLine.replace(/^- \[ \] /, '- [x] ')
    : originalLine.replace(/^- \[[xX]\] /, '- [ ] ');

  return {
    body: lines.join('\n'),
    matched: matchedLine,
    checked: newChecked,
  };
}
