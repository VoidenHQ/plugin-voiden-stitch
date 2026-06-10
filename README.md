> A plugin for [Voiden](https://github.com/VoidenHQ) — the developer-first API client.

# Voiden Stitch

Batch-run multiple `.void` files as a stitch with aggregated assertion results, variable isolation, and sequential execution.

## Features

- Batch run multiple `.void` files sequentially
- Glob pattern matching for file inclusion / exclusion
- Shared or isolated variable scope per file
- Aggregated assertion results in a dedicated sidebar tab
- Per-file pass/fail with assertion counts and timing
- Stop-on-failure option
- Configurable delay between files
- Abort/cancel support
- Export results to a styled Excel report with per-file sheets and assertion breakdowns

## Usage

Use the `/stitch` slash command to insert a Stitch Runner block. Add glob patterns to select which `.void` files to run, configure options, then hit **Run**.
