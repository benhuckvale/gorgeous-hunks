import { parseDiff, parseHunkHeader, validateHunk } from '../src/parser';

describe('parseDiff', () => {
  const simpleDiff = `diff --git a/file.txt b/file.txt
index abc123..def456 100644
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,4 @@
 line 1
+added line
 line 2
 line 3
`;

  it('should parse a simple diff into files and hunks', () => {
    const result = parseDiff(simpleDiff);

    expect(result.files).toHaveLength(1);
    expect(result.files[0].oldPath).toBe('file.txt');
    expect(result.files[0].newPath).toBe('file.txt');
    expect(result.files[0].hunks).toHaveLength(1);
  });

  it('should parse hunk headers correctly', () => {
    const result = parseDiff(simpleDiff);
    const hunk = result.files[0].hunks[0];

    expect(hunk.oldStart).toBe(1);
    expect(hunk.oldCount).toBe(3);
    expect(hunk.newStart).toBe(1);
    expect(hunk.newCount).toBe(4);
  });

  it('should parse diff lines with correct types', () => {
    const result = parseDiff(simpleDiff);
    const hunk = result.files[0].hunks[0];

    expect(hunk.lines).toHaveLength(4);
    expect(hunk.lines[0]).toEqual({ type: 'context', content: 'line 1' });
    expect(hunk.lines[1]).toEqual({ type: 'add', content: 'added line' });
    expect(hunk.lines[2]).toEqual({ type: 'context', content: 'line 2' });
    expect(hunk.lines[3]).toEqual({ type: 'context', content: 'line 3' });
  });

  it('should assign correct hunk IDs', () => {
    const result = parseDiff(simpleDiff);
    expect(result.files[0].hunks[0].id).toBe('file.txt:0');
  });

  it('should handle multiple hunks in one file', () => {
    const multiHunkDiff = `diff --git a/file.txt b/file.txt
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,4 @@
 line 1
+added line
 line 2
 line 3
@@ -10,3 +11,4 @@
 line 10
+another added line
 line 11
 line 12
`;

    const result = parseDiff(multiHunkDiff);
    expect(result.files[0].hunks).toHaveLength(2);
    expect(result.files[0].hunks[0].id).toBe('file.txt:0');
    expect(result.files[0].hunks[1].id).toBe('file.txt:1');
  });

  it('should handle multiple files', () => {
    const multiFileDiff = `diff --git a/file1.txt b/file1.txt
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
 other 1
+other added
 other 2
`;

    const result = parseDiff(multiFileDiff);
    expect(result.files).toHaveLength(2);
    expect(result.files[0].newPath).toBe('file1.txt');
    expect(result.files[1].newPath).toBe('file2.txt');
  });

  it('should detect new files', () => {
    const newFileDiff = `diff --git a/newfile.txt b/newfile.txt
new file mode 100644
index 0000000..abc123
--- /dev/null
+++ b/newfile.txt
@@ -0,0 +1,2 @@
+line 1
+line 2
`;

    const result = parseDiff(newFileDiff);
    expect(result.files[0].isNew).toBe(true);
  });

  it('should detect deleted files', () => {
    const deletedFileDiff = `diff --git a/oldfile.txt b/oldfile.txt
deleted file mode 100644
index abc123..0000000
--- a/oldfile.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-line 1
-line 2
`;

    const result = parseDiff(deletedFileDiff);
    expect(result.files[0].isDeleted).toBe(true);
  });

  it('should provide helper methods', () => {
    const result = parseDiff(simpleDiff);

    expect(result.getAllHunks()).toHaveLength(1);
    expect(result.getHunk('file.txt:0')).toBeDefined();
    expect(result.getHunk('nonexistent:0')).toBeUndefined();
    expect(result.getFileHunks('file.txt')).toHaveLength(1);
    expect(result.getFileHunks('nonexistent.txt')).toHaveLength(0);
  });

  it('should handle removal lines', () => {
    const removalDiff = `diff --git a/file.txt b/file.txt
--- a/file.txt
+++ b/file.txt
@@ -1,4 +1,3 @@
 line 1
-removed line
 line 2
 line 3
`;

    const result = parseDiff(removalDiff);
    const hunk = result.files[0].hunks[0];

    expect(hunk.lines[1]).toEqual({ type: 'remove', content: 'removed line' });
    expect(hunk.oldCount).toBe(4);
    expect(hunk.newCount).toBe(3);
  });
});

describe('parseHunkHeader', () => {
  it('should parse standard hunk header', () => {
    const result = parseHunkHeader('@@ -1,10 +1,12 @@');

    expect(result).toEqual({
      oldStart: 1,
      oldCount: 10,
      newStart: 1,
      newCount: 12,
      context: undefined,
    });
  });

  it('should handle omitted counts (defaults to 1)', () => {
    const result = parseHunkHeader('@@ -5 +5 @@');

    expect(result).toEqual({
      oldStart: 5,
      oldCount: 1,
      newStart: 5,
      newCount: 1,
      context: undefined,
    });
  });

  it('should extract function context', () => {
    const result = parseHunkHeader('@@ -10,5 +10,7 @@ function myFunction()');

    expect(result?.context).toBe('function myFunction()');
  });

  it('should return null for invalid headers', () => {
    expect(parseHunkHeader('not a hunk header')).toBeNull();
    expect(parseHunkHeader('@@ invalid @@')).toBeNull();
  });
});

describe('validateHunk', () => {
  it('should validate a correct hunk', () => {
    const hunk = {
      id: 'test:0',
      file: 'test',
      index: 0,
      header: '@@ -1,3 +1,4 @@',
      oldStart: 1,
      oldCount: 3,
      newStart: 1,
      newCount: 4,
      lines: [
        { type: 'context' as const, content: 'line 1' },
        { type: 'add' as const, content: 'added' },
        { type: 'context' as const, content: 'line 2' },
        { type: 'context' as const, content: 'line 3' },
      ],
    };

    expect(validateHunk(hunk)).toEqual({ valid: true });
  });

  it('should reject hunk with wrong old count', () => {
    const hunk = {
      id: 'test:0',
      file: 'test',
      index: 0,
      header: '@@ -1,5 +1,4 @@', // claims 5 old lines
      oldStart: 1,
      oldCount: 5,
      newStart: 1,
      newCount: 4,
      lines: [
        { type: 'context' as const, content: 'line 1' },
        { type: 'add' as const, content: 'added' },
        { type: 'context' as const, content: 'line 2' },
        { type: 'context' as const, content: 'line 3' },
      ],
    };

    const result = validateHunk(hunk);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Old count mismatch');
  });

  it('should reject hunk with wrong new count', () => {
    const hunk = {
      id: 'test:0',
      file: 'test',
      index: 0,
      header: '@@ -1,3 +1,10 @@', // claims 10 new lines
      oldStart: 1,
      oldCount: 3,
      newStart: 1,
      newCount: 10,
      lines: [
        { type: 'context' as const, content: 'line 1' },
        { type: 'add' as const, content: 'added' },
        { type: 'context' as const, content: 'line 2' },
        { type: 'context' as const, content: 'line 3' },
      ],
    };

    const result = validateHunk(hunk);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('New count mismatch');
  });
});
