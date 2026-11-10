import { useMemo } from 'react';

/** Parse CSV/TSV text: quoted fields, escaped quotes (""), and newlines inside quotes. */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') (field += '"', i++);
        else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') {
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) (row.push(field), rows.push(row));
  return rows;
}

/** Pick the delimiter that splits the first line into the most columns. */
export function guessDelimiter(text: string): string {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const counts = [',', '\t', ';'].map((d) => [d, first.split(d).length] as const);
  return counts.sort((a, b) => b[1] - a[1])[0][0];
}

const isNumber = (s: string) => /^[-+]?(\d[\d,]*)?\.?\d+(e[-+]?\d+)?%?$/i.test(s.trim());

/** A CSV/TSV table: the first row is the header; long files show their first rows only. */
export function CsvTable({ text, delimiter, maxRows = 500 }: { text: string; delimiter?: string; maxRows?: number }) {
  const rows = useMemo(() => parseCsv(text, delimiter ?? guessDelimiter(text)), [text, delimiter]);
  if (!rows.length) return <p className="muted small">This file is empty.</p>;
  const [head, ...body] = rows;
  const cols = Math.max(...rows.map((r) => r.length));
  const shown = body.slice(0, maxRows);
  const numeric = Array.from({ length: cols }, (_, c) => {
    const cells = shown.map((r) => r[c] ?? '').filter((v) => v.trim() !== '');
    return cells.length > 0 && cells.every(isNumber);
  });
  return (
    <div className="csv">
      <div className="csv-wrap">
        <table>
          <thead>
            <tr>
              {Array.from({ length: cols }, (_, c) => (
                <th key={c} className={numeric[c] ? 'num' : undefined}>
                  {head[c] ?? ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i}>
                {Array.from({ length: cols }, (_, c) => (
                  <td key={c} className={numeric[c] ? 'num' : undefined}>
                    {r[c] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="csv-note muted small">
        {body.length} {body.length === 1 ? 'row' : 'rows'} × {cols} {cols === 1 ? 'column' : 'columns'}
        {body.length > maxRows && ` · showing the first ${maxRows}`}
      </p>
    </div>
  );
}
