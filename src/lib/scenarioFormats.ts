/**
 * Scenario data source parsers for Stitch Runner.
 * Supports CSV, JSON (flat + structured), and YAML.
 */

export interface ScenarioRow {
  name: string;
  variables: Record<string, string>;
  enabled?: boolean;
}

/** Minimal RFC-4180 CSV row splitter (handles quoted fields with embedded commas/newlines). */
function splitCsvRow(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { field += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { fields.push(field); field = ''; }
      else { field += ch; }
    }
  }
  fields.push(field);
  return fields;
}

export function parseCsvToScenarios(text: string): ScenarioRow[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const nonEmpty = lines.filter(l => l.trim() !== '');
  if (nonEmpty.length < 2) return [];

  const headers = splitCsvRow(nonEmpty[0]).map(h => h.trim());
  const nameCol = headers.findIndex(h => h.toLowerCase() === 'name' || h === '__name__');

  return nonEmpty.slice(1).map((line, idx) => {
    const values = splitCsvRow(line);
    const variables: Record<string, string> = {};
    let rowName = `Scenario ${idx + 1}`;

    headers.forEach((key, i) => {
      const val = (values[i] ?? '').trim();
      if (i === nameCol) { rowName = val || rowName; }
      else { variables[key] = val; }
    });

    return { name: rowName, variables };
  });
}

function fromObject(item: Record<string, any>, idx: number): ScenarioRow {
  const name = String(item.name ?? item.__name__ ?? `Scenario ${idx + 1}`);
  const enabled = item.enabled !== false;
  let variables: Record<string, string>;

  if (item.variables && typeof item.variables === 'object' && !Array.isArray(item.variables)) {
    // Structured: { name, variables: { key: val } }
    variables = Object.fromEntries(
      Object.entries(item.variables).map(([k, v]) => [k, String(v)])
    );
  } else {
    // Flat: { name, key1: val1, key2: val2 }
    variables = Object.fromEntries(
      Object.entries(item)
        .filter(([k]) => k !== 'name' && k !== '__name__' && k !== 'enabled')
        .map(([k, v]) => [k, String(v)])
    );
  }

  return { name, variables, enabled };
}

export function parseJsonToScenarios(text: string): ScenarioRow[] {
  const data = JSON.parse(text);
  if (!Array.isArray(data)) return [];
  return data.map((item, idx) => fromObject(item, idx));
}

export function parseYamlToScenarios(text: string): ScenarioRow[] {
  // yaml shim comes from window.__voiden_shims__['yaml']
  // @ts-ignore - shimmed at runtime
  const { parse } = (window as any).__voiden_shims__?.['yaml'] ?? {};
  if (!parse) throw new Error('yaml shim not available');
  const data = parse(text);
  if (!Array.isArray(data)) return [];
  return data.map((item: any, idx: number) => fromObject(item, idx));
}

export function detectFormat(filename: string): 'csv' | 'json' | 'yaml' {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'json') return 'json';
  if (ext === 'yaml' || ext === 'yml') return 'yaml';
  return 'csv';
}

export function parseScenarioFile(text: string, format: 'csv' | 'json' | 'yaml'): ScenarioRow[] {
  if (format === 'json') return parseJsonToScenarios(text);
  if (format === 'yaml') return parseYamlToScenarios(text);
  return parseCsvToScenarios(text);
}
