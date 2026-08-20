/**
 * Export stitch run results to a Markdown report.
 *
 * Unlike the Excel export (full per-request detail across many sheets), this
 * is meant to be a quick, shareable-as-text summary: overall pass/fail counts,
 * a status-code distribution table, a callout for the "200 but failed on
 * assertions" case, and a dedicated section listing only what failed.
 */

import type { StitchRunState, StitchFileResult, StitchSectionResult } from './types';

// ─── Shared helpers (mirrors exportExcel.ts's local copies) ────────────────────

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return '—';
  return `${Math.round((numerator / denominator) * 100)}%`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

/** A section is "failed" the same way the results sidebar decides it (assertions, transport error, or HTTP >= 400). */
export function isSectionFailed(section: StitchSectionResult): boolean {
  const httpFailed = section.status !== null && section.status >= 400;
  return section.assertions.failed > 0 || !!section.error || httpFailed;
}

/** A file is "failed" for report/filter purposes if its own status says so, or any section inside it failed. */
export function isFileFailed(file: StitchFileResult): boolean {
  if (file.status === 'failed' || file.status === 'error') return true;
  return file.sections.some(isSectionFailed);
}

function escapeMd(text: string): string {
  // Keep table cells on one line and free of pipe collisions.
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ⏎ ');
}

function sectionLabel(section: StitchSectionResult): string {
  const method = section.requestInfo?.method ? `${section.requestInfo.method} ` : '';
  const target = section.requestInfo?.url || section.sectionLabel || `Section ${section.sectionIndex + 1}`;
  return `${method}${target}`;
}

// ─── Status code breakdown ──────────────────────────────────────────────────────

interface StatusCodeStat {
  code: string; // e.g. "200" or "(no response)"
  count: number;
}

function buildStatusCodeStats(files: StitchFileResult[]): { stats: StatusCodeStat[]; totalResponses: number } {
  const counts = new Map<string, number>();
  let totalResponses = 0;

  for (const file of files) {
    for (const section of file.sections) {
      const key = section.status != null ? String(section.status) : '(no response)';
      counts.set(key, (counts.get(key) ?? 0) + 1);
      totalResponses++;
    }
  }

  const stats = Array.from(counts.entries())
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => {
      // Numeric codes ascending, "(no response)" last
      const an = Number(a.code), bn = Number(b.code);
      if (Number.isNaN(an)) return 1;
      if (Number.isNaN(bn)) return -1;
      return an - bn;
    });

  return { stats, totalResponses };
}

/** Sections that got a successful (2xx) HTTP status but are still counted as failed — almost always an assertion failure. */
function findPassingHttpButFailedSections(files: StitchFileResult[]): Array<{ file: StitchFileResult; section: StitchSectionResult }> {
  const out: Array<{ file: StitchFileResult; section: StitchSectionResult }> = [];
  for (const file of files) {
    for (const section of file.sections) {
      const httpOk = section.status !== null && section.status >= 200 && section.status < 300;
      if (httpOk && isSectionFailed(section)) {
        out.push({ file, section });
      }
    }
  }
  return out;
}

// ─── Report sections ─────────────────────────────────────────────────────────────

function buildHeader(run: StitchRunState): string[] {
  const s = run.summary;
  const hasFailures = s.failedFiles + s.errorFiles > 0;
  const overallStatus = run.status === 'completed'
    ? (hasFailures ? 'FAILED' : 'PASSED')
    : run.status.toUpperCase();

  const lines = [
    '# Stitch Run Report',
    '',
    `- **Status:** ${overallStatus}`,
  ];
  if (run.startedAt) lines.push(`- **Started:** ${new Date(run.startedAt).toLocaleString()}`);
  if (run.duration > 0) lines.push(`- **Duration:** ${formatDuration(run.duration)}`);
  lines.push('');
  return lines;
}

function buildSummaryTables(run: StitchRunState): string[] {
  const s = run.summary;
  return [
    '## Summary',
    '',
    '| Files | Count | % |',
    '|---|---|---|',
    `| Total | ${s.totalFiles} | — |`,
    `| Passed | ${s.passedFiles} | ${pct(s.passedFiles, s.totalFiles)} |`,
    `| Failed | ${s.failedFiles} | ${pct(s.failedFiles, s.totalFiles)} |`,
    `| Errored | ${s.errorFiles} | ${pct(s.errorFiles, s.totalFiles)} |`,
    `| Skipped | ${s.skippedFiles} | ${pct(s.skippedFiles, s.totalFiles)} |`,
    '',
    '| Assertions | Count | % |',
    '|---|---|---|',
    `| Total | ${s.totalAssertions} | — |`,
    `| Passed | ${s.passedAssertions} | ${pct(s.passedAssertions, s.totalAssertions)} |`,
    `| Failed | ${s.failedAssertions} | ${pct(s.failedAssertions, s.totalAssertions)} |`,
    '',
  ];
}

function buildStatusCodeSection(run: StitchRunState): string[] {
  const { stats, totalResponses } = buildStatusCodeStats(run.files);
  const lines = ['## Status Code Breakdown', ''];

  if (stats.length === 0) {
    lines.push('_No responses recorded._', '');
    return lines;
  }

  lines.push('| Status Code | Count | % of Responses |', '|---|---|---|');
  for (const { code, count } of stats) {
    lines.push(`| ${code} | ${count} | ${pct(count, totalResponses)} |`);
  }
  lines.push('');

  const okButFailed = findPassingHttpButFailedSections(run.files);
  lines.push(`**Successful HTTP status (2xx) but marked failed due to assertions: ${okButFailed.length}**`, '');
  if (okButFailed.length > 0) {
    lines.push('<details>', '<summary>Show endpoints</summary>', '');
    for (const { file, section } of okButFailed) {
      const failedAssertions = section.assertions.results.filter((a) => !a.passed);
      const reason = failedAssertions.length > 0
        ? failedAssertions.map((a) => a.description || a.error || 'assertion failed').join('; ')
        : section.error || 'assertion failed';
      lines.push(`- \`${sectionLabel(section)}\` (${file.fileName}) — ${section.status} ${section.statusText ?? ''} — ${escapeMd(reason)}`);
    }
    lines.push('', '</details>', '');
  }

  return lines;
}

function buildFailedEndpointsSection(run: StitchRunState): string[] {
  const failedFiles = run.files.filter(isFileFailed);
  const lines = ['## Failed Endpoints', ''];

  if (failedFiles.length === 0) {
    lines.push('_Everything passed — nothing to report._', '');
    return lines;
  }

  for (const file of failedFiles) {
    const statusWord = file.status === 'error' ? 'ERROR' : file.status.toUpperCase();
    lines.push(`### ${file.fileName} — ${statusWord}${file.duration > 0 ? ` (${formatDuration(file.duration)})` : ''}`, '');

    if (file.error) {
      lines.push(`- **File error:** ${escapeMd(file.error)}`, '');
    }

    const failedSections = file.sections.filter(isSectionFailed);
    for (const section of failedSections) {
      const statusPart = section.status != null ? `${section.status} ${section.statusText ?? ''}`.trim() : 'no response';
      const assertPart = section.assertions.total > 0
        ? ` — ${section.assertions.passed}/${section.assertions.total} assertions passed`
        : '';
      lines.push(`- ❌ \`${sectionLabel(section)}\` — ${statusPart}${assertPart}`);

      if (section.error) {
        lines.push(`  - Error: ${escapeMd(section.error)}`);
      }
      for (const assertion of section.assertions.results) {
        if (assertion.passed) continue;
        const desc = assertion.description || (assertion.operator ? `${assertion.operator} ${assertion.expected ?? ''}` : 'Assertion failed');
        lines.push(`  - ${escapeMd(desc)}${assertion.error ? ` (${escapeMd(assertion.error)})` : ''}`);
      }
    }
    lines.push('');
  }

  return lines;
}

function buildAllFilesTable(run: StitchRunState): string[] {
  const lines = ['## All Files', '', '| File | Status | Duration | Assertions |', '|---|---|---|---|'];
  const statusIcon = (status: StitchFileResult['status']) =>
    status === 'passed' ? '✅ Passed'
      : status === 'failed' ? '❌ Failed'
        : status === 'error' ? '⚠️ Error'
          : status === 'skipped' ? '⏭️ Skipped'
            : status;

  for (const file of run.files) {
    const assertions = file.assertions.total > 0 ? `${file.assertions.passed}/${file.assertions.total}` : '—';
    lines.push(`| ${escapeMd(file.fileName)} | ${statusIcon(file.status)} | ${formatDuration(file.duration)} | ${assertions} |`);
  }
  lines.push('');
  return lines;
}

// ─── Entry points ─────────────────────────────────────────────────────────────

/** Build the full Markdown report as a string (also useful for tests / previewing). */
export function generateStitchMarkdownReport(run: StitchRunState): string {
  return [
    ...buildHeader(run),
    ...buildSummaryTables(run),
    ...buildStatusCodeSection(run),
    ...buildFailedEndpointsSection(run),
    ...buildAllFilesTable(run),
  ].join('\n');
}

export function exportStitchToMarkdown(run: StitchRunState): void {
  const markdown = generateStitchMarkdownReport(run);
  const date = new Date().toISOString().slice(0, 10);
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `stitch-report-${date}.md`;
  a.click();
  URL.revokeObjectURL(url);
}
