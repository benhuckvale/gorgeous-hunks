import { DiffLine, FileDiff, Hunk, ParsedDiff, ParseOptions } from './types.js';

/**
 * Regex to match the file header in a unified diff
 * Matches: diff --git a/path b/path
 */
const FILE_HEADER_REGEX = /^diff --git a\/(.+) b\/(.+)$/;

/**
 * Regex to match hunk headers
 * Matches: @@ -start,count +start,count @@ optional context
 * Note: count is optional (defaults to 1 if omitted)
 */
const HUNK_HEADER_REGEX = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Parse a unified diff string into structured data
 */
export function parseDiff(diffString: string, options: ParseOptions = {}): ParsedDiff {
  const lines = diffString.split('\n');
  const files: FileDiff[] = [];
  let currentFile: FileDiff | null = null;
  let currentHunk: Hunk | null = null;
  let hunkIndex = 0;
  let lineIndex = 0;

  while (lineIndex < lines.length) {
    const line = lines[lineIndex];

    // Check for file header
    const fileMatch = line.match(FILE_HEADER_REGEX);
    if (fileMatch) {
      // Save previous file if exists
      if (currentFile) {
        if (currentHunk) {
          currentFile.hunks.push(currentHunk);
          currentHunk = null;
        }
        files.push(currentFile);
      }

      // Parse file metadata
      const [, oldPath, newPath] = fileMatch;
      currentFile = {
        oldPath,
        newPath,
        isNew: false,
        isDeleted: false,
        isRenamed: oldPath !== newPath,
        hunks: [],
      };
      hunkIndex = 0;

      // Look ahead for file mode indicators
      lineIndex++;
      while (lineIndex < lines.length) {
        const metaLine = lines[lineIndex];
        if (metaLine.startsWith('new file mode')) {
          currentFile.isNew = true;
          lineIndex++;
        } else if (metaLine.startsWith('deleted file mode')) {
          currentFile.isDeleted = true;
          lineIndex++;
        } else if (
          metaLine.startsWith('index ') ||
          metaLine.startsWith('--- ') ||
          metaLine.startsWith('+++ ') ||
          metaLine.startsWith('old mode') ||
          metaLine.startsWith('new mode') ||
          metaLine.startsWith('similarity index') ||
          metaLine.startsWith('rename from') ||
          metaLine.startsWith('rename to') ||
          metaLine.startsWith('Binary files')
        ) {
          lineIndex++;
        } else {
          break;
        }
      }
      continue;
    }

    // Check for hunk header
    const hunkMatch = line.match(HUNK_HEADER_REGEX);
    if (hunkMatch && currentFile) {
      // Save previous hunk if exists
      if (currentHunk) {
        currentFile.hunks.push(currentHunk);
      }

      const [, oldStart, oldCount, newStart, newCount, context] = hunkMatch;
      currentHunk = {
        id: `${currentFile.newPath}:${hunkIndex}`,
        file: currentFile.newPath,
        index: hunkIndex,
        header: line,
        oldStart: parseInt(oldStart, 10),
        oldCount: oldCount ? parseInt(oldCount, 10) : 1,
        newStart: parseInt(newStart, 10),
        newCount: newCount ? parseInt(newCount, 10) : 1,
        lines: [],
        context: context.trim() || undefined,
      };
      hunkIndex++;
      lineIndex++;
      continue;
    }

    // Parse hunk content lines
    if (currentHunk && line.length > 0) {
      const prefix = line[0];
      const content = line.slice(1);

      if (prefix === ' ') {
        currentHunk.lines.push({ type: 'context', content });
      } else if (prefix === '-') {
        currentHunk.lines.push({ type: 'remove', content });
      } else if (prefix === '+') {
        currentHunk.lines.push({ type: 'add', content });
      }
      // Ignore other lines (like "\ No newline at end of file")
    }

    lineIndex++;
  }

  // Don't forget the last hunk and file
  if (currentHunk && currentFile) {
    currentFile.hunks.push(currentHunk);
  }
  if (currentFile) {
    files.push(currentFile);
  }

  return createParsedDiff(files);
}

/**
 * Create a ParsedDiff object with helper methods
 */
function createParsedDiff(files: FileDiff[]): ParsedDiff {
  return {
    files,

    getAllHunks(): Hunk[] {
      return files.flatMap(f => f.hunks);
    },

    getHunk(id: string): Hunk | undefined {
      for (const file of files) {
        const hunk = file.hunks.find((h: Hunk) => h.id === id);
        if (hunk) return hunk;
      }
      return undefined;
    },

    getFileHunks(filePath: string): Hunk[] {
      const file = files.find(f => f.newPath === filePath || f.oldPath === filePath);
      return file?.hunks ?? [];
    },
  };
}

/**
 * Parse a hunk header string
 */
export function parseHunkHeader(header: string): {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  context?: string;
} | null {
  const match = header.match(HUNK_HEADER_REGEX);
  if (!match) return null;

  const [, oldStart, oldCount, newStart, newCount, context] = match;
  return {
    oldStart: parseInt(oldStart, 10),
    oldCount: oldCount ? parseInt(oldCount, 10) : 1,
    newStart: parseInt(newStart, 10),
    newCount: newCount ? parseInt(newCount, 10) : 1,
    context: context.trim() || undefined,
  };
}

/**
 * Validate that a hunk's line counts match its header
 */
export function validateHunk(hunk: Hunk): { valid: boolean; error?: string } {
  const contextCount = hunk.lines.filter((l: DiffLine) => l.type === 'context').length;
  const removeCount = hunk.lines.filter((l: DiffLine) => l.type === 'remove').length;
  const addCount = hunk.lines.filter((l: DiffLine) => l.type === 'add').length;

  const expectedOldCount = contextCount + removeCount;
  const expectedNewCount = contextCount + addCount;

  if (expectedOldCount !== hunk.oldCount) {
    return {
      valid: false,
      error: `Old count mismatch: header says ${hunk.oldCount}, actual is ${expectedOldCount}`,
    };
  }

  if (expectedNewCount !== hunk.newCount) {
    return {
      valid: false,
      error: `New count mismatch: header says ${hunk.newCount}, actual is ${expectedNewCount}`,
    };
  }

  return { valid: true };
}
