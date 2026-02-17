import { DiffLine, FileDiff, Hunk, HunkGroup, ParsedDiff } from './types.js';

/**
 * Check if a hunk can be split into smaller hunks
 * A hunk is splittable if it has a context line gap between change groups
 */
export function isSplittable(hunk: Hunk, minContextGap: number = 1): boolean {
  let inChangeGroup = false;
  let contextCount = 0;
  let foundGap = false;

  for (const line of hunk.lines) {
    if (line.type === 'context') {
      if (inChangeGroup) {
        contextCount++;
        if (contextCount >= minContextGap) {
          // We found a gap, now look for another change group
          inChangeGroup = false;
        }
      }
    } else {
      if (!inChangeGroup && contextCount >= minContextGap && contextCount > 0) {
        // We were in a gap and found a new change group
        foundGap = true;
        break;
      }
      inChangeGroup = true;
      contextCount = 0;
    }
  }

  return foundGap;
}

/**
 * Split a hunk into smaller hunks at context gaps
 */
export function splitHunk(hunk: Hunk, minContextGap: number = 1): Hunk[] {
  if (!isSplittable(hunk, minContextGap)) {
    return [hunk];
  }

  const groups: DiffLine[][] = [];
  let currentGroup: DiffLine[] = [];
  let contextBuffer: DiffLine[] = [];
  let inChangeGroup = false;

  for (const line of hunk.lines) {
    if (line.type === 'context') {
      contextBuffer.push(line);

      if (inChangeGroup && contextBuffer.length >= minContextGap) {
        // End the current group with some trailing context
        const trailingContext = contextBuffer.slice(0, Math.min(minContextGap, contextBuffer.length));
        currentGroup.push(...trailingContext);
        groups.push(currentGroup);

        // Start a new group with leading context
        currentGroup = [...contextBuffer.slice(Math.min(minContextGap, contextBuffer.length))];
        inChangeGroup = false;
      }
    } else {
      // A change line - add buffered context and this line
      if (!inChangeGroup && currentGroup.length === 0) {
        // Starting a new group - include leading context
        currentGroup = [...contextBuffer];
      } else if (!inChangeGroup) {
        // Resuming changes after a gap - already have context in currentGroup
        currentGroup.push(...contextBuffer);
      } else {
        // Continuing changes - add any context between changes
        currentGroup.push(...contextBuffer);
      }
      contextBuffer = [];
      currentGroup.push(line);
      inChangeGroup = true;
    }
  }

  // Don't forget trailing context for the last group
  if (currentGroup.length > 0) {
    currentGroup.push(...contextBuffer);
    groups.push(currentGroup);
  }

  // Convert groups back to hunks with proper line numbers
  const result: Hunk[] = [];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  let groupIndex = 0;

  for (const group of groups) {
    // Calculate the starting positions for this sub-hunk
    const subHunkOldStart = oldLine;
    const subHunkNewStart = newLine;

    // Count lines in this group
    let subOldCount = 0;
    let subNewCount = 0;

    for (const line of group) {
      if (line.type === 'context') {
        subOldCount++;
        subNewCount++;
      } else if (line.type === 'remove') {
        subOldCount++;
      } else if (line.type === 'add') {
        subNewCount++;
      }
    }

    // Create the sub-hunk
    const subHunk: Hunk = {
      id: `${hunk.file}:${hunk.index}.${groupIndex}`,
      file: hunk.file,
      index: hunk.index,
      header: `@@ -${subHunkOldStart},${subOldCount} +${subHunkNewStart},${subNewCount} @@${hunk.context ? ' ' + hunk.context : ''}`,
      oldStart: subHunkOldStart,
      oldCount: subOldCount,
      newStart: subHunkNewStart,
      newCount: subNewCount,
      lines: group,
      context: hunk.context,
    };

    result.push(subHunk);
    groupIndex++;

    // Advance line counters
    for (const line of group) {
      if (line.type !== 'add') oldLine++;
      if (line.type !== 'remove') newLine++;
    }
  }

  return result;
}

/**
 * Select specific hunks by ID
 */
export function selectHunks(diff: ParsedDiff, ids: string[]): Hunk[] {
  const idSet = new Set(ids);
  return diff.getAllHunks().filter((h: Hunk) => idSet.has(h.id));
}

/**
 * Parse a hunk ID that may include a line index.
 *
 * Formats:
 *   "src/file.ts:0"    → whole hunk (baseId only)
 *   "src/file.ts:0:3"  → line index 3 within hunk 0
 */
function parseHunkId(id: string): { baseId: string; lineIndex?: number } {
  // Match trailing :N where the remainder also ends in :N (i.e. three-part ID)
  const lineMatch = id.match(/^(.+:\d+):(\d+)$/);
  if (lineMatch) {
    return { baseId: lineMatch[1], lineIndex: parseInt(lineMatch[2], 10) };
  }
  return { baseId: id };
}

/**
 * Select hunks by ID with optional line-level selection.
 *
 * IDs can be:
 *   "src/file.ts:0"    → include the entire hunk
 *   "src/file.ts:0:3"  → include only line index 3 from hunk 0
 *
 * Multiple line-level IDs for the same hunk are merged: only the specified
 * addition lines are staged; all other additions are dropped via editHunk.
 */
export function selectHunksWithLines(diff: ParsedDiff, ids: string[]): Hunk[] {
  const wholeHunkIds = new Set<string>();
  const linesByHunk = new Map<string, Set<number>>();

  for (const id of ids) {
    const parsed = parseHunkId(id);
    if (parsed.lineIndex !== undefined) {
      const existing = linesByHunk.get(parsed.baseId) ?? new Set<number>();
      existing.add(parsed.lineIndex);
      linesByHunk.set(parsed.baseId, existing);
    } else {
      wholeHunkIds.add(parsed.baseId);
    }
  }

  const result: Hunk[] = [];

  for (const hunk of diff.getAllHunks()) {
    if (wholeHunkIds.has(hunk.id)) {
      result.push(hunk);
    } else if (linesByHunk.has(hunk.id)) {
      const selected = linesByHunk.get(hunk.id)!;
      const removeAdditions = hunk.lines
        .map((l, i) => ({ type: l.type, i }))
        .filter(x => x.type === 'add' && !selected.has(x.i))
        .map(x => x.i);
      result.push(editHunk(hunk, { removeAdditions }));
    }
  }

  return result;
}

/**
 * Group hunks together for a commit
 */
export function groupHunks(hunks: Hunk[], label: string): HunkGroup {
  return {
    label,
    hunks,
    toPatch(): string {
      return generatePatch(hunks);
    },
  };
}

/**
 * Generate a valid patch string from a set of hunks
 * Handles line number adjustments for hunks from the same file
 */
export function generatePatch(hunks: Hunk[]): string {
  if (hunks.length === 0) return '';

  // Group hunks by file
  const byFile = new Map<string, Hunk[]>();
  for (const hunk of hunks) {
    const existing = byFile.get(hunk.file) || [];
    existing.push(hunk);
    byFile.set(hunk.file, existing);
  }

  const sections: string[] = [];

  for (const [file, fileHunks] of byFile) {
    // Sort hunks by their original line number
    const sorted = [...fileHunks].sort((a, b) => a.oldStart - b.oldStart);

    // Generate file header
    sections.push(`diff --git a/${file} b/${file}`);
    sections.push(`--- a/${file}`);
    sections.push(`+++ b/${file}`);

    // Generate each hunk
    for (const hunk of sorted) {
      sections.push(hunk.header);
      for (const line of hunk.lines) {
        const prefix = line.type === 'context' ? ' ' : line.type === 'add' ? '+' : '-';
        sections.push(`${prefix}${line.content}`);
      }
    }
  }

  return sections.join('\n') + '\n';
}

/**
 * Recalculate hunk header based on actual lines
 */
export function recalculateHeader(hunk: Hunk): string {
  let oldCount = 0;
  let newCount = 0;

  for (const line of hunk.lines) {
    if (line.type === 'context') {
      oldCount++;
      newCount++;
    } else if (line.type === 'remove') {
      oldCount++;
    } else if (line.type === 'add') {
      newCount++;
    }
  }

  const contextPart = hunk.context ? ` ${hunk.context}` : '';
  return `@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@${contextPart}`;
}

/**
 * Edit a hunk by removing specific lines
 * Returns a new hunk with the modifications
 */
export function editHunk(
  hunk: Hunk,
  modifications: {
    /** Indices in hunk.lines of '+' lines to remove from the patch (won't be added) */
    removeAdditions?: number[];
    /** Indices in hunk.lines of '-' lines to convert to context (won't be removed) */
    keepRemovals?: number[];
  }
): Hunk {
  const removeAddSet = new Set(modifications.removeAdditions || []);
  const keepRemovalSet = new Set(modifications.keepRemovals || []);

  const newLines: DiffLine[] = [];

  for (let i = 0; i < hunk.lines.length; i++) {
    const line = hunk.lines[i];

    if (line.type === 'add') {
      if (!removeAddSet.has(i)) {
        newLines.push(line);
      }
    } else if (line.type === 'remove') {
      if (keepRemovalSet.has(i)) {
        // Convert to context line
        newLines.push({ type: 'context', content: line.content });
      } else {
        newLines.push(line);
      }
    } else {
      newLines.push(line);
    }
  }

  const editedHunk: Hunk = {
    ...hunk,
    lines: newLines,
  };

  // Recalculate counts
  let oldCount = 0;
  let newCount = 0;
  for (const line of newLines) {
    if (line.type === 'context') {
      oldCount++;
      newCount++;
    } else if (line.type === 'remove') {
      oldCount++;
    } else if (line.type === 'add') {
      newCount++;
    }
  }

  editedHunk.oldCount = oldCount;
  editedHunk.newCount = newCount;
  editedHunk.header = recalculateHeader(editedHunk);

  return editedHunk;
}
