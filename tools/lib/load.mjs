import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseTable, checkLinks } from '../check-materials.mjs';

// 各表记录“何时可知”的字段；未列出的表视为始终可知的约定资料
export const KNOWN_AT = {
  samples: 'known_day',
  'pack-checks': 'known_day',
  'source-notices': 'known_day',
  temperature: 'known_day',
  'field-access': 'known_day',
  'harvest-history': 'known_day',
  'cold-movements': 'known_day',
  boxes: 'packed_day',
  holds: 'from_day',
  'brand-register': 'issued_day',
  cooling: 'day',
};

export function num(value) {
  if (value === '' || value === '-' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function loadTables(dir) {
  const format = JSON.parse(await readFile(path.join(dir, 'format.json'), 'utf8'));
  const tables = {};
  for (const [name, fields] of Object.entries(format.tables)) {
    tables[name] = parseTable(await readFile(path.join(dir, `${name}.csv`), 'utf8'), fields, name);
  }
  checkLinks(tables, format.links);
  return { tables, format };
}

export function knownAt(table, row) {
  const field = KNOWN_AT[table];
  return field ? num(row[field]) : null;
}

// 全部资料中最晚的可知日，作为工具默认的“今天”
export function latestKnownDay(tables) {
  let day = 0;
  for (const [name, rows] of Object.entries(tables)) {
    for (const row of rows) {
      const k = knownAt(name, row);
      if (k != null && k > day) day = k;
    }
  }
  return day;
}

// 只保留 asOf 当天及之前可知的记录，保证不偷看未来
export function filterAsOf(tables, asOf) {
  return Object.fromEntries(
    Object.entries(tables).map(([name, rows]) => [
      name,
      rows.filter(row => {
        const k = knownAt(name, row);
        return k == null || k <= asOf;
      }),
    ]),
  );
}

export function groupBy(rows, keyOf) {
  const map = new Map();
  for (const row of rows) {
    const key = typeof keyOf === 'function' ? keyOf(row) : row[keyOf];
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}
