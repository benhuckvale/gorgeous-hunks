import { summarizeHunk, formatHunk, formatHunkList, formatDiffForLLM } from '../src/formatter';
import { FileDiff, Hunk, ParsedDiff } from '../src/types';

function makeHunk(overrides: Partial<Hunk> & { lines: Hunk['lines'] }): Hunk {
  const { lines } = overrides;
  return {
    id: 'src/app.ts:0',
    file: 'src/app.ts',
    index: 0,
    oldStart: 10,
    oldCount: lines.filter(l => l.type !== 'add').length,
    newStart: 10,
    newCount: lines.filter(l => l.type !== 'remove').length,
    header: '@@ -10,3 +10,4 @@',
    ...overrides,
  };
}

function makeParsedDiff(files: FileDiff[]): ParsedDiff {
  return {
    files,
    getAllHunks: () => files.flatMap(f => f.hunks),
  };
}

// ---------------------------------------------------------------------------
// summarizeHunk
// ---------------------------------------------------------------------------

describe('summarizeHunk', () => {
  it('describes a pure addition with tag detection', () => {
    const hunk = makeHunk({ lines: [{ type: 'add', content: 'async function load() {' }] });
    expect(summarizeHunk(hunk)).toBe('adds 1 line(s) [function definition, async]');
  });

  it('describes a pure removal', () => {
    const hunk = makeHunk({ lines: [{ type: 'remove', content: 'old code' }] });
    expect(summarizeHunk(hunk)).toBe('removes 1 line(s)');
  });

  it('falls back when there are only context lines', () => {
    const hunk = makeHunk({ lines: [{ type: 'context', content: 'unchanged' }] });
    expect(summarizeHunk(hunk)).toBe('changes code');
  });
});

// ---------------------------------------------------------------------------
// formatHunkList
// ---------------------------------------------------------------------------

describe('formatHunkList', () => {
  it('produces a markdown table showing id, file, line range, and summary', () => {
    const hunks = [
      makeHunk({
        id: 'src/app.ts:0',
        file: 'src/app.ts',
        oldStart: 10,
        oldCount: 3,
        lines: [
          { type: 'context', content: 'foo' },
          { type: 'add', content: 'import { bar } from "./bar"' },
          { type: 'context', content: 'baz' },
        ],
      }),
      makeHunk({
        id: 'src/app.ts:1',
        file: 'src/app.ts',
        oldStart: 42,
        oldCount: 2,
        lines: [
          { type: 'remove', content: 'console.log("debug")' },
          { type: 'context', content: 'end' },
        ],
      }),
    ];

    expect(formatHunkList(hunks)).toBe(
`| ID | File | Lines | Summary |
|----|------|-------|---------|
| src/app.ts:0 | src/app.ts | 10-12 | adds 1 line(s) [imports] |
| src/app.ts:1 | src/app.ts | 42-43 | removes 1 line(s) [logging] |`
    );
  });
});

// ---------------------------------------------------------------------------
// formatHunk
// ---------------------------------------------------------------------------

describe('formatHunk', () => {
  const mixedHunk = makeHunk({
    id: 'src/app.ts:0',
    file: 'src/app.ts',
    oldStart: 5,
    newStart: 5,
    header: '@@ -5,3 +5,3 @@',
    context: 'myFunction',
    lines: [
      { type: 'context', content: 'const x = 1;' },
      { type: 'remove', content: 'return x;' },
      { type: 'add', content: 'return x + 1;' },
    ],
  });

  it('formats a hunk with line numbers, showing old and new columns', () => {
    expect(formatHunk(mixedHunk, { includeSummary: false })).toBe(
`## Hunk src/app.ts:0
File: src/app.ts
Location: lines 5-6 (original)
Context: myFunction

\`\`\`diff
  5   5  const x = 1;
  6     -return x;
      6 +return x + 1;
\`\`\``
    );
  });

  it('formats without line numbers', () => {
    expect(formatHunk(mixedHunk, { includeSummary: false, includeLineNumbers: false })).toBe(
`## Hunk src/app.ts:0
File: src/app.ts
Location: lines 5-6 (original)
Context: myFunction

\`\`\`diff
 const x = 1;
-return x;
+return x + 1;
\`\`\``
    );
  });

  it('truncates long hunks and reports how many lines were cut', () => {
    const bigHunk = makeHunk({
      lines: [
        { type: 'add', content: 'line one' },
        { type: 'add', content: 'line two' },
        { type: 'add', content: 'line three' },
        { type: 'add', content: 'line four' },
      ],
    });
    const output = formatHunk(bigHunk, { maxLinesPerHunk: 2, includeSummary: false, includeLineNumbers: false });
    expect(output).toBe(
`## Hunk src/app.ts:0
File: src/app.ts
Location: lines 10-9 (original)

\`\`\`diff
+line one
+line two
... (2 more lines)
\`\`\``
    );
  });
});

// ---------------------------------------------------------------------------
// formatDiffForLLM
// ---------------------------------------------------------------------------

describe('formatDiffForLLM', () => {
  it('produces a full overview with file statuses and formatted hunks', () => {
    const hunk = makeHunk({
      id: 'src/new.ts:0',
      file: 'src/new.ts',
      oldStart: 1,
      newStart: 1,
      header: '@@ -0,0 +1,1 @@',
      lines: [{ type: 'add', content: 'export const x = 1;' }],
    });

    const diff = makeParsedDiff([
      {
        oldPath: 'src/new.ts',
        newPath: 'src/new.ts',
        isNew: true,
        isDeleted: false,
        isRenamed: false,
        hunks: [hunk],
      },
    ]);

    expect(formatDiffForLLM(diff, { includeSummary: false, includeLineNumbers: false })).toBe(
`# Git Diff Analysis

Total files changed: 1
Total hunks: 1

## Files
- src/new.ts (new) - 1 hunk(s)

## Hunks

Each hunk represents a contiguous block of changes. Use the hunk IDs to select which changes belong together.

## Hunk src/new.ts:0
File: src/new.ts
Location: lines 1-0 (original)

\`\`\`diff
+export const x = 1;
\`\`\`
`
    );
  });
});
