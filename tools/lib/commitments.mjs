import { num, filterAsOf, groupBy } from './load.mjs';
import { gradeTermsMap, forecast } from './maturity.mjs';
import { coverage } from './samples.mjs';
import {
  boxComposition,
  packChecksByBox,
  gradeOfBox,
  brandEligibility,
  storeDayStatus,
  boxLocations,
  boxTempExposure,
} from './quality.mjs';

const GRADE_RANK = { 等外: 0, B: 1, A: 2 };

// 汇总一次评估所需的全部上下文；tables 按 asOf 过滤，tablesAll 保留全量用于更正回滚
export function buildContext(tablesAll, asOf) {
  const tables = filterAsOf(tablesAll, asOf);
  return {
    tablesAll,
    tables,
    asOf,
    terms: gradeTermsMap(tables['grade-terms']),
    orchards: new Map(tables.orchards.map(o => [o.orchard, o])),
    checks: packChecksByBox(tables),
    storeStatus: storeDayStatus(tables),
    locations: boxLocations(tables),
    boxRows: new Map(tables.boxes.map(b => [b.box, b])),
    boxKg: new Map(
      [...groupBy(tables.boxes, 'box')].map(([box, rows]) => [box, rows.reduce((s, r) => s + num(r.kg), 0)]),
    ),
  };
}

// 评估某箱对某订单是否可交：
// 硬条件（品级、品牌、储存窗口）不满足判“不可直交”；
// 来源更正、过温确证、复验未完成等判“待重新确认”，重新确认前不计入可交。
export function evaluateBoxForOrder(order, boxId, ctx) {
  const boxRow = ctx.boxRows.get(boxId);
  if (!boxRow) return { box: boxId, status: '不可直交', reasons: ['箱登记在此时未知'] };
  const reasons = [];
  const composition = boxComposition(boxId, ctx.tablesAll, ctx.asOf);
  const grade = gradeOfBox(boxRow, composition, ctx.checks.get(boxId), ctx.terms);

  let hardFail = false;
  let softHold = false;
  if (grade.effective === 'pending') {
    softHold = true;
    reasons.push('分选复验未完成，品级待定');
  } else if ((GRADE_RANK[grade.effective] ?? 0) < GRADE_RANK[order.grade]) {
    hardFail = true;
    reasons.push(`复验品级 ${grade.effective} 低于订单要求 ${order.grade}`);
  }
  if (!hardFail && !grade.fullyVerified) {
    softHold = true;
    reasons.push('部分来源未经包装复验');
  }

  if (order.brand === 'true') {
    const brand = brandEligibility(composition, ctx.orchards);
    if (!brand.ok) {
      hardFail = true;
      reasons.push(...brand.reasons);
    }
  }

  const packed = num(boxRow.packed_day);
  const earliest = Math.max(num(order.earliest), packed);
  const latest = Math.min(num(order.latest), packed + num(order.max_store_days));
  const deliveryWindow = earliest <= latest ? { earliest, latest } : null;
  if (!deliveryWindow) {
    hardFail = true;
    reasons.push(
      `储存时长不满足：第${packed}天装箱，订单窗口 ${order.earliest}-${order.latest} 天，最长储存 ${order.max_store_days} 天`,
    );
  }

  const exposure = boxTempExposure(boxId, ctx.locations, ctx.storeStatus, ctx.asOf);
  if (exposure.confirmed.length > 0) {
    softHold = true;
    reasons.push(
      `库温超限确证：${exposure.confirmed.map(c => `${c.store} 第${c.day}天`).join('、')}`,
    );
  }

  const corrections = ctx.tables['source-notices'].filter(n => n.box === boxId);
  if (corrections.length > 0) {
    softHold = true;
    reasons.push(`来源更正已生效：${corrections.map(c => c.notice).join('、')}`);
  }

  const status = hardFail ? '不可直交' : softHold ? '待重新确认' : '可交';
  return { box: boxId, status, reasons, grade: grade.effective, composition, deliveryWindow, tempGaps: exposure.gaps };
}

// 订单履约状态：已承诺的量是否仍做得到
export function orderStatus(tablesAll, asOf) {
  const ctx = buildContext(tablesAll, asOf);
  const holdsByOrder = groupBy(ctx.tables.holds, 'order');
  return ctx.tables.orders.map(order => {
    const holds = (holdsByOrder.get(order.order) ?? []).map(h => ({
      box: h.box,
      kg: num(h.kg),
      state: h.state,
      eval: evaluateBoxForOrder(order, h.box, ctx),
    }));
    const sumWhere = pred => holds.filter(pred).reduce((s, h) => s + h.kg, 0);
    const deliverable = sumWhere(h => h.eval.status === '可交');
    const pending = sumWhere(h => h.eval.status === '待重新确认');
    const failed = sumWhere(h => h.eval.status === '不可直交');
    const required = num(order.kg);
    const affected = holds
      .filter(h => h.eval.status !== '可交')
      .map(h => ({ box: h.box, kg: h.kg, state: h.state, status: h.eval.status, reasons: h.eval.reasons }));
    return {
      order: order.order,
      client: order.client,
      grade: order.grade,
      brand: order.brand === 'true',
      window: { earliest: num(order.earliest), latest: num(order.latest) },
      maxStoreDays: num(order.max_store_days),
      backup: order.backup,
      requiredKg: required,
      deliverableKg: deliverable,
      pendingKg: pending,
      failedKg: failed,
      shortfallKg: Math.max(0, required - deliverable),
      verdict: deliverable >= required ? '做得到' : deliverable > 0 ? '部分可做' : '做不到',
      holds,
      affected,
      replacements: replacementCandidates(order, ctx),
    };
  });
}

// 可补充来源：未被任何订单占用的现存箱 + 未来采收预测（未成熟的量保留不确定性）
function replacementCandidates(order, ctx) {
  const heldBoxes = new Set(ctx.tables.holds.map(h => h.box));
  const boxes = [];
  for (const boxId of ctx.boxRows.keys()) {
    if (heldBoxes.has(boxId)) continue;
    const evaluation = evaluateBoxForOrder(order, boxId, ctx);
    if (evaluation.status !== '不可直交') {
      boxes.push({ box: boxId, kg: ctx.boxKg.get(boxId), status: evaluation.status, reasons: evaluation.reasons });
    }
  }
  const supply = [];
  const horizon = forecast(ctx.tables, num(order.earliest), num(order.latest));
  for (const block of horizon) {
    if (order.brand === 'true' && !block.brandAllowed) continue;
    for (const day of block.days) {
      if (day.day <= ctx.asOf || !day.expectedKg || day.closed) continue;
      const grade = day.expectedKg[order.grade];
      if (grade && grade.hi > 0) {
        supply.push({
          orchard: block.orchard,
          day: day.day,
          weather: day.weather,
          lo: grade.lo,
          mid: grade.mid,
          hi: grade.hi,
          uncertain: true,
        });
      }
    }
  }
  return { boxes, forecastSupply: supply };
}

// 重复预留检查：承诺量（signed/reserved）与申请量（requested）不得让两个经销商以为拿到同一箱
export function findDoubleBooking(tables) {
  const holdsByBox = groupBy(tables.holds, 'box');
  const boxKg = new Map(
    [...groupBy(tables.boxes, 'box')].map(([box, rows]) => [box, rows.reduce((s, r) => s + num(r.kg), 0)]),
  );
  const orderClient = new Map(tables.orders.map(o => [o.order, o.client]));
  const findings = [];
  for (const [box, holds] of holdsByBox) {
    const committed = holds.filter(h => h.state === 'signed' || h.state === 'reserved');
    const requested = holds.filter(h => h.state === 'requested');
    const committedKg = committed.reduce((s, h) => s + num(h.kg), 0);
    const requestedKg = requested.reduce((s, h) => s + num(h.kg), 0);
    const total = boxKg.get(box) ?? 0;
    const clients = [...new Set(committed.map(h => orderClient.get(h.order)))];
    if (committedKg > total) {
      findings.push({
        box,
        severity: '冲突',
        detail: `承诺 ${committedKg}kg 超出箱量 ${total}kg（${committed.map(h => `${h.order}/${h.state}/${h.kg}kg`).join('，')}）`,
      });
    } else if (clients.length > 1) {
      findings.push({
        box,
        severity: '提示',
        detail: `同一箱承诺给多个经销商 ${clients.join('、')}（合计 ${committedKg}kg / 箱量 ${total}kg），需确认分箱归属`,
      });
    }
    if (committedKg + requestedKg > total) {
      findings.push({
        box,
        severity: '冲突',
        detail: `承诺加申请 ${committedKg + requestedKg}kg 超出箱量 ${total}kg`,
      });
    }
  }
  return findings;
}

// 品牌声明逐箱核对：更正或复验只推翻受影响的个别箱，不动其余声明
export function statementStatus(tablesAll, asOf) {
  const ctx = buildContext(tablesAll, asOf);
  return ctx.tables['brand-register'].map(st => {
    const reasons = [];
    const composition = boxComposition(st.box, tablesAll, asOf);
    const laterCorrections = ctx.tables['source-notices'].filter(
      n => n.box === st.box && num(n.known_day) > num(st.issued_day),
    );
    for (const n of laterCorrections) {
      reasons.push(`签发后来源更正 ${n.notice}：${n.recorded_orchard}→${n.actual_orchard} ${n.kg}kg`);
    }
    const brand = brandEligibility(composition, ctx.orchards);
    reasons.push(...brand.reasons);
    const zones = [...new Set(composition.map(c => ctx.orchards.get(c.orchard)?.zone))];
    if (zones.length !== 1 || zones[0] !== st.declared_zone) {
      reasons.push(`声明区域 ${st.declared_zone} 与实际来源区域 ${zones.join('/')} 不一致`);
    }
    const boxRow = ctx.boxRows.get(st.box);
    const order = ctx.tables.orders.find(o => o.order === st.order);
    if (boxRow && order) {
      const grade = gradeOfBox(boxRow, composition, ctx.checks.get(st.box), ctx.terms);
      if (grade.effective !== 'pending' && (GRADE_RANK[grade.effective] ?? 0) < GRADE_RANK[order.grade]) {
        reasons.push(`复验品级 ${grade.effective} 低于订单要求 ${order.grade}`);
      }
    }
    return {
      statement: st.statement,
      order: st.order,
      box: st.box,
      kg: num(st.kg),
      state: st.state,
      issuedDay: num(st.issued_day),
      valid: reasons.length === 0,
      reasons,
    };
  });
}

// 买手视图：只给交付窗口与所拿箱的公开口径，不含内部缺口与覆盖信息
export function buyerView(tablesAll, asOf, orderId) {
  const ctx = buildContext(tablesAll, asOf);
  const order = ctx.tables.orders.find(o => o.order === orderId);
  if (!order) throw new Error(`订单 ${orderId} 不存在`);
  const statements = statementStatus(tablesAll, asOf).filter(s => s.order === orderId);
  const boxes = ctx.tables.holds
    .filter(h => h.order === orderId)
    .map(h => {
      const evaluation = evaluateBoxForOrder(order, h.box, ctx);
      return {
        box: h.box,
        kg: num(h.kg),
        state: h.state,
        deliveryWindow: evaluation.deliveryWindow,
        publicStatus:
          evaluation.status === '可交' ? '可按承诺交付' : evaluation.status === '待重新确认' ? '待重新确认后交付' : '需更换或重新包装',
      };
    });
  return {
    order: order.order,
    client: order.client,
    grade: order.grade,
    brand: order.brand === 'true',
    window: { earliest: num(order.earliest), latest: num(order.latest) },
    requiredKg: num(order.kg),
    statements: statements.map(s => ({
      statement: s.statement,
      box: s.box,
      kg: s.kg,
      state: s.state,
      publicCaliber: s.valid ? '声明有效' : '声明受影响，待重新签发',
    })),
    boxes,
  };
}

// 内部视图：未覆盖样本、冷库断测、重复预留与需要重新分配的保留量
export function internalView(tablesAll, asOf) {
  const ctx = buildContext(tablesAll, asOf);
  const cov = coverage(ctx.tables);
  const tempIssues = [...ctx.storeStatus.values()].filter(s => s.confirmedOverTemp || s.incomplete);
  // 箱在库期间遇到的断测（含完全无记录的库-日）也要能看见
  const boxTempGaps = [];
  for (const boxId of ctx.boxRows.keys()) {
    const exposure = boxTempExposure(boxId, ctx.locations, ctx.storeStatus, asOf);
    for (const gap of exposure.gaps) boxTempGaps.push({ box: boxId, ...gap });
  }
  const orders = orderStatus(tablesAll, asOf);
  const reallocation = [];
  for (const o of orders) {
    for (const h of o.holds) {
      if (h.eval.status === '可交') continue;
      reallocation.push({
        order: o.order,
        box: h.box,
        kg: h.kg,
        state: h.state,
        note:
          h.state === 'signed'
            ? 'signed 不能被重配：需重新确认或与客户协商，缺口另找来源'
            : '批准释放后才可重新分配',
        reasons: h.eval.reasons,
      });
    }
  }
  return {
    asOf,
    uncoveredOrchards: cov.uncovered,
    invalidSamples: Object.entries(cov.perOrchard).flatMap(([orchard, c]) =>
      c.invalidEvents.map(e => ({ orchard, tree: e.tree, day: e.day })),
    ),
    tempIssues,
    boxTempGaps,
    doubleBooking: findDoubleBooking(ctx.tables),
    reallocation,
    orders: orders.map(o => ({
      order: o.order,
      verdict: o.verdict,
      deliverableKg: o.deliverableKg,
      pendingKg: o.pendingKg,
      shortfallKg: o.shortfallKg,
    })),
  };
}
