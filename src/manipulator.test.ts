import { parseDiff } from '../src/parser';
import {
  isSplittable,
  splitHunk,
  selectHunks,
  selectHunksWithLines,
  editHunk,
  generatePatch,
  recalculateHeader,
} from '../src/manipulator';
import { Hunk } from '../src/types';

describe('isSplittable', () => {
  it('should return true for a hunk with context gaps', () => {
    const hunk: Hunk = {
      id: 'test:0',
      file: 'test.txt',
      index: 0,
      header: '@@ -1,10 +1,12 @@',
      oldStart: 1,
      oldCount: 10,
      newStart: 1,
      newCount: 12,
      lines: [
        { type: 'context', content: 'line 1' },
        { type: 'add', content: 'added 1' },
        { type: 'context', content: 'line 2' },
        { type: 'context', content: 'line 3' }, // gap
        { type: 'context', content: 'line 4' },
        { type: 'add', content: 'added 2' },
        { type: 'context', content: 'line 5' },
      ],
    };

    expect(isSplittable(hunk)).toBe(true);
  });

  it('should return false for a hunk without context gaps', () => {
    const hunk: Hunk = {
      id: 'test:0',
      file: 'test.txt',
      index: 0,
      header: '@@ -1,3 +1,4 @@',
      oldStart: 1,
      oldCount: 3,
      newStart: 1,
      newCount: 4,
      lines: [
        { type: 'context', content: 'line 1' },
        { type: 'add', content: 'added 1' },
        { type: 'add', content: 'added 2' },
        { type: 'context', content: 'line 2' },
      ],
    };

    expect(isSplittable(hunk)).toBe(false);
  });
});

describe('splitHunk', () => {
  it('should split a hunk at context gaps', () => {
    const hunk: Hunk = {
      id: 'test:0',
      file: 'test.txt',
      index: 0,
      header: '@@ -1,7 +1,9 @@',
      oldStart: 1,
      oldCount: 7,
      newStart: 1,
      newCount: 9,
      lines: [
        { type: 'context', content: 'line 1' },
        { type: 'add', content: 'added 1' },
        { type: 'context', content: 'line 2' },
        { type: 'context', content: 'line 3' }, // gap
        { type: 'context', content: 'line 4' },
        { type: 'add', content: 'added 2' },
        { type: 'context', content: 'line 5' },
      ],
    };

    const result = splitHunk(hunk);
    expect(result.length).toBeGreaterThan(1);
  });

  it('should return original hunk if not splittable', () => {
    const hunk: Hunk = {
      id: 'test:0',
      file: 'test.txt',
      index: 0,
      header: '@@ -1,3 +1,4 @@',
      oldStart: 1,
      oldCount: 3,
      newStart: 1,
      newCount: 4,
      lines: [
        { type: 'context', content: 'line 1' },
        { type: 'add', content: 'added' },
        { type: 'context', content: 'line 2' },
        { type: 'context', content: 'line 3' },
      ],
    };

    const result = splitHunk(hunk);
    expect(result).toEqual([hunk]);
  });
});

describe('selectHunks', () => {
  it('should select hunks by ID', () => {
    const diff = parseDiff(`diff --git a/file1.txt b/file1.txt
--- a/file1.txt
+++ b/file1.txt
@@ -1,2 +1,3 @@
 line 1
+added
 line 2
diff --git a/file2.txt b/file2.txt
--- a/file2.txt
+++ b/file2.txt
@@ -1,2 +1,3 @@
 other
+other added
 end
`);

    const selected = selectHunks(diff, ['file1.txt:0']);
    expect(selected).toHaveLength(1);
    expect(selected[0].file).toBe('file1.txt');
  });

  it('should return empty array for non-matching IDs', () => {
    const diff = parseDiff(`diff --git a/file.txt b/file.txt
--- a/file.txt
+++ b/file.txt
@@ -1,2 +1,3 @@
 line 1
+added
 line 2
`);

    const selected = selectHunks(diff, ['nonexistent:0']);
    expect(selected).toHaveLength(0);
  });
});

describe('editHunk', () => {
  it('should remove specified additions', () => {
    const hunk: Hunk = {
      id: 'test:0',
      file: 'test.txt',
      index: 0,
      header: '@@ -1,2 +1,4 @@',
      oldStart: 1,
      oldCount: 2,
      newStart: 1,
      newCount: 4,
      lines: [
        { type: 'context', content: 'line 1' },  // index 0
        { type: 'add', content: 'added 1' },     // index 1
        { type: 'add', content: 'added 2' },     // index 2
        { type: 'context', content: 'line 2' },  // index 3
      ],
    };

    const edited = editHunk(hunk, { removeAdditions: [1] }); // Remove addition at hunk.lines index 1
    expect(edited.lines).toHaveLength(3);
    expect(edited.lines.find(l => l.content === 'added 1')).toBeUndefined();
    expect(edited.lines.find(l => l.content === 'added 2')).toBeDefined();
    expect(edited.newCount).toBe(3); // Was 4, now 3
  });

  it('should convert removals to context when keepRemovals specified', () => {
    const hunk: Hunk = {
      id: 'test:0',
      file: 'test.txt',
      index: 0,
      header: '@@ -1,3 +1,2 @@',
      oldStart: 1,
      oldCount: 3,
      newStart: 1,
      newCount: 2,
      lines: [
        { type: 'context', content: 'line 1' },       // index 0
        { type: 'remove', content: 'removed line' },  // index 1
        { type: 'context', content: 'line 2' },       // index 2
      ],
    };

    const edited = editHunk(hunk, { keepRemovals: [1] }); // Keep the removal at hunk.lines index 1 as context
    const removedLine = edited.lines.find(l => l.content === 'removed line');
    expect(removedLine?.type).toBe('context');
    // When removal becomes context: oldCount stays same (line still in old), newCount increases (now also in new)
    expect(edited.oldCount).toBe(3); // Still 3 lines in old file
    expect(edited.newCount).toBe(3); // Now 3 lines in new file (was 2)
  });

  it('should handle splitting a hunk with multiple additions (regression test for line-level selection)', () => {
    // This tests the bug fix where indices were incorrectly interpreted as per-type counters
    // instead of hunk.lines indices
    const hunk: Hunk = {
      id: 'test:0',
      file: 'types.ts',
      index: 0,
      header: '@@ -73,3 +73,26 @@',
      oldStart: 73,
      oldCount: 3,
      newStart: 73,
      newCount: 26,
      lines: [
        { type: 'context', content: '  contextLines?: number;' },  // 0
        { type: 'context', content: '}' },                         // 1
        { type: 'context', content: '' },                          // 2
        { type: 'add', content: '' },                              // 3
        { type: 'add', content: '/**' },                           // 4
        { type: 'add', content: ' * A group of hunks...' },        // 5
        { type: 'add', content: ' */' },                           // 6
        { type: 'add', content: 'export interface HunkGroup {' },  // 7
        { type: 'add', content: '  label: string;' },              // 8
        { type: 'add', content: '  hunks: Hunk[];' },              // 9
        { type: 'add', content: '  toPatch(): string;' },          // 10
        { type: 'add', content: '}' },                             // 11
        { type: 'add', content: '' },                              // 12
        { type: 'add', content: '/**' },                           // 13
        { type: 'add', content: ' * Result of applying...' },      // 14
        { type: 'add', content: ' */' },                           // 15
        { type: 'add', content: 'export interface ApplyResult {' },// 16
        { type: 'add', content: '  success: boolean;' },           // 17
        { type: 'add', content: '  error?: string;' },             // 18
        { type: 'add', content: '}' },                             // 19
      ],
    };

    // We want ONLY HunkGroup (indices 3-11), NOT ApplyResult (indices 12-19)
    const removeIndices = [12, 13, 14, 15, 16, 17, 18, 19]; // Remove ApplyResult
    const edited = editHunk(hunk, { removeAdditions: removeIndices });

    // Should have 3 context lines + 9 HunkGroup lines = 12 total
    expect(edited.lines).toHaveLength(12);

    // Should contain HunkGroup
    expect(edited.lines.find(l => l.content === 'export interface HunkGroup {')).toBeDefined();

    // Should NOT contain ApplyResult
    expect(edited.lines.find(l => l.content === 'export interface ApplyResult {')).toBeUndefined();

    // Counts should be correct
    expect(edited.oldCount).toBe(3); // 3 context lines in old file
    expect(edited.newCount).toBe(12); // 3 context + 9 HunkGroup additions in new file
  });
});

describe('generatePatch', () => {
  it('should generate valid patch from hunks', () => {
    const hunk: Hunk = {
      id: 'test:0',
      file: 'test.txt',
      index: 0,
      header: '@@ -1,2 +1,3 @@',
      oldStart: 1,
      oldCount: 2,
      newStart: 1,
      newCount: 3,
      lines: [
        { type: 'context', content: 'line 1' },
        { type: 'add', content: 'added' },
        { type: 'context', content: 'line 2' },
      ],
    };

    const patch = generatePatch([hunk]);

    expect(patch).toContain('diff --git a/test.txt b/test.txt');
    expect(patch).toContain('--- a/test.txt');
    expect(patch).toContain('+++ b/test.txt');
    expect(patch).toContain('@@ -1,2 +1,3 @@');
    expect(patch).toContain(' line 1');
    expect(patch).toContain('+added');
  });

  it('should handle multiple hunks from same file', () => {
    const hunks: Hunk[] = [
      {
        id: 'test:0',
        file: 'test.txt',
        index: 0,
        header: '@@ -1,2 +1,3 @@',
        oldStart: 1,
        oldCount: 2,
        newStart: 1,
        newCount: 3,
        lines: [
          { type: 'context', content: 'line 1' },
          { type: 'add', content: 'added 1' },
          { type: 'context', content: 'line 2' },
        ],
      },
      {
        id: 'test:1',
        file: 'test.txt',
        index: 1,
        header: '@@ -10,2 +11,3 @@',
        oldStart: 10,
        oldCount: 2,
        newStart: 11,
        newCount: 3,
        lines: [
          { type: 'context', content: 'line 10' },
          { type: 'add', content: 'added 2' },
          { type: 'context', content: 'line 11' },
        ],
      },
    ];

    const patch = generatePatch(hunks);

    // Should only have one file header
    const fileHeaders = patch.match(/diff --git/g);
    expect(fileHeaders).toHaveLength(1);

    // Should have both hunk headers
    expect(patch).toContain('@@ -1,2 +1,3 @@');
    expect(patch).toContain('@@ -10,2 +11,3 @@');
  });
});

describe('recalculateHeader', () => {
  it('should recalculate header based on actual lines', () => {
    const hunk: Hunk = {
      id: 'test:0',
      file: 'test.txt',
      index: 0,
      header: '@@ -1,99 +1,99 @@', // Wrong counts
      oldStart: 1,
      oldCount: 99, // Wrong
      newStart: 1,
      newCount: 99, // Wrong
      lines: [
        { type: 'context', content: 'line 1' },
        { type: 'add', content: 'added' },
        { type: 'context', content: 'line 2' },
      ],
    };

    const header = recalculateHeader(hunk);
    expect(header).toBe('@@ -1,2 +1,3 @@');
  });
});

describe('selectHunksWithLines', () => {
  const diffText = `diff --git a/file1.txt b/file1.txt
--- a/file1.txt
+++ b/file1.txt
@@ -1,2 +1,5 @@
 line 1
+added A
+added B
+added C
 line 2
diff --git a/file2.txt b/file2.txt
--- a/file2.txt
+++ b/file2.txt
@@ -1,2 +1,3 @@
 other
+other added
 end
`;

  it('should select entire hunks by base ID', () => {
    const diff = parseDiff(diffText);
    const result = selectHunksWithLines(diff, ['file1.txt:0']);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe('file1.txt');
    // All three additions present
    expect(result[0].lines.filter(l => l.type === 'add')).toHaveLength(3);
  });

  it('should select a subset of addition lines from a hunk', () => {
    const diff = parseDiff(diffText);
    // file1.txt:0 lines: [0]=context, [1]=+addedA, [2]=+addedB, [3]=+addedC, [4]=context
    // Select only line index 1 (added A) and 3 (added C)
    const result = selectHunksWithLines(diff, ['file1.txt:0:1', 'file1.txt:0:3']);
    expect(result).toHaveLength(1);
    const addLines = result[0].lines.filter(l => l.type === 'add');
    expect(addLines).toHaveLength(2);
    expect(addLines[0].content).toBe('added A');
    expect(addLines[1].content).toBe('added C');
  });

  it('should not include additions not referenced by line IDs', () => {
    const diff = parseDiff(diffText);
    // Only select line index 2 (added B)
    const result = selectHunksWithLines(diff, ['file1.txt:0:2']);
    expect(result).toHaveLength(1);
    const addLines = result[0].lines.filter(l => l.type === 'add');
    expect(addLines).toHaveLength(1);
    expect(addLines[0].content).toBe('added B');
  });

  it('should handle mixed whole-hunk and line-level IDs', () => {
    const diff = parseDiff(diffText);
    // Whole hunk for file2, line-level for file1
    const result = selectHunksWithLines(diff, ['file2.txt:0', 'file1.txt:0:1']);
    expect(result).toHaveLength(2);

    const file1Hunk = result.find(h => h.file === 'file1.txt')!;
    const file2Hunk = result.find(h => h.file === 'file2.txt')!;

    expect(file1Hunk.lines.filter(l => l.type === 'add')).toHaveLength(1);
    expect(file1Hunk.lines.find(l => l.type === 'add')!.content).toBe('added A');
    expect(file2Hunk.lines.filter(l => l.type === 'add')).toHaveLength(1);
  });

  it('should return nothing for unrecognised IDs', () => {
    const diff = parseDiff(diffText);
    const result = selectHunksWithLines(diff, ['nonexistent.txt:0', 'nonexistent.txt:0:5']);
    expect(result).toHaveLength(0);
  });

  it('should recalculate counts after line-level selection', () => {
    const diff = parseDiff(diffText);
    // file1.txt:0 originally has oldCount=2, newCount=5; select only 1 of 3 additions → newCount=3
    const result = selectHunksWithLines(diff, ['file1.txt:0:1']);
    expect(result[0].oldCount).toBe(2);
    expect(result[0].newCount).toBe(3);
  });
});
