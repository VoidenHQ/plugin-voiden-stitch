import type { StitchFileResult, StitchSectionResult } from './types';

/**
 * Decide whether a request section failed. Assertions determine the outcome
 * when present; HTTP status is the fallback when there are none.
 * @param section The completed request section.
 * @returns Whether the section failed.
 */
export function isSectionFailed(section: StitchSectionResult): boolean {
  if (section.error || section.assertions.failed > 0) return true;
  if (section.assertions.total > 0) return false;
  return section.status !== null && section.status >= 400;
}

/**
 * Check a file's stored outcome and its individual request sections.
 * @param file The completed file result.
 * @returns Whether the file should appear in failure reports and filters.
 */
export function isFileFailed(file: StitchFileResult): boolean {
  if (file.status === 'failed' || file.status === 'error') return true;
  return file.sections.some(isSectionFailed);
}
