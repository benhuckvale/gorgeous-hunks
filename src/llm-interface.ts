/**
 * LLM Interface Layer
 *
 * This module provides the data structures and formatting that make it
 * possible for an LLM to understand and manipulate hunks at all difficulty levels:
 *
 * Level 1: Hunks in separate files → select by file
 * Level 2: Hunks in same file, already separate → select by hunk ID
 * Level 3: Hunks need splitting → split then select
 * Level 4: Lines within a hunk belong to different commits → line-level selection
 * Level 5: Single line has mixed changes → line content editing
 */

import { DiffLine, Hunk, ParsedDiff } from './types.js';
import { isSplittable, splitHunk } from './manipulator.js';

/**
 * An indexed line within a hunk, addressable by the LLM
 */
export interface IndexedLine {
  /** Index within the hunk (for addressing) */
  index: number;
  /** The type: 'add', 'remove', or 'context' */
  type: 'context' | 'add' | 'remove';
  /** The actual content */
  content: string;
  /** Line number in original file (undefined for additions) */
  oldLineNo?: number;
  /** Line number in new file (undefined for removals) */
  newLineNo?: number;
}

/**
 * Enhanced hunk representation for LLM consumption
 */
export interface LLMHunk {
  /** Unique ID for this hunk */
  id: string;
  /** File path */
  file: string;
  /** Function/class context if available */
  context?: string;
  /** Can this hunk be split further? */
  splittable: boolean;
  /** If splittable, how many sub-hunks would result? */
  splitCount?: number;
  /** Summary of changes */
  summary: string;
  /** Indexed lines for granular selection */
  lines: IndexedLine[];
  /** Indices of added lines (for easy reference) */
  addedLineIndices: number[];
  /** Indices of removed lines (for easy reference) */
  removedLineIndices: number[];
  /** Complexity level (1-5) based on what's needed to separate concerns */
  complexityHint: number;
}

/**
 * A staging instruction from the LLM
 */
export interface StagingInstruction {
  /** The hunk ID to operate on */
  hunkId: string;
  /** Action to take */
  action: 'stage_all' | 'stage_partial' | 'split_first' | 'edit_line';
  /** For stage_partial: which added line indices to include */
  includeAdditions?: number[];
  /** For stage_partial: which removed line indices to convert to context (keep the line) */
  keepRemovals?: number[];
  /** For edit_line: the line index and new content */
  lineEdit?: {
    index: number;
    newContent: string;
  };
}

/**
 * Convert a Hunk to an LLM-friendly representation with indexed lines
 */
export function hunkToLLMHunk(hunk: Hunk): LLMHunk {
  const lines: IndexedLine[] = [];
  const addedLineIndices: number[] = [];
  const removedLineIndices: number[] = [];

  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;

  hunk.lines.forEach((line, index) => {
    const indexed: IndexedLine = {
      index,
      type: line.type,
      content: line.content,
    };

    if (line.type === 'context') {
      indexed.oldLineNo = oldLine++;
      indexed.newLineNo = newLine++;
    } else if (line.type === 'remove') {
      indexed.oldLineNo = oldLine++;
      removedLineIndices.push(index);
    } else if (line.type === 'add') {
      indexed.newLineNo = newLine++;
      addedLineIndices.push(index);
    }

    lines.push(indexed);
  });

  const splittable = isSplittable(hunk);
  const splitCount = splittable ? splitHunk(hunk).length : undefined;

  // Estimate complexity
  let complexityHint = 1;
  if (addedLineIndices.length > 1 || removedLineIndices.length > 1) {
    complexityHint = 4; // Multiple changes in one hunk, may need line selection
  }
  if (splittable) {
    complexityHint = Math.min(complexityHint, 3); // Can be split, so probably level 3
  }

  return {
    id: hunk.id,
    file: hunk.file,
    context: hunk.context,
    splittable,
    splitCount,
    summary: summarizeChanges(hunk),
    lines,
    addedLineIndices,
    removedLineIndices,
    complexityHint,
  };
}

/**
 * Generate a summary of what changes a hunk contains
 */
function summarizeChanges(hunk: Hunk): string {
  const adds = hunk.lines.filter(l => l.type === 'add');
  const removes = hunk.lines.filter(l => l.type === 'remove');

  if (adds.length === 0 && removes.length === 0) {
    return 'no changes';
  }

  const parts: string[] = [];
  if (adds.length > 0) parts.push(`+${adds.length} lines`);
  if (removes.length > 0) parts.push(`-${removes.length} lines`);

  return parts.join(', ');
}

/**
 * Format hunks for LLM with full detail for decision-making
 * This is the primary interface an MCP would expose via get_hunks
 */
export function formatHunksForLLM(diff: ParsedDiff): string {
  const allHunks = diff.getAllHunks();
  const llmHunks = allHunks.map(hunkToLLMHunk);

  const sections: string[] = [];

  sections.push('# Unstaged Changes Analysis');
  sections.push('');
  sections.push(`Total: ${allHunks.length} hunk(s) across ${diff.files.length} file(s)`);
  sections.push('');

  // Group by file for clarity
  const byFile = new Map<string, LLMHunk[]>();
  for (const h of llmHunks) {
    const existing = byFile.get(h.file) || [];
    existing.push(h);
    byFile.set(h.file, existing);
  }

  for (const [file, hunks] of byFile) {
    sections.push(`## File: ${file}`);
    sections.push('');

    for (const hunk of hunks) {
      sections.push(formatSingleHunkForLLM(hunk));
      sections.push('');
    }
  }

  sections.push('---');
  sections.push('');
  sections.push('## How to Stage Changes');
  sections.push('');
  sections.push('For each logical commit, specify which hunks/lines belong together:');
  sections.push('');
  sections.push('```json');
  sections.push('{');
  sections.push('  "commits": [');
  sections.push('    {');
  sections.push('      "message": "feat: add logging",');
  sections.push('      "hunks": [');
  sections.push('        { "id": "app.js:0", "action": "stage_all" },');
  sections.push('        { "id": "app.js:1", "action": "stage_partial", "includeAdditions": [0, 2] }');
  sections.push('      ]');
  sections.push('    }');
  sections.push('  ]');
  sections.push('}');
  sections.push('```');
  sections.push('');
  sections.push('Actions:');
  sections.push('- `stage_all`: Include entire hunk');
  sections.push('- `stage_partial`: Include only specified line indices');
  sections.push('- `split_first`: Split hunk, then stage resulting sub-hunks');
  sections.push('- `edit_line`: Modify a line\'s content before staging');

  return sections.join('\n');
}

/**
 * Format a single hunk with indexed lines
 */
function formatSingleHunkForLLM(hunk: LLMHunk): string {
  const lines: string[] = [];

  // Header
  lines.push(`### Hunk: ${hunk.id}`);
  if (hunk.context) {
    lines.push(`Context: ${hunk.context}`);
  }
  lines.push(`Summary: ${hunk.summary}`);

  if (hunk.splittable) {
    lines.push(`⚠ Splittable: Can be split into ${hunk.splitCount} sub-hunks`);
  }

  lines.push('');
  lines.push('```');

  // Lines with indices
  for (const line of hunk.lines) {
    const prefix = line.type === 'context' ? ' ' : line.type === 'add' ? '+' : '-';
    const lineNos = formatLineNumbers(line);
    const indexTag = `[${String(line.index).padStart(2)}]`;
    lines.push(`${indexTag} ${lineNos} ${prefix} ${line.content}`);
  }

  lines.push('```');

  // Quick reference for selection
  if (hunk.addedLineIndices.length > 0) {
    lines.push(`Added lines: [${hunk.addedLineIndices.join(', ')}]`);
  }
  if (hunk.removedLineIndices.length > 0) {
    lines.push(`Removed lines: [${hunk.removedLineIndices.join(', ')}]`);
  }

  return lines.join('\n');
}

/**
 * Format line numbers for display
 */
function formatLineNumbers(line: IndexedLine): string {
  const old = line.oldLineNo !== undefined ? String(line.oldLineNo).padStart(3) : '   ';
  const neu = line.newLineNo !== undefined ? String(line.newLineNo).padStart(3) : '   ';
  return `${old}:${neu}`;
}

/**
 * Structured output for MCP tool response
 */
export interface HunkAnalysis {
  files: {
    path: string;
    hunks: LLMHunk[];
  }[];
  /** Total number of hunks */
  totalHunks: number;
  /** Hunks that can be staged as-is (levels 1-2) */
  simpleHunks: string[];
  /** Hunks that need splitting (level 3) */
  splittableHunks: string[];
  /** Hunks that may need line-level selection (level 4+) */
  complexHunks: string[];
}

/**
 * Analyze hunks and categorize by complexity
 * This could be returned as JSON from an MCP tool
 */
export function analyzeHunks(diff: ParsedDiff): HunkAnalysis {
  const allHunks = diff.getAllHunks();
  const llmHunks = allHunks.map(hunkToLLMHunk);

  const byFile = new Map<string, LLMHunk[]>();
  for (const h of llmHunks) {
    const existing = byFile.get(h.file) || [];
    existing.push(h);
    byFile.set(h.file, existing);
  }

  const simpleHunks: string[] = [];
  const splittableHunks: string[] = [];
  const complexHunks: string[] = [];

  for (const hunk of llmHunks) {
    if (hunk.splittable) {
      splittableHunks.push(hunk.id);
    } else if (hunk.addedLineIndices.length <= 1 && hunk.removedLineIndices.length <= 1) {
      simpleHunks.push(hunk.id);
    } else {
      complexHunks.push(hunk.id);
    }
  }

  return {
    files: Array.from(byFile.entries()).map(([path, hunks]) => ({ path, hunks })),
    totalHunks: allHunks.length,
    simpleHunks,
    splittableHunks,
    complexHunks,
  };
}
