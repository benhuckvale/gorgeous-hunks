/**
 * A single line within a diff hunk
 */
export interface DiffLine {
  /** The type of change: context (unchanged), add, or remove */
  type: 'context' | 'add' | 'remove';
  /** The raw content of the line (without the prefix) */
  content: string;
}

/**
 * A hunk represents a contiguous block of changes in a file
 */
export interface Hunk {
  /** Unique identifier for this hunk, e.g., "src/app.js:2" */
  id: string;
  /** The file this hunk belongs to */
  file: string;
  /** Zero-based index of this hunk within its file */
  index: number;
  /** The raw hunk header line, e.g., "@@ -1,8 +1,11 @@ function foo()" */
  header: string;
  /** Starting line number in the original file */
  oldStart: number;
  /** Number of lines in the original file covered by this hunk */
  oldCount: number;
  /** Starting line number in the new file */
  newStart: number;
  /** Number of lines in the new file covered by this hunk */
  newCount: number;
  /** The lines in this hunk */
  lines: DiffLine[];
  /** Optional context extracted from the header (e.g., function name) */
  context?: string;
}

/**
 * Represents all changes to a single file
 */
export interface FileDiff {
  /** The old file path (before rename, or same as newPath) */
  oldPath: string;
  /** The new file path (after rename, or same as oldPath) */
  newPath: string;
  /** Whether this is a new file */
  isNew: boolean;
  /** Whether this file was deleted */
  isDeleted: boolean;
  /** Whether this file was renamed */
  isRenamed: boolean;
  /** The hunks in this file */
  hunks: Hunk[];
}

/**
 * A complete parsed diff, potentially spanning multiple files
 */
export interface ParsedDiff {
  /** All file diffs in this patch */
  files: FileDiff[];
  /** Get all hunks across all files, flattened */
  getAllHunks(): Hunk[];
  /** Get a hunk by its ID */
  getHunk(id: string): Hunk | undefined;
  /** Get hunks for a specific file */
  getFileHunks(filePath: string): Hunk[];
}

/**
 * Options for parsing a diff
 */
export interface ParseOptions {
  /** Number of context lines (default: 3, matching git's default) */
  contextLines?: number;
}

/**
 * A group of hunks that should be committed together
 */
export interface HunkGroup {
  /** Human-readable label for this group */
  label: string;
  /** The hunks in this group */
  hunks: Hunk[];
  /** Generate a patch string for this group */
  toPatch(): string;
}
