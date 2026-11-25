import { num } from './load.mjs';

// boxes.csv 是当前来源登记；asOf 之后才知的来源更正要倒回当时口径，
// 以便核查声明签发时实际收到的来源证明。
export function boxComposition(boxId, tablesAll, asOf) {
  const rows = tablesAll.boxes
    .filter(r => r.box === boxId && num(r.packed_day) <= asOf)
    .map(r => ({ lot: r.lot, orchard: r.orchard, kg: num(r.kg) }));
  for (const notice of tablesAll['source-notices']) {
    if (notice.box !== boxId || num(notice.known_day) <= asOf) continue;
    const kg = num(notice.kg);
    const actual = rows.find(r => r.lot === notice.lot && r.orchard === notice.actual_orchard);
    if (actual) actual.kg -= kg;
    const recorded = rows.find(r => r.lot === notice.lot && r.orchard === notice.recorded_orchard);
    if (recorded) recorded.kg += kg;
    else rows.push({ lot: notice.lot, orchard: notice.recorded_orchard, kg });
  }
  return rows.filter(r => r.kg > 0);
}

// 包装抽检按 箱×来源果园 汇总；同一来源多次抽检累计计算
export function packChecksByBox(tables) {
  const byBox = new Map();
  for (const c of tables['pack-checks']) {
    if (!byBox.has(c.box)) byBox.set(c.box, new Map());
    const byOrchard = byBox.get(c.box);
    if (!byOrchard.has(c.orchard)) {
      byOrchard.set(c.orchard, { checked: 0, belowA: 0, belowB: 0, items: [] });
    }
    const sum = byOrchard.get(c.orchard);
    sum.checked += num(c.checked_kg);
    sum.belowA += num(c.below_a_kg);
    sum.belowB += num(c.below_b_kg);
    sum.items.push({
      inspection: c.inspection,
      day: num(c.day),
      knownDay: num(c.known_day),
      checked: num(c.checked_kg),
      belowA: num(c.below_a_kg),
      belowB: num(c.below_b_kg),
    });
  }
  return byBox;
}

// 箱的实测品级：每个来源单独对照 grade-terms，不靠多来源平均数出结论
export function gradeOfBox(boxRow, composition, checksByOrchard, terms) {
  const perSource = composition.map(src => {
    const sum = checksByOrchard?.get(src.orchard);
    if (!sum || !sum.checked) return { ...src, verified: false };
    const fracBelowA = sum.belowA / sum.checked;
    const fracBelowB = sum.belowB / sum.checked;
    return {
      ...src,
      verified: true,
      checkedKg: sum.checked,
      fracBelowA,
      fracBelowB,
      passA: fracBelowA <= terms.A.maxFrac,
      passB: fracBelowB <= terms.B.maxFrac,
    };
  });
  const anyVerified = perSource.some(s => s.verified);
  if (!anyVerified) {
    return {
      effective: boxRow.grade === 'pending' ? 'pending' : boxRow.grade,
      fullyVerified: false,
      perSource,
    };
  }
  const verified = perSource.filter(s => s.verified);
  const effective = verified.every(s => s.passA) ? 'A' : verified.every(s => s.passB) ? 'B' : '等外';
  return { effective, fullyVerified: perSource.every(s => s.verified), perSource };
}

// 品牌资格：任一来源不在品牌允许范围，整箱都不能签品牌
export function brandEligibility(composition, orchardsById) {
  const reasons = [];
  for (const src of composition) {
    const orchard = orchardsById.get(src.orchard);
    if (!orchard) {
      reasons.push(`来源 ${src.orchard} 无果园登记`);
    } else if (orchard.brand_allowed !== 'true') {
      reasons.push(`来源 ${src.orchard}（${src.kg}kg）不在品牌允许范围`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

// 冷库逐日状态：过温确证与记录不完整分别判定
export function storeDayStatus(tables) {
  const map = new Map();
  for (const c of tables.cooling) {
    map.set(`${c.store}|${num(c.day)}`, {
      store: c.store,
      day: num(c.day),
      maxKg: num(c.max_kg),
      maxTemp: num(c.max_temp_c),
      observedMax: num(c.observed_max_c),
      readings: [],
    });
  }
  for (const t of tables.temperature) {
    const key = `${t.store}|${num(t.day)}`;
    if (!map.has(key)) {
      map.set(key, { store: t.store, day: num(t.day), maxKg: null, maxTemp: null, observedMax: null, readings: [] });
    }
    map.get(key).readings.push({ at: t.reading_at, celsius: num(t.celsius), knownDay: num(t.known_day) });
  }
  for (const s of map.values()) {
    const valid = s.readings.filter(r => r.celsius != null);
    s.missingReadings = s.readings.length - valid.length;
    s.over = [];
    if (s.maxTemp != null) {
      s.over.push(...valid.filter(r => r.celsius > s.maxTemp).map(r => ({ at: r.at, celsius: r.celsius })));
      if (s.observedMax != null && s.observedMax > s.maxTemp) {
        s.over.push({ at: '当日观测上限', celsius: s.observedMax });
      }
    }
    s.confirmedOverTemp = s.over.length > 0;
    s.incomplete = s.maxTemp == null || s.missingReadings > 0 || (valid.length === 0 && s.observedMax == null);
  }
  return map;
}

// 箱的实际所在库时间线：只认 complete 的转柜记录，planned 尚未移出
export function boxLocations(tables) {
  const locations = new Map();
  const moves = [...tables['cold-movements']].sort(
    (a, b) => num(a.day) - num(b.day) || String(a.time).localeCompare(String(b.time)),
  );
  for (const m of moves) {
    if (!locations.has(m.box)) locations.set(m.box, { intervals: [], planned: [] });
    const loc = locations.get(m.box);
    if (m.state !== 'complete') {
      loc.planned.push({ move: m.move, from: m.from_store, to: m.to_store, day: num(m.day), time: m.time });
      continue;
    }
    const open = loc.intervals.find(i => i.toDay == null);
    if (open) {
      open.toDay = num(m.day);
      open.toTime = m.time;
    }
    if (m.to_store && m.to_store !== '-') {
      loc.intervals.push({ store: m.to_store, fromDay: num(m.day), fromTime: m.time, toDay: null, toTime: null });
    }
  }
  return locations;
}

// 箱在库期间遇到的过温确证与断测，分开列出
export function boxTempExposure(boxId, locations, statusMap, asOf) {
  const loc = locations.get(boxId);
  const confirmed = [];
  const gaps = [];
  if (!loc) return { confirmed, gaps };
  for (const iv of loc.intervals) {
    const end = iv.toDay ?? asOf;
    for (let day = iv.fromDay; day <= end; day += 1) {
      const status = statusMap.get(`${iv.store}|${day}`);
      if (!status) {
        gaps.push({ store: iv.store, day, reason: '无冷库记录' });
      } else if (status.confirmedOverTemp) {
        confirmed.push({ store: iv.store, day, over: status.over });
      } else if (status.incomplete) {
        gaps.push({ store: iv.store, day, reason: '温度记录不完整' });
      }
    }
  }
  return { confirmed, gaps };
}
