import { num } from './load.mjs';

// 同树同日的多条记录属于同一次树级抽样（含复合果样），
// 合并为一个抽样事件，避免一处抽样冒充多处独立覆盖。
export function treeDayEvents(sampleRows) {
  const groups = new Map();
  for (const row of sampleRows) {
    const key = `${row.orchard}|${row.tree}|${row.day}`;
    if (!groups.has(key)) {
      groups.set(key, {
        orchard: row.orchard,
        tree: row.tree,
        day: num(row.day),
        readings: [],
        knownDay: null,
        rows: 0,
      });
    }
    const event = groups.get(key);
    event.rows += 1;
    const brix = num(row.brix);
    const weight = num(row.weight) ?? 1;
    if (brix != null) event.readings.push({ brix, weight });
    const known = num(row.known_day);
    if (known != null) event.knownDay = event.knownDay == null ? known : Math.max(event.knownDay, known);
  }
  return [...groups.values()]
    .map(event => ({
      orchard: event.orchard,
      tree: event.tree,
      day: event.day,
      knownDay: event.knownDay,
      rows: event.rows,
      brix: event.readings.length
        ? event.readings.reduce((sum, r) => sum + r.brix * r.weight, 0) /
          event.readings.reduce((sum, r) => sum + r.weight, 0)
        : null,
      weight: event.readings.reduce((sum, r) => sum + r.weight, 0),
    }))
    .sort((a, b) => a.day - b.day || a.orchard.localeCompare(b.orchard) || a.tree.localeCompare(b.tree));
}

// 当季（day >= seasonStart）抽样覆盖：哪些地块有有效糖度读数、哪些只有无效读数或完全未覆盖
export function coverage(tables, seasonStart = 0) {
  const events = treeDayEvents(tables.samples);
  const current = events.filter(e => e.day >= seasonStart);
  const perOrchard = {};
  for (const orchard of tables.orchards) {
    const own = current.filter(e => e.orchard === orchard.orchard);
    const valid = own.filter(e => e.brix != null);
    perOrchard[orchard.orchard] = {
      zone: orchard.zone,
      accessible: orchard.accessible,
      events: own.length,
      validEvents: valid.length,
      rawRows: tables.samples.filter(r => r.orchard === orchard.orchard && num(r.day) >= seasonStart).length,
      trees: [...new Set(own.map(e => e.tree))].sort(),
      validTrees: [...new Set(valid.map(e => e.tree))].sort(),
      invalidEvents: own.filter(e => e.brix == null).map(e => ({ tree: e.tree, day: e.day })),
      latestValidDay: valid.length ? Math.max(...valid.map(e => e.day)) : null,
    };
  }
  const uncovered = Object.entries(perOrchard)
    .filter(([, c]) => c.validEvents === 0)
    .map(([id]) => id);
  return {
    perOrchard,
    uncovered,
    totalEvents: current.length,
    totalRows: tables.samples.filter(r => num(r.day) >= seasonStart).length,
  };
}
