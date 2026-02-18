import { execSync, spawn } from 'child_process';
import { ApplyResult, Hunk } from './types.js';
import { generatePatch } from './manipulator.js';

export interface GitOptions {
  /** Working directory (defaults to cwd) */
  cwd?: string;
  /** Path to git executable (defaults to 'git') */
  gitPath?: string;
}

/**
 * Execute a git command and return the output
 */
export function git(args: string[], options: GitOptions = {}): string {
  const { cwd = process.cwd(), gitPath = 'git' } = options;

  try {
    const result = execSync(`${gitPath} ${args.join(' ')}`, {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large diffs
      stdio: ['pipe', 'pipe', 'pipe'], // Capture stderr
    });
    return result;
  } catch (error: any) {
    if (error.stdout) {
      return error.stdout;
    }
    // Return empty string for expected "no output" cases like empty diffs
    if (error.status === 0) {
      return '';
    }
    throw error;
  }
}

/**
 * Get the unstaged diff from the working directory
 */
export function getUnstagedDiff(options: GitOptions = {}): string {
  return git(['diff'], options);
}

/**
 * Get the staged diff
 */
export function getStagedDiff(options: GitOptions = {}): string {
  return git(['diff', '--cached'], options);
}

/**
 * Get diff with custom context lines
 */
export function getDiffWithContext(contextLines: number, options: GitOptions = {}): string {
  return git(['diff', `-U${contextLines}`], options);
}

/**
 * Check if a patch would apply cleanly
 */
export function checkPatch(patch: string, options: GitOptions = {}): { applies: boolean; error?: string } {
  const { cwd = process.cwd(), gitPath = 'git' } = options;

  try {
    execSync(`${gitPath} apply --check --cached`, {
      cwd,
      input: patch,
      encoding: 'utf-8',
    });
    return { applies: true };
  } catch (error: any) {
    return {
      applies: false,
      error: error.stderr || error.message,
    };
  }
}

/**
 * Apply a patch to the git index (staging area)
 */
export function applyPatchToIndex(patch: string, options: GitOptions = {}): ApplyResult {
  const { cwd = process.cwd(), gitPath = 'git' } = options;

  try {
    execSync(`${gitPath} apply --cached`, {
      cwd,
      input: patch,
      encoding: 'utf-8',
    });
    return { success: true };
  } catch (error: any) {
    return {
      success: false,
      error: error.stderr || error.message,
    };
  }
}

/**
 * Apply a patch with --recount flag (ignores header counts)
 */
export function applyPatchWithRecount(patch: string, options: GitOptions = {}): ApplyResult {
  const { cwd = process.cwd(), gitPath = 'git' } = options;

  try {
    execSync(`${gitPath} apply --cached --recount`, {
      cwd,
      input: patch,
      encoding: 'utf-8',
    });
    return { success: true };
  } catch (error: any) {
    return {
      success: false,
      error: error.stderr || error.message,
    };
  }
}

/**
 * Apply hunks to the index
 */
export function applyHunksToIndex(hunks: Hunk[], options: GitOptions = {}): ApplyResult {
  const patch = generatePatch(hunks);
  return applyPatchToIndex(patch, options);
}

/**
 * Reset the staging area (unstage all)
 */
export function resetStaging(options: GitOptions = {}): void {
  git(['reset', 'HEAD'], options);
}

/**
 * Get list of staged files
 */
export function getStagedFiles(options: GitOptions = {}): string[] {
  const output = git(['diff', '--cached', '--name-only'], options);
  return output.trim().split('\n').filter(Boolean);
}

/**
 * Create a commit with the staged changes
 */
export function commit(message: string, options: GitOptions = {}): { success: boolean; hash?: string; error?: string } {
  const { cwd = process.cwd(), gitPath = 'git' } = options;

  try {
    const result = execSync(`${gitPath} commit -m "${message.replace(/"/g, '\\"')}"`, {
      cwd,
      encoding: 'utf-8',
    });

    // Try to extract the commit hash
    const hashMatch = result.match(/\[[\w-]+ ([a-f0-9]+)\]/);
    return {
      success: true,
      hash: hashMatch ? hashMatch[1] : undefined,
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.stderr || error.message,
    };
  }
}

/**
 * Get the status of the working directory
 */
export function getStatus(options: GitOptions = {}): string {
  return git(['status', '--porcelain'], options);
}

/**
 * Reverse a patch (undo changes in staging)
 */
export function reversePatch(patch: string, options: GitOptions = {}): ApplyResult {
  const { cwd = process.cwd(), gitPath = 'git' } = options;

  try {
    execSync(`${gitPath} apply --cached --reverse`, {
      cwd,
      input: patch,
      encoding: 'utf-8',
    });
    return { success: true };
  } catch (error: any) {
    return {
      success: false,
      error: error.stderr || error.message,
    };
  }
}
