import { hunkToLLMHunk, formatHunksForLLM, analyzeHunks } from '../src/llm-interface';
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
    header: '@@ -10,2 +10,2 @@',
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
// hunkToLLMHunk
// ---------------------------------------------------------------------------

describe('hunkToLLMHunk', () => {
  it('assigns sequential indices to all lines', () => {
    const hunk = makeHunk({
      lines: [
        { type: 'context', content: 'a' },
        { type: 'remove', content: 'b' },
        { type: 'add', content: 'c' },
        { type: 'context', content: 'd' },
      ],
    });
    const result = hunkToLLMHunk(hunk);
    expect(result.lines.map(l => l.index)).toEqual([0, 1, 2, 3]);
  });

  it('tracks oldLineNo and newLineNo correctly across add/remove/context', () => {
    const hunk = makeHunk({
      oldStart: 5,
      newStart: 5,
      lines: [
        { type: 'context', content: 'ctx' },   // old=5, new=5
        { type: 'remove', content: 'gone' },   // old=6, new=—
        { type: 'add', content: 'here' },      // old=—, new=6
        { type: 'context', content: 'end' },   // old=7, new=7
      ],
    });
    const { lines } = hunkToLLMHunk(hunk);
    expect(lines[0]).toMatchObject({ type: 'context', oldLineNo: 5, newLineNo: 5 });
    expect(lines[1]).toMatchObject({ type: 'remove', oldLineNo: 6 });
    expect(lines[1].newLineNo).toBeUndefined();
    expect(lines[2]).toMatchObject({ type: 'add', newLineNo: 6 });
    expect(lines[2].oldLineNo).toBeUndefined();
    expect(lines[3]).toMatchObject({ type: 'context', oldLineNo: 7, newLineNo: 7 });
  });

  it('collects addedLineIndices and removedLineIndices correctly', () => {
    const hunk = makeHunk({
      lines: [
        { type: 'context', content: 'a' },
        { type: 'add', content: 'b' },
        { type: 'remove', content: 'c' },
        { type: 'add', content: 'd' },
      ],
    });
    const result = hunkToLLMHunk(hunk);
    expect(result.addedLineIndices).toEqual([1, 3]);
    expect(result.removedLineIndices).toEqual([2]);
  });

  it('complexityHint is 1 for a simple single-change hunk', () => {
    const hunk = makeHunk({
      lines: [
        { type: 'context', content: 'a' },
        { type: 'add', content: 'b' },
        { type: 'context', content: 'c' },
      ],
    });
    expect(hunkToLLMHunk(hunk).complexityHint).toBe(1);
  });

  it('complexityHint is 4 for a hunk with multiple additions', () => {
    const hunk = makeHunk({
      lines: [
        { type: 'add', content: 'first' },
        { type: 'add', content: 'second' },
      ],
    });
    expect(hunkToLLMHunk(hunk).complexityHint).toBe(4);
  });

  it('complexityHint is capped at 3 for a splittable hunk with multiple changes', () => {
    // Splittable = has a context gap between change groups
    const hunk = makeHunk({
      lines: [
        { type: 'add', content: 'first change' },
        { type: 'context', content: 'gap 1' },
        { type: 'context', content: 'gap 2' },
        { type: 'add', content: 'second change' },
      ],
    });
    const result = hunkToLLMHunk(hunk);
    expect(result.splittable).toBe(true);
    expect(result.complexityHint).toBe(3);
  });

  it('reports splitCount when splittable', () => {
    const hunk = makeHunk({
      lines: [
        { type: 'add', content: 'first' },
        { type: 'context', content: 'gap 1' },
        { type: 'context', content: 'gap 2' },
        { type: 'add', content: 'second' },
      ],
    });
    const result = hunkToLLMHunk(hunk);
    expect(result.splittable).toBe(true);
    expect(result.splitCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// formatHunksForLLM — snapshot showing rendered output
// ---------------------------------------------------------------------------

describe('formatHunksForLLM', () => {
  it('renders a single hunk with indexed lines and line numbers', () => {
    const hunk = makeHunk({
      id: 'src/app.ts:0',
      file: 'src/app.ts',
      oldStart: 5,
      newStart: 5,
      context: 'myFunction',
      lines: [
        { type: 'context', content: 'const x = 1;' },
        { type: 'remove', content: 'return x;' },
        { type: 'add', content: 'return x + 1;' },
      ],
    });

    const diff = makeParsedDiff([
      {
        oldPath: 'src/app.ts',
        newPath: 'src/app.ts',
        isNew: false, isDeleted: false, isRenamed: false,
        hunks: [hunk],
      },
    ]);

    expect(formatHunksForLLM(diff)).toBe(
`# Unstaged Changes Analysis

Total: 1 hunk(s) across 1 file(s)

## File: src/app.ts

### Hunk: src/app.ts:0
Context: myFunction
Summary: +1 lines, -1 lines

\`\`\`
[ 0]   5:  5   const x = 1;
[ 1]   6:    - return x;
[ 2]    :  6 + return x + 1;
\`\`\`
Added lines: [2]
Removed lines: [1]

---

## How to Stage Changes

For each logical commit, specify which hunks/lines belong together:

\`\`\`json
{
  "commits": [
    {
      "message": "feat: add logging",
      "hunks": [
        { "id": "app.js:0", "action": "stage_all" },
        { "id": "app.js:1", "action": "stage_partial", "includeAdditions": [0, 2] }
      ]
    }
  ]
}
\`\`\`

Actions:
- \`stage_all\`: Include entire hunk
- \`stage_partial\`: Include only specified line indices
- \`split_first\`: Split hunk, then stage resulting sub-hunks
- \`edit_line\`: Modify a line's content before staging`
    );
  });
});

// ---------------------------------------------------------------------------
// analyzeHunks
// ---------------------------------------------------------------------------

describe('analyzeHunks', () => {
  it('categorises simple, splittable, and complex hunks', () => {
    const simple = makeHunk({
      id: 'a.ts:0', file: 'a.ts',
      lines: [{ type: 'add', content: 'x' }],
    });
    const complex = makeHunk({
      id: 'b.ts:0', file: 'b.ts',
      lines: [{ type: 'add', content: 'x' }, { type: 'add', content: 'y' }],
    });
    const splittable = makeHunk({
      id: 'c.ts:0', file: 'c.ts',
      lines: [
        { type: 'add', content: 'x' },
        { type: 'context', content: 'gap' },
        { type: 'context', content: 'gap' },
        { type: 'add', content: 'y' },
      ],
    });

    const makeFile = (h: Hunk): FileDiff => ({
      oldPath: h.file, newPath: h.file,
      isNew: false, isDeleted: false, isRenamed: false,
      hunks: [h],
    });

    const result = analyzeHunks(makeParsedDiff([makeFile(simple), makeFile(complex), makeFile(splittable)]));

    expect(result.totalHunks).toBe(3);
    expect(result.simpleHunks).toEqual(['a.ts:0']);
    expect(result.complexHunks).toEqual(['b.ts:0']);
    expect(result.splittableHunks).toEqual(['c.ts:0']);
  });
});
