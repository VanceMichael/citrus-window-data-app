import { num, filterAsOf, groupBy } from './load.mjs';
import { forecast } from './maturity.mjs';
import { boxLocations } from './quality.mjs';
import { orderStatus } from './commitments.mjs';

// 评估一个采摘与转柜方案：
// 进园时窗与降水限制、冷库共用容量、已约交期，未成熟的量保留不确定性区间。
export function evaluatePlan(plan, tablesAll, asOf) {
  const tables = filterAsOf(tablesAll, asOf);
  const orchards = new Map(tables.orchards.map(o => [o.orchard, o]));
  const access = new Map(tables['field-access'].map(f => [`${f.orchard}|${num(f.day)}`, f]));
  const violations = [];
  const warnings = [];
  const harvest = [];

  const planDays = [
    ...(plan.harvest ?? []).map(h => h.day),
    ...(plan.transfers ?? []).map(t => t.day),
  ];
  const horizonEnd = planDays.length ? Math.max(...planDays) : asOf;
  // 未成熟量的品质区间：与 forecast 同一套校准模型
  const outlook = new Map();
  for (const block of forecast(tables, Math.min(...planDays, asOf), horizonEnd)) {
    for (const day of block.days) outlook.set(`${block.orchard}|${day.day}`, day);
  }

  const harvestByPlotDay = groupBy(plan.harvest ?? [], h => `${h.orchard}|${h.day}`);
  for (const [key, items] of harvestByPlotDay) {
    const [orchardId, dayText] = key.split('|');
    const day = Number(dayText);
    const kg = items.reduce((s, i) => s + i.kg, 0);
    const orchard = orchards.get(orchardId);
    if (!orchard) {
      violations.push(`地块 ${orchardId} 无登记`);
      continue;
    }
    const acc = access.get(key);
    if (!acc) {
      violations.push(`${orchardId} 第${day}天无进园时窗记录，无法确认可进园`);
    } else if (acc.from === '' || acc.to === '') {
      violations.push(`${orchardId} 第${day}天停入（${acc.weather === 'wet' ? '雨湿' : '干燥'}），不能安排采摘`);
    }
    const capacity = acc ? num(acc.weather === 'wet' ? orchard.wet_kg : orchard.dry_kg) : null;
    if (capacity != null && kg > capacity) {
      violations.push(
        `${orchardId} 第${day}天计划 ${kg}kg 超出${acc.weather === 'wet' ? '雨湿' : '干燥'}可采量 ${capacity}kg`,
      );
    }
    const outlookDay = outlook.get(key);
    if (!outlookDay?.grades) warnings.push(`${orchardId} 有效抽样不足，第${day}天成熟量无法估计`);
    harvest.push({
      orchard: orchardId,
      day,
      kg,
      weather: acc?.weather ?? null,
      window: acc ? { from: acc.from, to: acc.to } : null,
      expected: outlookDay?.grades
        ? Object.fromEntries(
            Object.entries(outlookDay.grades).map(([grade, p]) => [
              grade,
              { lo: kg * p.lo, mid: kg * p.mid, hi: kg * p.hi },
            ]),
          )
        : null,
      uncertain: true,
    });
  }

  // 库容：先算现有箱实际占用（只认 complete），再叠加方案转柜
  const occupancy = new Map();
  const addOcc = (store, day, kg) => {
    const key = `${store}|${day}`;
    occupancy.set(key, (occupancy.get(key) ?? 0) + kg);
  };
  const locations = boxLocations(tables);
  const boxKg = new Map(
    [...groupBy(tables.boxes, 'box')].map(([box, rows]) => [box, rows.reduce((s, r) => s + num(r.kg), 0)]),
  );
  for (const [box, loc] of locations) {
    const kg = boxKg.get(box) ?? 0;
    for (const iv of loc.intervals) {
      const end = Math.min(iv.toDay ?? horizonEnd, horizonEnd);
      for (let day = iv.fromDay; day <= end; day += 1) addOcc(iv.store, day, kg);
    }
  }
  for (const t of plan.transfers ?? []) {
    for (let day = t.day; day <= horizonEnd; day += 1) {
      if (t.to) addOcc(t.to, day, t.kg);
      if (t.from) addOcc(t.from, day, -t.kg);
    }
  }
  const cooling = new Map(tables.cooling.map(c => [`${c.store}|${num(c.day)}`, c]));
  const storage = [];
  const planStart = planDays.length ? Math.min(...planDays) : asOf;
  for (const [key, kg] of [...occupancy.entries()].sort()) {
    if (kg <= 0) continue;
    const [store, dayText] = key.split('|');
    const day = Number(dayText);
    if (day < planStart || day > horizonEnd) continue;
    const record = cooling.get(key);
    if (!record) {
      warnings.push(`${store} 第${day}天无冷库容量记录，${kg}kg 占用无法核对上限`);
      storage.push({ store, day, kg, maxKg: null });
    } else {
      const maxKg = num(record.max_kg);
      if (kg > maxKg) violations.push(`${store} 第${day}天占用 ${kg}kg 超出库容 ${maxKg}kg`);
      storage.push({ store, day, kg, maxKg });
    }
  }

  // 已约交期：方案新增的合格量能补多少缺口（预测量带不确定性，不计入确定量）
  const orders = orderStatus(tablesAll, asOf).filter(o => o.shortfallKg > 0);
  const orderFit = orders.map(order => {
    const relevant = harvest.filter(
      h =>
        h.day >= order.window.earliest &&
        h.day <= order.window.latest &&
        (!order.brand || orchards.get(h.orchard).brand_allowed === 'true'),
    );
    const sum = key => relevant.reduce((s, h) => s + (h.expected?.[order.grade]?.[key] ?? 0), 0);
    return {
      order: order.order,
      shortfallKg: order.shortfallKg,
      expectedFromPlan: { lo: sum('lo'), mid: sum('mid'), hi: sum('hi'), uncertain: true },
    };
  });

  return {
    name: plan.name ?? '未命名方案',
    feasible: violations.length === 0,
    violations,
    warnings,
    harvest,
    storage,
    orderFit,
  };
}

export function comparePlans(plans, tablesAll, asOf) {
  const evaluated = plans.map(plan => evaluatePlan(plan, tablesAll, asOf));
  const ranked = [...evaluated].sort((a, b) => {
    if (a.feasible !== b.feasible) return a.feasible ? -1 : 1;
    const mid = e => e.orderFit.reduce((s, o) => s + o.expectedFromPlan.mid, 0);
    return mid(b) - mid(a);
  });
  return { evaluated, recommendation: ranked[0]?.name ?? null };
}
