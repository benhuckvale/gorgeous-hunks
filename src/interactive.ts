/**
 * Interactive Staging Interface
 *
 * Provides a document-based workflow where:
 * 1. Library generates a staging plan document
 * 2. LLM (or user) marks it up with selections
 * 3. Library parses the markup and stages incrementally
 * 4. Both sides can inspect current state and adjust
 *
 * This supports an iterative prompt loop:
 * - "Here's what I plan to stage for this commit..."
 * - "Does that look right?"
 * - Human/LLM adjusts
 * - "OK, staging those changes..."
 * - "Here's what's staged now. Ready to commit?"
 */

import * as fs from 'fs';
import * as path from 'path';
import { DiffLine, Hunk, ParsedDiff } from './types.js';
import { hunkToLLMHunk, LLMHunk } from './llm-interface.js';
import { isSplittable, splitHunk, editHunk, generatePatch } from './manipulator.js';
import { getStagedDiff, applyPatchToIndex, checkPatch, reversePatch, git } from './git.js';
import { parseDiff } from './parser.js';

/**
 * A staging plan that can be edited by an LLM
 */
export interface StagingPlan {
  /** Human-readable commit message */
  commitMessage: string;
  /** Selections for this commit */
  selections: HunkSelection[];
  /** Level 6: Temporary code needed to make this partial commit work */
  compensations?: Compensation[];
}

/**
 * Selection state for a single hunk
 */
export interface HunkSelection {
  hunkId: string;
  /** 'all' = stage entire hunk, 'none' = skip, 'partial' = specific lines */
  mode: 'all' | 'none' | 'partial';
  /** For partial mode: which addition (+) line indices to include */
  includeAdditions?: number[];
  /** For partial mode: which removal (-) line indices to include (others become context) */
  includeRemovals?: number[];
  /** For level 5: edits to specific lines before staging */
  lineEdits?: LineEdit[];
  /** Optional note explaining why this selection */
  note?: string;
}

/**
 * Edit to a specific line (for level 5: mixed-purpose lines)
 */
export interface LineEdit {
  /** Line index within the hunk */
  lineIndex: number;
  /** What the line should become for this commit */
  newContent: string;
}

/**
 * Compensation code (for level 6: dependency compensation)
 *
 * When untangling commits, sometimes commit A requires code that
 * commit B would normally provide. Compensations are temporary
 * additions that make commit A work standalone.
 */
export interface Compensation {
  /** File to add the compensation to */
  file: string;
  /** Type of compensation */
  type: 'add_lines' | 'add_after_line' | 'add_before_line' | 'replace_line';
  /** For add_after_line/add_before_line: the line number (1-indexed) */
  lineNumber?: number;
  /** For add_after_line/add_before_line: pattern to match (alternative to line number) */
  afterPattern?: string;
  beforePattern?: string;
  /** The compensation code to add */
  content: string;
  /** Explanation of why this compensation is needed */
  reason?: string;
  /** Will this be removed by a specific later commit? */
  removedBy?: string;
}

/**
 * Options for file-level summary generation
 */
export interface FileLevelSummaryOptions {
  /** Show inline changes for hunks with this many or fewer lines (default: 3) */
  inlineThreshold?: number;
  /** Include commit message field (default: true) */
  includeCommitMessage?: boolean;
}

/**
 * Generate a file-level summary for initial triage
 *
 * This provides a high-level view of all files with minimal context,
 * allowing the LLM to decide which files need detailed inspection.
 * Small changes (under inlineThreshold) are shown inline.
 */
export function generateFileLevelSummary(
  diff: ParsedDiff,
  options: FileLevelSummaryOptions = {}
): string {
  const { inlineThreshold = 3, includeCommitMessage = true } = options;
  const lines: string[] = [];

  lines.push('# File-Level Staging Plan');
  lines.push('');

  if (includeCommitMessage) {
    lines.push('Commit message: Describe this commit');
    lines.push('');
  }

  lines.push('Mark files for staging:');
  lines.push('- `[x]` = Include entire file');
  lines.push('- `[~]` = Partial selection (will need detailed diff)');
  lines.push('- `[ ]` = Skip for now');
  lines.push('');
  lines.push('---');
  lines.push('');

  // Process each file
  for (const file of diff.files) {
    const isNew = file.isNew;
    const isDeleted = file.isDeleted;
    const hunkCount = file.hunks.length;

    // Calculate total line changes
    let totalAdded = 0;
    let totalRemoved = 0;
    for (const hunk of file.hunks) {
      totalAdded += hunk.lines.filter(l => l.type === 'add').length;
      totalRemoved += hunk.lines.filter(l => l.type === 'remove').length;
    }

    // Build file summary line
    let summary = `[ ] ${file.newPath}`;

    if (isNew) {
      summary += ` (new file, ${totalAdded} lines)`;
    } else if (isDeleted) {
      summary += ` (deleted file, ${totalRemoved} lines)`;
    } else {
      const hunkText = hunkCount === 1 ? '1 hunk' : `${hunkCount} hunks`;
      summary += ` (modified, ${hunkText}, +${totalAdded}/-${totalRemoved})`;
    }

    lines.push(summary);

    // Show inline changes for small hunks
    if (hunkCount === 1 && totalAdded + totalRemoved <= inlineThreshold) {
      const hunk = file.hunks[0];
      lines.push('```diff');
      for (const line of hunk.lines) {
        const prefix = line.type === 'context' ? ' ' : line.type === 'add' ? '+' : '-';
        lines.push(`${prefix} ${line.content}`);
      }
      lines.push('```');
    }

    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('Mark files as [x] (include all), [~] (needs detailed selection), or [ ] (skip).');
  lines.push('Then call get_detailed_diff() for files marked [~].');

  return lines.join('\n');
}

/**
 * Generate detailed diff for specific files only
 *
 * This is the second stage after file-level triage.
 * Only generates the detailed line-by-line format for files that need partial selection.
 */
/**
 * Generate a staging plan document for all hunks in a diff
 *
 * Produces the document format that parseStagingPlanDocument can consume:
 * each hunk is pre-selected via "[x] Include entire hunk", with individual
 * line checkboxes available for granular control.
 */
export function generateStagingPlanDocument(diff: ParsedDiff, commitMessage = 'Describe this commit'): string {
  const hunkSections = diff.files.flatMap(file =>
    file.hunks.map(hunk => {
      const llmHunk = hunkToLLMHunk(hunk);
      const lineRows = llmHunk.lines.map(line => {
        const prefix = line.type === 'context' ? ' ' : line.type === 'add' ? '+' : '-';
        const checkbox = line.type === 'context' ? '   ' : '[ ]';
        const indexStr = `[${String(line.index).padStart(2)}]`;
        return `${checkbox} ${indexStr} ${prefix} ${line.content}`;
      }).join('\n');

      return `### ${hunk.id}

[x] Include entire hunk

Or select specific lines:
\`\`\`
${lineRows}
\`\`\`
`;
    })
  ).join('\n');

  return `# Staging Plan

Commit message: ${commitMessage}

---

${hunkSections}`;
}

export function generateDetailedDiffForFiles(
  diff: ParsedDiff,
  filePatterns: string[]
): string {
  const lines: string[] = [];

  lines.push('# Detailed Diff (Partial Files Only)');
  lines.push('');
  lines.push('Select specific lines/hunks to stage:');
  lines.push('');

  // Filter to only requested files
  const requestedFiles = diff.files.filter(file =>
    filePatterns.some(pattern =>
      file.newPath === pattern ||
      file.newPath.includes(pattern) ||
      file.oldPath === pattern ||
      file.oldPath.includes(pattern)
    )
  );

  if (requestedFiles.length === 0) {
    lines.push('No matching files found.');
    return lines.join('\n');
  }

  // Generate detailed view for each requested file
  for (const file of requestedFiles) {
    lines.push(`## ${file.newPath}`);
    lines.push('');

    for (const hunk of file.hunks) {
      const llmHunk = hunkToLLMHunk(hunk);
      lines.push(`### ${hunk.id}`);

      if (llmHunk.splittable) {
        lines.push(`(splittable into ${llmHunk.splitCount} sub-hunks)`);
      }
      lines.push('');

      // Full hunk checkbox
      lines.push(`[ ] Include entire hunk`);
      lines.push('');

      // Line-by-line selection
      lines.push('Or select specific lines:');
      lines.push('```');

      for (const line of llmHunk.lines) {
        const prefix = line.type === 'context' ? ' ' : line.type === 'add' ? '+' : '-';
        const checkbox = line.type === 'context' ? '   ' : '[ ]';
        const indexStr = `[${String(line.index).padStart(2)}]`;
        lines.push(`${checkbox} ${indexStr} ${prefix} ${line.content}`);
      }

      lines.push('```');
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Parse an edited staging plan document back into selections
 *
 * @param document - The edited staging plan document
 * @param diff - Optional: Original diff for file-level selection support
 */
export function parseStagingPlanDocument(document: string, diff?: ParsedDiff): StagingPlan {
  const lines = document.split('\n');

  // Extract commit message
  let commitMessage = 'untitled commit';
  for (const line of lines) {
    const msgMatch = line.match(/^Commit message:\s*(.+)$/);
    if (msgMatch) {
      commitMessage = msgMatch[1].trim();
      break;
    }
  }

  const selections: HunkSelection[] = [];
  const fileLevelSelections = new Map<string, 'all' | 'partial' | 'skip'>();

  // Parse file-level selections (if present)
  for (const line of lines) {
    // Match: [x] filename - include all
    // Match: [~] filename - partial
    // Match: [ ] filename - skip
    const fileMatch = line.match(/^\[(x|~| )\]\s+(\S+)/);
    if (fileMatch) {
      const [, checkbox, filename] = fileMatch;
      const mode = checkbox === 'x' ? 'all' : checkbox === '~' ? 'partial' : 'skip';
      fileLevelSelections.set(filename, mode);
    }
  }

  // If we have file-level selections and a diff, process them
  if (diff && fileLevelSelections.size > 0) {
    for (const file of diff.files) {
      const mode = fileLevelSelections.get(file.newPath) || fileLevelSelections.get(file.oldPath);

      if (mode === 'all') {
        // Include all hunks for this file
        for (const hunk of file.hunks) {
          selections.push({ hunkId: hunk.id, mode: 'all' });
        }
      } else if (mode === 'skip') {
        // Explicitly skip - add 'none' selections
        for (const hunk of file.hunks) {
          selections.push({ hunkId: hunk.id, mode: 'none' });
        }
      }
      // If mode === 'partial', we'll parse detailed selections below
    }
  }
  let currentHunkId: string | null = null;
  let entireHunkSelected = false;
  let selectedAdditions: number[] = [];
  let selectedRemovals: number[] = [];
  let lineEdits: LineEdit[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    // Detect hunk headers
    const hunkMatch = line.match(/^###\s+(\S+:\d+)/);
    if (hunkMatch) {
      // Save previous hunk if any
      if (currentHunkId) {
        selections.push(createSelectionWithRemovals(
          currentHunkId, entireHunkSelected, selectedAdditions, selectedRemovals, lineEdits
        ));
      }
      currentHunkId = hunkMatch[1];
      lineEdits = [];
      entireHunkSelected = false;
      selectedAdditions = [];
      selectedRemovals = [];
      inCodeBlock = false;
      continue;
    }

    // Detect "include entire hunk" checkbox
    if (line.match(/^\[x\]\s+Include entire hunk/i)) {
      entireHunkSelected = true;
      continue;
    }

    // Track code blocks
    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    // Parse line selections within code blocks
    if (inCodeBlock && currentHunkId) {
      // Match: [x] [index] + content (include addition)
      const addMatch = line.match(/^\[x\]\s+\[\s*(\d+)\]\s*\+/);
      if (addMatch) {
        selectedAdditions.push(parseInt(addMatch[1], 10));
        continue;
      }

      // Match: [x] [index] - content (include removal)
      const removeMatch = line.match(/^\[x\]\s+\[\s*(\d+)\]\s*-/);
      if (removeMatch) {
        selectedRemovals.push(parseInt(removeMatch[1], 10));
        continue;
      }

      // Match: [E] [index] +/- content (needs editing)
      const editMatch = line.match(/^\[E\]\s+\[\s*(\d+)\]/i);
      if (editMatch) {
        // Mark for editing - actual content comes from EDIT line
        selectedAdditions.push(parseInt(editMatch[1], 10));
        continue;
      }
    }

    // Parse EDIT directives (outside code blocks)
    // Format: EDIT [index]: new content
    const editDirective = line.match(/^EDIT\s+\[(\d+)\]:\s*(.+)$/);
    if (editDirective && currentHunkId) {
      lineEdits.push({
        lineIndex: parseInt(editDirective[1], 10),
        newContent: editDirective[2],
      });
      continue;
    }
  }

  // Don't forget the last hunk
  if (currentHunkId) {
    selections.push(createSelectionWithRemovals(
      currentHunkId, entireHunkSelected, selectedAdditions, selectedRemovals, lineEdits
    ));
  }

  // Parse compensations (level 6)
  const compensations = parseCompensations(document);

  return {
    commitMessage,
    selections,
    compensations: compensations.length > 0 ? compensations : undefined,
  };
}

/**
 * Parse COMPENSATE blocks from the document
 * Format:
 *   COMPENSATE file.js AFTER "pattern":
 *   COMPENSATE file.js AFTER LINE 10:
 *   COMPENSATE file.js BEFORE "pattern":
 *     code lines
 *   REASON: why needed
 *   REMOVED_BY: which commit removes this
 */
function parseCompensations(document: string): Compensation[] {
  const compensations: Compensation[] = [];
  const lines = document.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Match: COMPENSATE file.js AFTER "pattern": or AFTER LINE n:
    const afterPatternMatch = line.match(/^COMPENSATE\s+(\S+)\s+AFTER\s+"([^"]+)":/i);
    const afterLineMatch = line.match(/^COMPENSATE\s+(\S+)\s+AFTER\s+LINE\s+(\d+):/i);
    const beforePatternMatch = line.match(/^COMPENSATE\s+(\S+)\s+BEFORE\s+"([^"]+)":/i);

    if (afterPatternMatch || afterLineMatch || beforePatternMatch) {
      const compensation: Compensation = {
        file: (afterPatternMatch || afterLineMatch || beforePatternMatch)![1],
        type: afterPatternMatch ? 'add_after_line' : afterLineMatch ? 'add_after_line' : 'add_before_line',
        content: '',
      };

      if (afterPatternMatch) {
        compensation.afterPattern = afterPatternMatch[2];
      } else if (afterLineMatch) {
        compensation.lineNumber = parseInt(afterLineMatch[2], 10);
      } else if (beforePatternMatch) {
        compensation.beforePattern = beforePatternMatch[2];
      }

      // Collect content lines (indented or until REASON/REMOVED_BY/next COMPENSATE)
      i++;
      const contentLines: string[] = [];
      while (i < lines.length) {
        const contentLine = lines[i];

        // Check for metadata
        const reasonMatch = contentLine.match(/^REASON:\s*(.+)$/i);
        const removedByMatch = contentLine.match(/^REMOVED_BY:\s*(.+)$/i);

        if (reasonMatch) {
          compensation.reason = reasonMatch[1];
          i++;
          continue;
        }

        if (removedByMatch) {
          compensation.removedBy = removedByMatch[1];
          i++;
          continue;
        }

        // Check for next COMPENSATE block or end
        if (contentLine.match(/^COMPENSATE\s/i) || contentLine.match(/^###\s/)) {
          break;
        }

        // Content line (may be indented)
        if (contentLine.startsWith('  ') || contentLine.trim() === '') {
          contentLines.push(contentLine.replace(/^  /, ''));
        } else if (contentLines.length === 0) {
          // First non-indented, non-empty line after header - might be content
          contentLines.push(contentLine);
        } else {
          break;
        }
        i++;
      }

      compensation.content = contentLines.join('\n').trim();
      if (compensation.content) {
        compensations.push(compensation);
      }
      continue;
    }

    i++;
  }

  return compensations;
}

function createSelectionWithRemovals(
  hunkId: string,
  entireHunk: boolean,
  additions: number[],
  removals: number[],
  edits: LineEdit[] = []
): HunkSelection {
  if (entireHunk) {
    return { hunkId, mode: 'all', lineEdits: edits.length > 0 ? edits : undefined };
  } else if (additions.length > 0 || removals.length > 0 || edits.length > 0) {
    return {
      hunkId,
      mode: 'partial',
      includeAdditions: additions.length > 0 ? additions : undefined,
      includeRemovals: removals.length > 0 ? removals : undefined,
      lineEdits: edits.length > 0 ? edits : undefined,
    };
  } else {
    return { hunkId, mode: 'none' };
  }
}

/**
 * Execute a staging plan
 */
export function executeStagingPlan(
  diff: ParsedDiff,
  plan: StagingPlan
): { success: boolean; error?: string; stagedHunks: string[] } {
  const stagedHunks: string[] = [];

  for (const selection of plan.selections) {
    if (selection.mode === 'none') continue;

    const hunk = diff.getHunk(selection.hunkId);
    if (!hunk) {
      return { success: false, error: `Hunk not found: ${selection.hunkId}`, stagedHunks };
    }

    let patch: string;

    if (selection.mode === 'all' && !selection.lineEdits?.length) {
      patch = generatePatch([hunk]);
    } else {
      // Partial: need to edit hunk to include only selected changes
      const addIndices = hunk.lines
        .map((l, i) => ({ type: l.type, index: i }))
        .filter(x => x.type === 'add')
        .map(x => x.index);

      const removeIndices = hunk.lines
        .map((l, i) => ({ type: l.type, index: i }))
        .filter(x => x.type === 'remove')
        .map(x => x.index);

      // For additions: if mode is 'all', include all; else include only selected
      const includeAddSet = selection.mode === 'all'
        ? new Set(addIndices)
        : new Set(selection.includeAdditions || []);
      const removeAdditions = addIndices.filter(i => !includeAddSet.has(i));

      // For removals: if mode is 'all', include all; else only selected (others become context)
      const includeRemoveSet = selection.mode === 'all'
        ? new Set(removeIndices)
        : new Set(selection.includeRemovals || []);
      const keepRemovals = removeIndices.filter(i => !includeRemoveSet.has(i));

      const edited = editHunk(hunk, { removeAdditions, keepRemovals });
      patch = generatePatch([edited]);
    }

    // Validate before applying
    const check = checkPatch(patch);
    if (!check.applies) {
      return {
        success: false,
        error: `Patch for ${selection.hunkId} won't apply: ${check.error}`,
        stagedHunks,
      };
    }

    const result = applyPatchToIndex(patch);
    if (!result.success) {
      return {
        success: false,
        error: `Failed to stage ${selection.hunkId}: ${result.error}`,
        stagedHunks,
      };
    }

    stagedHunks.push(selection.hunkId);
  }

  return { success: true, stagedHunks };
}

/**
 * Apply compensations (level 6) - writes temporary code to files
 *
 * IMPORTANT: This modifies actual files, not just the index.
 * Compensations are temporary code that makes partial commits work.
 *
 * @param compensations - The compensations to apply
 * @param cwd - Working directory (defaults to process.cwd())
 * @returns Result with list of modified files
 */
export function applyCompensations(
  compensations: Compensation[],
  cwd: string = process.cwd()
): { success: boolean; error?: string; modifiedFiles: string[] } {
  const modifiedFiles: string[] = [];

  for (const comp of compensations) {
    const filePath = path.resolve(cwd, comp.file);

    // Read the file
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      return {
        success: false,
        error: `Cannot read file for compensation: ${comp.file}`,
        modifiedFiles,
      };
    }

    const lines = content.split('\n');
    let insertIndex = -1;

    // Find insertion point
    if (comp.lineNumber !== undefined) {
      insertIndex = comp.lineNumber; // Insert after this line (1-indexed)
    } else if (comp.afterPattern) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(comp.afterPattern)) {
          insertIndex = i + 1; // Insert after the matched line
          break;
        }
      }
    } else if (comp.beforePattern) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(comp.beforePattern)) {
          insertIndex = i; // Insert before the matched line
          break;
        }
      }
    }

    if (insertIndex === -1) {
      return {
        success: false,
        error: `Could not find insertion point for compensation in ${comp.file}`,
        modifiedFiles,
      };
    }

    // Insert the compensation code
    const compensationLines = comp.content.split('\n');
    const commentPrefix = getCommentPrefix(comp.file);
    const markerStart = `${commentPrefix} COMPENSATION START${comp.reason ? ': ' + comp.reason : ''}`;
    const markerEnd = `${commentPrefix} COMPENSATION END${comp.removedBy ? ' (remove when: ' + comp.removedBy + ')' : ''}`;

    lines.splice(insertIndex, 0, markerStart, ...compensationLines, markerEnd);

    // Write back
    try {
      fs.writeFileSync(filePath, lines.join('\n'));
      modifiedFiles.push(comp.file);
    } catch (err) {
      return {
        success: false,
        error: `Cannot write compensation to ${comp.file}`,
        modifiedFiles,
      };
    }
  }

  // Stage the compensation files
  if (modifiedFiles.length > 0) {
    try {
      git(['add', ...modifiedFiles], { cwd });
    } catch (err) {
      return {
        success: false,
        error: `Failed to stage compensation files`,
        modifiedFiles,
      };
    }
  }

  return { success: true, modifiedFiles };
}

/**
 * Get comment prefix for a file type
 */
function getCommentPrefix(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case '.py':
      return '#';
    case '.rb':
      return '#';
    case '.sh':
      return '#';
    case '.html':
      return '<!--';
    case '.css':
      return '/*';
    default:
      return '//';
  }
}

/**
 * Get a human-readable summary of what's currently staged
 */
export function getStagingSummary(): string {
  const stagedDiff = getStagedDiff();

  if (!stagedDiff.trim()) {
    return 'Nothing currently staged.';
  }

  const diff = parseDiff(stagedDiff);
  const lines: string[] = [];

  lines.push('# Currently Staged');
  lines.push('');

  for (const file of diff.files) {
    const addCount = file.hunks.flatMap(h => h.lines).filter(l => l.type === 'add').length;
    const removeCount = file.hunks.flatMap(h => h.lines).filter(l => l.type === 'remove').length;
    lines.push(`- ${file.newPath}: +${addCount}/-${removeCount} lines`);
  }

  lines.push('');
  lines.push('## Details');
  lines.push('');
  lines.push('```diff');

  for (const file of diff.files) {
    for (const hunk of file.hunks) {
      lines.push(hunk.header);
      for (const line of hunk.lines) {
        const prefix = line.type === 'context' ? ' ' : line.type === 'add' ? '+' : '-';
        lines.push(`${prefix}${line.content}`);
      }
    }
  }

  lines.push('```');

  return lines.join('\n');
}

/**
 * JSON-based alternative for structured communication
 * This is what an MCP tool might return for the LLM to modify
 */
export interface StagingWorksheet {
  commitMessage: string;
  files: {
    path: string;
    hunks: {
      id: string;
      summary: string;
      splittable: boolean;
      /** LLM sets this to indicate selection */
      include: 'all' | 'none' | 'partial';
      lines: {
        index: number;
        type: 'context' | 'add' | 'remove';
        content: string;
        /** LLM sets this for partial selection */
        include: boolean;
      }[];
    }[];
  }[];
}

/**
 * Generate a worksheet that can be edited and returned
 */
export function generateWorksheet(diff: ParsedDiff, commitMessage: string = ''): StagingWorksheet {
  const files = [];

  for (const file of diff.files) {
    const hunks = [];
    for (const hunk of file.hunks) {
      const llmHunk = hunkToLLMHunk(hunk);
      hunks.push({
        id: hunk.id,
        summary: llmHunk.summary,
        splittable: llmHunk.splittable,
        include: 'none' as const,
        lines: llmHunk.lines.map(l => ({
          index: l.index,
          type: l.type,
          content: l.content,
          include: false,
        })),
      });
    }
    files.push({ path: file.newPath, hunks });
  }

  return { commitMessage, files };
}

/**
 * Execute a completed worksheet
 */
export function executeWorksheet(
  diff: ParsedDiff,
  worksheet: StagingWorksheet
): { success: boolean; error?: string; stagedHunks: string[] } {
  const selections: HunkSelection[] = [];

  for (const file of worksheet.files) {
    for (const hunk of file.hunks) {
      if (hunk.include === 'all') {
        selections.push({ hunkId: hunk.id, mode: 'all' });
      } else if (hunk.include === 'partial') {
        const includeAdditions = hunk.lines
          .filter(l => l.include && l.type === 'add')
          .map(l => l.index);
        const includeRemovals = hunk.lines
          .filter(l => l.include && l.type === 'remove')
          .map(l => l.index);
        selections.push({
          hunkId: hunk.id,
          mode: 'partial',
          includeAdditions: includeAdditions.length > 0 ? includeAdditions : undefined,
          includeRemovals: includeRemovals.length > 0 ? includeRemovals : undefined,
        });
      }
      // 'none' is implicitly skipped
    }
  }

  return executeStagingPlan(diff, { commitMessage: worksheet.commitMessage, selections });
}
