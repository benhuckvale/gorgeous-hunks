import { DiffLine, Hunk, ParsedDiff } from './types.js';

/**
 * Format options for LLM output
 */
export interface FormatOptions {
  /** Include full diff content for each hunk (default: true) */
  includeContent?: boolean;
  /** Include line numbers in content (default: true) */
  includeLineNumbers?: boolean;
  /** Include summary of changes (default: true) */
  includeSummary?: boolean;
  /** Maximum lines to show per hunk before truncating (default: unlimited) */
  maxLinesPerHunk?: number;
}

/**
 * Generate a summary of what a hunk does
 */
export function summarizeHunk(hunk: Hunk): string {
  const adds = hunk.lines.filter((l): l is DiffLine => l.type === 'add');
  const removes = hunk.lines.filter((l): l is DiffLine => l.type === 'remove');

  const parts: string[] = [];

  if (removes.length > 0 && adds.length > 0) {
    parts.push(`modifies ${adds.length} line(s)`);
  } else if (adds.length > 0) {
    parts.push(`adds ${adds.length} line(s)`);
  } else if (removes.length > 0) {
    parts.push(`removes ${removes.length} line(s)`);
  }

  // Try to identify what kind of change this is
  const allContent = [...adds, ...removes].map((l: DiffLine) => l.content).join('\n');

  if (/console\.log|logger\.|log\(/.test(allContent)) {
    parts.push('(logging)');
  }
  if (/import |require\(|from ['"]/.test(allContent)) {
    parts.push('(imports)');
  }
  if (/function |const .* = \(|=> \{/.test(allContent)) {
    parts.push('(function definition)');
  }
  if (/try\s*\{|catch\s*\(|throw |\.catch\(/.test(allContent)) {
    parts.push('(error handling)');
  }
  if (/async |await |Promise|\.then\(/.test(allContent)) {
    parts.push('(async)');
  }
  if (/if\s*\(|else\s*\{|switch\s*\(|case /.test(allContent)) {
    parts.push('(conditional)');
  }

  return parts.join(' ') || 'changes code';
}

/**
 * Format a single hunk for LLM consumption
 */
export function formatHunk(hunk: Hunk, options: FormatOptions = {}): string {
  const {
    includeContent = true,
    includeLineNumbers = true,
    includeSummary = true,
    maxLinesPerHunk,
  } = options;

  const lines: string[] = [];

  // Header with ID and location
  lines.push(`## Hunk ${hunk.id}`);
  lines.push(`File: ${hunk.file}`);
  lines.push(`Location: lines ${hunk.oldStart}-${hunk.oldStart + hunk.oldCount - 1} (original)`);

  if (hunk.context) {
    lines.push(`Context: ${hunk.context}`);
  }

  if (includeSummary) {
    lines.push(`Summary: ${summarizeHunk(hunk)}`);
  }

  if (includeContent) {
    lines.push('');
    lines.push('```diff');

    let displayLines = hunk.lines;
    let truncated = false;

    if (maxLinesPerHunk && hunk.lines.length > maxLinesPerHunk) {
      displayLines = hunk.lines.slice(0, maxLinesPerHunk);
      truncated = true;
    }

    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;

    for (const line of displayLines) {
      const prefix = line.type === 'context' ? ' ' : line.type === 'add' ? '+' : '-';

      if (includeLineNumbers) {
        const oldNum = line.type === 'add' ? '   ' : String(oldLine).padStart(3);
        const newNum = line.type === 'remove' ? '   ' : String(newLine).padStart(3);
        lines.push(`${oldNum} ${newNum} ${prefix}${line.content}`);
      } else {
        lines.push(`${prefix}${line.content}`);
      }

      if (line.type !== 'add') oldLine++;
      if (line.type !== 'remove') newLine++;
    }

    if (truncated && maxLinesPerHunk !== undefined) {
      lines.push(`... (${hunk.lines.length - maxLinesPerHunk} more lines)`);
    }

    lines.push('```');
  }

  return lines.join('\n');
}

/**
 * Format an entire diff for LLM consumption
 */
export function formatDiffForLLM(diff: ParsedDiff, options: FormatOptions = {}): string {
  const sections: string[] = [];

  // Overview
  const allHunks = diff.getAllHunks();
  sections.push('# Git Diff Analysis');
  sections.push('');
  sections.push(`Total files changed: ${diff.files.length}`);
  sections.push(`Total hunks: ${allHunks.length}`);
  sections.push('');

  // File summary
  sections.push('## Files');
  for (const file of diff.files) {
    const status = file.isNew ? '(new)' : file.isDeleted ? '(deleted)' : file.isRenamed ? '(renamed)' : '';
    sections.push(`- ${file.newPath} ${status} - ${file.hunks.length} hunk(s)`);
  }
  sections.push('');

  // Individual hunks
  sections.push('## Hunks');
  sections.push('');
  sections.push('Each hunk represents a contiguous block of changes. Use the hunk IDs to select which changes belong together.');
  sections.push('');

  for (const hunk of allHunks) {
    sections.push(formatHunk(hunk, options));
    sections.push('');
  }

  return sections.join('\n');
}

/**
 * Format a compact hunk list for quick selection
 */
export function formatHunkList(hunks: Hunk[]): string {
  const lines: string[] = [];
  lines.push('| ID | File | Lines | Summary |');
  lines.push('|----|------|-------|---------|');

  for (const hunk of hunks) {
    const lineRange = `${hunk.oldStart}-${hunk.oldStart + hunk.oldCount - 1}`;
    const summary = summarizeHunk(hunk);
    lines.push(`| ${hunk.id} | ${hunk.file} | ${lineRange} | ${summary} |`);
  }

  return lines.join('\n');
}

/**
 * Create a selection prompt for an LLM
 */
export function createSelectionPrompt(diff: ParsedDiff): string {
  const sections: string[] = [];

  sections.push('# Hunk Selection Task');
  sections.push('');
  sections.push('The following changes need to be organized into logical commits.');
  sections.push('Review each hunk and group them by their purpose.');
  sections.push('');
  sections.push(formatHunkList(diff.getAllHunks()));
  sections.push('');
  sections.push('## Instructions');
  sections.push('');
  sections.push('Group the hunks into logical commits. Each group should represent a single, atomic change.');
  sections.push('');
  sections.push('Respond with a JSON array of groups:');
  sections.push('```json');
  sections.push('[');
  sections.push('  {');
  sections.push('    "label": "Add logging infrastructure",');
  sections.push('    "hunkIds": ["app.js:0", "app.js:1"],');
  sections.push('    "commitMessage": "feat: add logging infrastructure"');
  sections.push('  },');
  sections.push('  {');
  sections.push('    "label": "Add error handling",');
  sections.push('    "hunkIds": ["app.js:2"],');
  sections.push('    "commitMessage": "fix: add error handling to plugin loader"');
  sections.push('  }');
  sections.push(']');
  sections.push('```');

  return sections.join('\n');
}
