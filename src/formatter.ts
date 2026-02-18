import { Hunk, ParsedDiff } from './types.js';

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
  const adds = hunk.lines.filter(l => l.type === 'add');
  const removes = hunk.lines.filter(l => l.type === 'remove');

  let description = '';
  if (removes.length > 0 && adds.length > 0) {
    description = `removes ${removes.length} line(s), adds ${adds.length} line(s)`;
  } else if (adds.length > 0) {
    description = `adds ${adds.length} line(s)`;
  } else if (removes.length > 0) {
    description = `removes ${removes.length} line(s)`;
  }

  const allContent = [...adds, ...removes].map(l => l.content).join('\n');
  const tags: string[] = [];
  if (/console\.log|logger\.|log\(/.test(allContent))          tags.push('logging');
  if (/import |require\(|from ['"]/.test(allContent))          tags.push('imports');
  if (/function |const .* = \(|=> \{/.test(allContent))        tags.push('function definition');
  if (/try\s*\{|catch\s*\(|throw |\.catch\(/.test(allContent)) tags.push('error handling');
  if (/async |await |Promise|\.then\(/.test(allContent))        tags.push('async');
  if (/if\s*\(|else\s*\{|switch\s*\(|case /.test(allContent))  tags.push('conditional');

  const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
  return (description + tagStr) || 'changes code';
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

    const displayLines = maxLinesPerHunk && hunk.lines.length > maxLinesPerHunk
      ? hunk.lines.slice(0, maxLinesPerHunk)
      : hunk.lines;

    const padWidth = Math.max(3, String(hunk.oldStart + hunk.oldCount).length);
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;

    for (const line of displayLines) {
      const prefix = line.type === 'context' ? ' ' : line.type === 'add' ? '+' : '-';
      if (includeLineNumbers) {
        const oldNum = line.type === 'add' ? ' '.repeat(padWidth) : String(oldLine).padStart(padWidth);
        const newNum = line.type === 'remove' ? ' '.repeat(padWidth) : String(newLine).padStart(padWidth);
        lines.push(`${oldNum} ${newNum} ${prefix}${line.content}`);
      } else {
        lines.push(`${prefix}${line.content}`);
      }
      if (line.type !== 'add') oldLine++;
      if (line.type !== 'remove') newLine++;
    }

    if (maxLinesPerHunk && hunk.lines.length > maxLinesPerHunk) {
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
  const allHunks = diff.getAllHunks();

  const fileList = diff.files
    .map(file => {
      const status = file.isNew ? '(new)' : file.isDeleted ? '(deleted)' : file.isRenamed ? '(renamed)' : '';
      return `- ${file.newPath} ${status} - ${file.hunks.length} hunk(s)`;
    })
    .join('\n');

  const hunkList = allHunks.map(hunk => formatHunk(hunk, options)).join('\n\n');

  return `# Git Diff Analysis

Total files changed: ${diff.files.length}
Total hunks: ${allHunks.length}

## Files
${fileList}

## Hunks

Each hunk represents a contiguous block of changes. Use the hunk IDs to select which changes belong together.

${hunkList}
`;
}

/**
 * Format a compact hunk list for quick selection
 */
export function formatHunkList(hunks: Hunk[]): string {
  const header = '| ID | File | Lines | Summary |';
  const separator = '|' + header.split('|').filter(Boolean).map(col => '-'.repeat(col.length)).join('|') + '|';

  const rows = hunks.map(hunk => {
    const lineRange = `${hunk.oldStart}-${hunk.oldStart + hunk.oldCount - 1}`;
    return `| ${hunk.id} | ${hunk.file} | ${lineRange} | ${summarizeHunk(hunk)} |`;
  });

  return [header, separator, ...rows].join('\n');
}

/**
 * Create a selection prompt for an LLM
 */
export function createSelectionPrompt(diff: ParsedDiff): string {
  return `# Hunk Selection Task

The following changes need to be organized into logical commits.
Review each hunk and group them by their purpose.

${formatHunkList(diff.getAllHunks())}

## Instructions

Group the hunks into logical commits. Each group should represent a single, atomic change.

Respond with a JSON array of groups:
\`\`\`json
[
  {
    "label": "Add logging infrastructure",
    "hunkIds": ["app.js:0", "app.js:1"],
    "commitMessage": "feat: add logging infrastructure"
  },
  {
    "label": "Add error handling",
    "hunkIds": ["app.js:2"],
    "commitMessage": "fix: add error handling to plugin loader"
  }
]
\`\`\``;
}
