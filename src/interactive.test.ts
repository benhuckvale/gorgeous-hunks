import { parseDiff } from '../src/parser';
import {
  generateStagingPlanDocument,
  parseStagingPlanDocument,
  generateWorksheet,
} from '../src/interactive';

describe('generateStagingPlanDocument', () => {
  const simpleDiff = `diff --git a/file.txt b/file.txt
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,4 @@
 line 1
+added line
 line 2
 line 3
`;

  it('should generate a markdown document with checkboxes', () => {
    const diff = parseDiff(simpleDiff);
    const doc = generateStagingPlanDocument(diff, 'test commit');

    expect(doc).toContain('# Staging Plan');
    expect(doc).toContain('Commit message: test commit');
    expect(doc).toContain('[x]');
    expect(doc).toContain('[ ]');
  });

  it('should include hunk IDs', () => {
    const diff = parseDiff(simpleDiff);
    const doc = generateStagingPlanDocument(diff);

    expect(doc).toContain('### file.txt:0');
  });

  it('should include line indices', () => {
    const diff = parseDiff(simpleDiff);
    const doc = generateStagingPlanDocument(diff);

    // Lines should be indexed
    expect(doc).toMatch(/\[\s*\d+\]/);
  });
});

describe('parseStagingPlanDocument', () => {
  it('should extract commit message', () => {
    const doc = `# Staging Plan

Commit message: feat: add logging

---
`;

    const result = parseStagingPlanDocument(doc);
    expect(result.commitMessage).toBe('feat: add logging');
  });

  it('should parse selected hunks (entire hunk)', () => {
    const doc = `# Staging Plan

Commit message: test

---

## file.txt

### file.txt:0

[x] Include entire hunk

\`\`\`
    [ 0]   line 1
[ ] [ 1] + added
    [ 2]   line 2
\`\`\`
`;

    const result = parseStagingPlanDocument(doc);
    expect(result.selections).toHaveLength(1);
    expect(result.selections[0].hunkId).toBe('file.txt:0');
    expect(result.selections[0].mode).toBe('all');
  });

  it('should parse partial line selections', () => {
    const doc = `# Staging Plan

Commit message: test

---

## file.txt

### file.txt:0

[ ] Include entire hunk

\`\`\`
    [ 0]   line 1
[x] [ 1] + added 1
[ ] [ 2] + added 2
    [ 3]   line 2
\`\`\`
`;

    const result = parseStagingPlanDocument(doc);
    expect(result.selections).toHaveLength(1);
    expect(result.selections[0].mode).toBe('partial');
    expect(result.selections[0].includeAdditions).toContain(1);
    expect(result.selections[0].includeAdditions).not.toContain(2);
  });

  it('should parse removal selections separately from additions', () => {
    const doc = `# Staging Plan

Commit message: test

---

## file.txt

### file.txt:0

[ ] Include entire hunk

\`\`\`
    [ 0]   line 1
[x] [ 1] - removed line
[x] [ 2] + added line
    [ 3]   line 2
\`\`\`
`;

    const result = parseStagingPlanDocument(doc);
    expect(result.selections[0].includeRemovals).toContain(1);
    expect(result.selections[0].includeAdditions).toContain(2);
  });

  it('should skip unselected hunks', () => {
    const doc = `# Staging Plan

Commit message: test

---

## file.txt

### file.txt:0

[ ] Include entire hunk

\`\`\`
    [ 0]   line 1
[ ] [ 1] + added
    [ 2]   line 2
\`\`\`
`;

    const result = parseStagingPlanDocument(doc);
    expect(result.selections[0].mode).toBe('none');
  });

  it('should parse line edits', () => {
    const doc = `# Staging Plan

Commit message: test

---

## file.txt

### file.txt:0

[ ] Include entire hunk

\`\`\`
    [ 0]   line 1
[E] [ 1] + import { foo, bar, baz } from 'utils';
    [ 2]   line 2
\`\`\`

EDIT [1]: import { foo, bar } from 'utils';
`;

    const result = parseStagingPlanDocument(doc);
    expect(result.selections[0].lineEdits).toBeDefined();
    expect(result.selections[0].lineEdits?.[0].lineIndex).toBe(1);
    expect(result.selections[0].lineEdits?.[0].newContent).toBe("import { foo, bar } from 'utils';");
  });

  it('should handle multiple hunks', () => {
    const doc = `# Staging Plan

Commit message: test

---

## file.txt

### file.txt:0

[x] Include entire hunk

\`\`\`
    [ 0]   line 1
\`\`\`

### file.txt:1

[ ] Include entire hunk

\`\`\`
    [ 0]   line 10
[x] [ 1] + added
\`\`\`
`;

    const result = parseStagingPlanDocument(doc);
    expect(result.selections).toHaveLength(2);
    expect(result.selections[0].hunkId).toBe('file.txt:0');
    expect(result.selections[0].mode).toBe('all');
    expect(result.selections[1].hunkId).toBe('file.txt:1');
    expect(result.selections[1].mode).toBe('partial');
  });
});

describe('generateWorksheet', () => {
  const simpleDiff = `diff --git a/file.txt b/file.txt
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,4 @@
 line 1
+added line
 line 2
 line 3
`;

  it('should generate a structured worksheet', () => {
    const diff = parseDiff(simpleDiff);
    const worksheet = generateWorksheet(diff, 'test commit');

    expect(worksheet.commitMessage).toBe('test commit');
    expect(worksheet.files).toHaveLength(1);
    expect(worksheet.files[0].path).toBe('file.txt');
    expect(worksheet.files[0].hunks).toHaveLength(1);
  });

  it('should include indexed lines with include flags', () => {
    const diff = parseDiff(simpleDiff);
    const worksheet = generateWorksheet(diff);

    const hunk = worksheet.files[0].hunks[0];
    expect(hunk.lines).toHaveLength(4);

    // All include flags should start as false
    for (const line of hunk.lines) {
      expect(line.include).toBe(false);
    }

    // Check line types
    expect(hunk.lines[0].type).toBe('context');
    expect(hunk.lines[1].type).toBe('add');
    expect(hunk.lines[2].type).toBe('context');
    expect(hunk.lines[3].type).toBe('context');
  });

  it('should mark hunk include as none initially', () => {
    const diff = parseDiff(simpleDiff);
    const worksheet = generateWorksheet(diff);

    expect(worksheet.files[0].hunks[0].include).toBe('none');
  });
});
