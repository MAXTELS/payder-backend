/**
 * Minimal dependency-free CSV serializer — used for biller payment-history
 * export and the daily receipt report. No external CSV library is in
 * package.json, and the data here is small/simple enough (flat objects, no
 * nested structures) that hand-rolled quoting is the lowest-risk choice.
 * Column order is the union of every row's keys, in first-seen order, so a
 * filtered/grouped export doesn't show empty columns for fields other
 * billers use but this one doesn't.
 */
export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';

  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }

  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (/[",\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => escape(row[c])).join(','));
  }
  return lines.join('\n');
}
