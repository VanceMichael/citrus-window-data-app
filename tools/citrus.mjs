import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadTables, latestKnownDay, filterAsOf } from './lib/load.mjs';
import { coverage } from './lib/samples.mjs';
import { backtest, forecast } from './lib/maturity.mjs';
import { boxComposition, gradeOfBox, brandEligibility, boxTempExposure } from './lib/quality.mjs';
import {
  orderStatus,
  statementStatus,
  buyerView,
  internalView,
  buildContext,
} from './lib/commitments.mjs';
import { comparePlans } from './lib/plans.mjs';
import { checkLinks } from './check-materials.mjs';

const DEFAULT_DATA = fileURLToPath(new URL('../fixtures/', import.meta.url));

const USAGE = `用法：node tools/citrus.mjs <命令> [参数] [--data 目录] [--as-of 天] [--json]

命令：
  summary                 当日总览：订单结论、覆盖与冷库缺口
  coverage                抽样覆盖与未覆盖地块（同树同日只算一次抽样）
  forecast [--from N --to N]  各地块未来可采收量与达标范围（含回测稳定性）
  orders                  各订单已承诺量是否仍做得到、受影响箱与缺口
  statements              品牌声明逐箱核对（更正/复验只推翻个别箱）
  boxes                   各箱实测品级、来源与库温状态
  plans <方案.json>       比较采摘与转柜方案（时窗/库容/交期/不确定性）
  buyer <订单>            买手视图：交付窗口与所拿箱的公开口径
  internal                内部视图：未覆盖、断测、重复预留与待重配
  add <表> <CSV行>        追加一条新记录（校验字段与引用后写入）
`;

function parseArgs(argv) {
  const args = { data: DEFAULT_DATA, asOf: null, json: false, from: null, to: null, positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--data') args.data = argv[++i];
    else if (a === '--as-of') args.asOf = Number(argv[++i]);
    else if (a === '--from') args.from = Number(argv[++i]);
    else if (a === '--to') args.to = Number(argv[++i]);
    else if (a === '--json') args.json = true;
    else args.positional.push(a);
  }
  return args;
}

const fmt = (n, digits = 0) => (n == null || Number.isNaN(n) ? '-' : Number(n).toFixed(digits));
const fmtKg = n => `${fmt(n)}kg`;
const fmtPct = n => `${fmt(n * 100, 1)}%`;
const fmtBand = (b, unit = 'kg') =>
  b == null ? '-' : `${fmt(b.lo)}~${fmt(b.hi)}${unit}（中值 ${fmt(b.mid)}）`;

function print(data, asJson, render) {
  if (asJson) console.log(JSON.stringify(data, null, 2));
  else console.log(render(data));
}

// ---------- 各命令的数据装配 ----------

function cmdSummary(tablesAll, asOf) {
  const orders = orderStatus(tablesAll, asOf);
  const internal = internalView(tablesAll, asOf);
  return {
    asOf,
    orders: internal.orders,
    uncoveredOrchards: internal.uncoveredOrchards,
    tempIssueCount: internal.tempIssues.length,
    doubleBooking: internal.doubleBooking,
    reallocationCount: internal.reallocation.length,
    statements: statementStatus(tablesAll, asOf).map(s => ({
      statement: s.statement,
      box: s.box,
      valid: s.valid,
    })),
  };
}

function renderSummary(d) {
  const lines = [`第 ${d.asOf} 天总览`, ''];
  lines.push('订单：');
  for (const o of d.orders) {
    lines.push(`  ${o.order}：${o.verdict}（可交 ${fmtKg(o.deliverableKg)}，待确认 ${fmtKg(o.pendingKg)}，缺口 ${fmtKg(o.shortfallKg)}）`);
  }
  lines.push(`未覆盖地块：${d.uncoveredOrchards.length ? d.uncoveredOrchards.join('、') : '无'}`);
  lines.push(`冷库温度问题：${d.tempIssueCount} 项；重复预留：${d.doubleBooking.length} 项；待重新分配：${d.reallocationCount} 项`);
  lines.push('品牌声明：');
  for (const s of d.statements) lines.push(`  ${s.statement}（${s.box}）：${s.valid ? '有效' : '被推翻'}`);
  return lines.join('\n');
}

function cmdCoverage(tablesAll, asOf) {
  const tables = filterAsOf(tablesAll, asOf);
  return { asOf, ...coverage(tables) };
}

function renderCoverage(d) {
  const lines = [`第 ${d.asOf} 天抽样覆盖（当季记录 ${d.totalRows} 行 → 独立树级抽样 ${d.totalEvents} 次）`, ''];
  for (const [orchard, c] of Object.entries(d.perOrchard)) {
    const invalid = c.invalidEvents.length
      ? `；无效读数：${c.invalidEvents.map(e => `${e.tree}第${e.day}天`).join('、')}`
      : '';
    lines.push(
      `  ${orchard}（${c.zone}区/${c.accessible}）：有效抽样 ${c.validEvents} 次，覆盖树 ${c.validTrees.join('、') || '无'}${invalid}`,
    );
  }
  lines.push('');
  lines.push(
    d.uncovered.length
      ? `未覆盖地块：${d.uncovered.join('、')} —— 这些地块当季无有效糖度读数，不能代表整批`
      : '各地块均有有效覆盖',
  );
  return lines.join('\n');
}

function cmdForecast(tablesAll, asOf, from, to) {
  const tables = filterAsOf(tablesAll, asOf);
  return {
    asOf,
    from,
    to,
    blocks: forecast(tables, from, to),
    backtest: backtest(tables),
  };
}

function renderForecast(d) {
  const lines = [`第 ${d.asOf} 天成熟度预测（第 ${d.from}~${d.to} 天，达标比例按往期签收校准）`, ''];
  for (const block of d.blocks) {
    const m = block.model;
    lines.push(
      `${block.orchard}（${block.zone}区，品牌${block.brandAllowed ? '允许' : '不允许'}）` +
        (m ? ` 模型：糖度=${fmt(m.intercept, 2)}+${fmt(m.slope, 2)}×天，±${fmt(m.sd, 2)}，${m.n} 次抽样` : ' 抽样不足，无法建模'),
    );
    for (const day of block.days) {
      const access = day.window
        ? day.closed
          ? '停入'
          : `${day.window.from}-${day.window.to}`
        : '无进园记录';
      const brix = day.brix ? `糖度 ${fmt(day.brix.lo, 1)}~${fmt(day.brix.hi, 1)}` : '糖度未知';
      const grade = g =>
        day.grades
          ? `${g}档 ${fmtPct(day.grades[g].lo)}~${fmtPct(day.grades[g].hi)}${day.grades[g].calibrated ? '' : '（未校准）'}`
          : `${g}档 -`;
      const kg = g => (day.expectedKg ? `≈${fmtBand(day.expectedKg[g])}` : '');
      lines.push(
        `  第${day.day}天 ${day.weather ?? '天气未知'} ${access} 可采上限 ${day.capacityKg == null ? '-' : fmtKg(day.capacityKg)}；` +
          `${brix}；${grade('A')} ${kg('A')}；${grade('B')} ${kg('B')}`,
      );
    }
    lines.push('');
  }
  const s = d.backtest.summary;
  lines.push(
    `回测（往期 ${s.count} 个成熟窗口，其中 ${s.calibratedCount} 个有校准依据，跳过 ${s.skipped} 个）：` +
      `A档比例平均误差 ${fmtPct(s.maeA)}；区间命中率 全部 A ${fmtPct(s.hitRateA)} / B ${fmtPct(s.hitRateB)}，` +
      `仅校准窗口 A ${fmtPct(s.calibratedHitRateA)} / B ${fmtPct(s.calibratedHitRateB)}`,
  );
  for (const r of d.backtest.results.filter(r => !r.skipped)) {
    lines.push(
      `  ${r.inspection} ${r.orchard} 第${r.day}天：实际A档 ${fmtPct(r.actualA)}，预测 ${fmtPct(r.predA.lo)}~${fmtPct(r.predA.hi)}${r.calibrated ? '' : '（未校准）'} ${r.hitA ? '命中' : '未命中'}`,
    );
  }
  return lines.join('\n');
}

function cmdOrders(tablesAll, asOf) {
  return { asOf, orders: orderStatus(tablesAll, asOf) };
}

function renderOrders(d) {
  const lines = [`第 ${d.asOf} 天订单履约`, ''];
  for (const o of d.orders) {
    lines.push(
      `${o.order}（客户 ${o.client}）需求 ${fmtKg(o.requiredKg)} ${o.grade}档 品牌${o.brand ? '要' : '不要'} ` +
        `窗口 ${o.window.earliest}-${o.window.latest}天 最长储存 ${o.maxStoreDays}天 备选 ${o.backup}`,
    );
    for (const h of o.holds) {
      const win = h.eval.deliveryWindow
        ? `可交窗口 ${h.eval.deliveryWindow.earliest}-${h.eval.deliveryWindow.latest}天`
        : '无可交窗口';
      lines.push(`  ${h.box} ${fmtKg(h.kg)} [${h.state}] → ${h.eval.status}（${win}）`);
      for (const r of h.eval.reasons) lines.push(`      - ${r}`);
    }
    lines.push(
      `  结论：${o.verdict}。可交 ${fmtKg(o.deliverableKg)} / 需求 ${fmtKg(o.requiredKg)}；` +
        `待重新确认 ${fmtKg(o.pendingKg)}；缺口 ${fmtKg(o.shortfallKg)}`,
    );
    if (o.affected.length) {
      lines.push(`  受影响：${o.affected.map(a => `${a.box} ${fmtKg(a.kg)}（${a.status}）`).join('，')}`);
    }
    if (o.shortfallKg > 0) {
      const boxes = o.replacements.boxes;
      if (boxes.length) {
        lines.push(`  现存可补箱：${boxes.map(b => `${b.box} ${fmtKg(b.kg)}（${b.status}）`).join('，')}`);
      }
      const supply = o.replacements.forecastSupply;
      if (supply.length) {
        lines.push('  未来采收可补（不确定量，需成熟后复测）：');
        for (const s of supply) {
          lines.push(`      ${s.orchard} 第${s.day}天 ${s.weather === 'wet' ? '雨湿' : '干燥'}：${fmt(s.lo)}~${fmt(s.hi)}kg（中值 ${fmt(s.mid)}）`);
        }
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

function cmdStatements(tablesAll, asOf) {
  return { asOf, statements: statementStatus(tablesAll, asOf) };
}

function renderStatements(d) {
  const lines = [`第 ${d.asOf} 天品牌声明逐箱核对`, ''];
  for (const s of d.statements) {
    lines.push(`${s.statement}（订单 ${s.order}，箱 ${s.box}，${fmtKg(s.kg)}，${s.state}，第${s.issuedDay}天签发）：${s.valid ? '有效' : '被推翻'}`);
    for (const r of s.reasons) lines.push(`    - ${r}`);
  }
  return lines.join('\n');
}

function cmdBoxes(tablesAll, asOf) {
  const ctx = buildContext(tablesAll, asOf);
  const boxes = [...ctx.boxRows.keys()].sort().map(boxId => {
    const row = ctx.boxRows.get(boxId);
    const composition = boxComposition(boxId, tablesAll, asOf);
    const grade = gradeOfBox(row, composition, ctx.checks.get(boxId), ctx.terms);
    const brand = brandEligibility(composition, ctx.orchards);
    const exposure = boxTempExposure(boxId, ctx.locations, ctx.storeStatus, asOf);
    return {
      box: boxId,
      registeredGrade: row.grade,
      measuredGrade: grade.effective,
      fullyVerified: grade.fullyVerified,
      perSource: grade.perSource,
      composition,
      brandOk: brand.ok,
      brandReasons: brand.reasons,
      tempConfirmed: exposure.confirmed,
      tempGaps: exposure.gaps,
    };
  });
  return { asOf, boxes };
}

function renderBoxes(d) {
  const lines = [`第 ${d.asOf} 天箱况`, ''];
  for (const b of d.boxes) {
    const src = b.composition.map(c => `${c.orchard} ${fmtKg(c.kg)}`).join(' + ');
    lines.push(`${b.box}：登记 ${b.registeredGrade}，实测 ${b.measuredGrade}；来源 ${src}；品牌${b.brandOk ? '可签' : '不可签'}`);
    for (const s of b.perSource) {
      lines.push(
        s.verified
          ? `    ${s.orchard} ${fmtKg(s.kg)}：抽检 ${fmt(s.checkedKg, 1)}kg，低于A ${fmtPct(s.fracBelowA)}，低于B ${fmtPct(s.fracBelowB)}`
          : `    ${s.orchard} ${fmtKg(s.kg)}：未经包装复验`,
      );
    }
    for (const r of b.brandReasons) lines.push(`    - ${r}`);
    for (const c of b.tempConfirmed) {
      lines.push(`    - 库温超限确证：${c.store} 第${c.day}天（${c.over.map(o => `${o.at} ${o.celsius}℃`).join('、')}）`);
    }
    for (const g of b.tempGaps) lines.push(`    - 库温断测：${g.store} 第${g.day}天（${g.reason}）`);
  }
  return lines.join('\n');
}

async function cmdPlans(tablesAll, asOf, file) {
  const spec = JSON.parse(await readFile(file, 'utf8'));
  const plans = spec.plans ?? spec;
  return { asOf, ...comparePlans(plans, tablesAll, asOf) };
}

function renderPlans(d) {
  const lines = [`第 ${d.asOf} 天方案比较`, ''];
  for (const p of d.evaluated) {
    lines.push(`${p.name}：${p.feasible ? '可执行' : '存在违规'}`);
    for (const v of p.violations) lines.push(`    违规：${v}`);
    for (const w of p.warnings) lines.push(`    注意：${w}`);
    for (const h of p.harvest) {
      const exp = h.expected
        ? `A档 ${fmtBand(h.expected.A)}，B档 ${fmtBand(h.expected.B)}`
        : '成熟量未知';
      lines.push(
        `    采 ${h.orchard} 第${h.day}天 ${fmtKg(h.kg)}（${h.weather === 'wet' ? '雨湿' : h.weather ? '干燥' : '天气未知'}` +
          `${h.window ? ` ${h.window.from}-${h.window.to}` : ''}）；预计合格 ${exp}（未成熟量，不确定）`,
      );
    }
    for (const s of p.storage) {
      lines.push(`    库容 ${s.store} 第${s.day}天：占用 ${fmtKg(s.kg)} / 上限 ${s.maxKg == null ? '无记录' : fmtKg(s.maxKg)}`);
    }
    for (const o of p.orderFit) {
      lines.push(
        `    对 ${o.order} 缺口 ${fmtKg(o.shortfallKg)}：方案预计补 ${fmt(o.expectedFromPlan.lo)}~${fmt(o.expectedFromPlan.hi)}kg（中值 ${fmt(o.expectedFromPlan.mid)}，不确定）`,
      );
    }
    lines.push('');
  }
  lines.push(`建议：${d.recommendation ?? '无'}`);
  return lines.join('\n');
}

function cmdBuyer(tablesAll, asOf, orderId) {
  return { asOf, ...buyerView(tablesAll, asOf, orderId) };
}

function renderBuyer(d) {
  const lines = [
    `买手视图（第 ${d.asOf} 天）订单 ${d.order} / 客户 ${d.client}`,
    `需求 ${fmtKg(d.requiredKg)} ${d.grade}档，交付窗口 第${d.window.earliest}~${d.window.latest}天`,
    '',
    '声明（公开口径）：',
  ];
  for (const s of d.statements) {
    lines.push(`  ${s.statement} 箱 ${s.box} ${fmtKg(s.kg)} [${s.state}]：${s.publicCaliber}`);
  }
  if (!d.statements.length) lines.push('  暂无');
  lines.push('箱与交付窗口：');
  for (const b of d.boxes) {
    const win = b.deliveryWindow ? `第${b.deliveryWindow.earliest}~${b.deliveryWindow.latest}天` : '待定';
    lines.push(`  ${b.box} ${fmtKg(b.kg)} [${b.state}]：${b.publicStatus}，交付窗口 ${win}`);
  }
  if (!d.boxes.length) lines.push('  暂无预留或签约箱');
  return lines.join('\n');
}

function cmdInternal(tablesAll, asOf) {
  return internalView(tablesAll, asOf);
}

function renderInternal(d) {
  const lines = [`内部视图（第 ${d.asOf} 天）`, ''];
  lines.push(`未覆盖地块：${d.uncoveredOrchards.length ? d.uncoveredOrchards.join('、') : '无'}`);
  if (d.invalidSamples.length) {
    lines.push(`无效样本：${d.invalidSamples.map(s => `${s.orchard}/${s.tree}/第${s.day}天`).join('，')}`);
  }
  lines.push('冷库温度：');
  for (const t of d.tempIssues) {
    const parts = [];
    if (t.confirmedOverTemp) parts.push(`过温确证 ${t.over.map(o => `${o.at} ${o.celsius}℃`).join('、')}（上限 ${t.maxTemp}℃）`);
    if (t.incomplete) parts.push('记录不完整');
    lines.push(`  ${t.store} 第${t.day}天：${parts.join('；')}`);
  }
  if (d.boxTempGaps.length) {
    lines.push('箱在库断测：');
    for (const g of d.boxTempGaps) lines.push(`  ${g.box}：${g.store} 第${g.day}天（${g.reason}）`);
  }
  lines.push('重复预留：');
  for (const b of d.doubleBooking) lines.push(`  [${b.severity}] ${b.box}：${b.detail}`);
  if (!d.doubleBooking.length) lines.push('  无');
  lines.push('待重新分配：');
  for (const r of d.reallocation) {
    lines.push(`  ${r.order} 的 ${r.box} ${fmtKg(r.kg)} [${r.state}]：${r.note}`);
    for (const reason of r.reasons) lines.push(`      - ${reason}`);
  }
  if (!d.reallocation.length) lines.push('  无');
  lines.push('订单结论：');
  for (const o of d.orders) {
    lines.push(`  ${o.order}：${o.verdict}（可交 ${fmtKg(o.deliverableKg)}，待确认 ${fmtKg(o.pendingKg)}，缺口 ${fmtKg(o.shortfallKg)}）`);
  }
  return lines.join('\n');
}

// 追加一条新记录：先按格式与引用校验，再写入对应 CSV
async function cmdAdd(dir, table, rowText) {
  const { tables, format } = await loadTables(dir);
  const fields = format.tables[table];
  if (!fields) throw new Error(`未知表 ${table}，可选：${Object.keys(format.tables).join('、')}`);
  const cells = rowText.split(',');
  if (cells.length !== fields.length || rowText.includes('"')) {
    throw new Error(`${table} 需要 ${fields.length} 个字段（${fields.join(',')}），实际 ${cells.length} 个`);
  }
  const row = Object.fromEntries(fields.map((f, i) => [f, cells[i]]));
  const candidate = { ...tables, [table]: [...tables[table], row] };
  checkLinks(candidate, format.links);
  await writeFile(path.join(dir, `${table}.csv`), `${rowText}\n`, { flag: 'a' });
  return { table, row };
}

// ---------- 入口 ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command, ...rest] = args.positional;
  if (!command || command === 'help') {
    console.log(USAGE);
    return;
  }
  const { tables } = await loadTables(args.data);
  const asOf = args.asOf ?? latestKnownDay(tables);
  const json = args.json;
  switch (command) {
    case 'summary':
      print(cmdSummary(tables, asOf), json, renderSummary);
      break;
    case 'coverage':
      print(cmdCoverage(tables, asOf), json, renderCoverage);
      break;
    case 'forecast':
      print(cmdForecast(tables, asOf, args.from ?? asOf + 1, args.to ?? asOf + 7), json, renderForecast);
      break;
    case 'orders':
      print(cmdOrders(tables, asOf), json, renderOrders);
      break;
    case 'statements':
      print(cmdStatements(tables, asOf), json, renderStatements);
      break;
    case 'boxes':
      print(cmdBoxes(tables, asOf), json, renderBoxes);
      break;
    case 'plans':
      if (!rest[0]) throw new Error('plans 需要方案 JSON 文件路径');
      print(await cmdPlans(tables, asOf, rest[0]), json, renderPlans);
      break;
    case 'buyer':
      if (!rest[0]) throw new Error('buyer 需要订单号');
      print(cmdBuyer(tables, asOf, rest[0]), json, renderBuyer);
      break;
    case 'internal':
      print(cmdInternal(tables, asOf), json, renderInternal);
      break;
    case 'add': {
      if (!rest[0] || !rest[1]) throw new Error('add 需要表名与一行 CSV');
      const added = await cmdAdd(args.data, rest[0], rest[1]);
      console.log(`已追加到 ${added.table}：${JSON.stringify(added.row)}`);
      break;
    }
    default:
      console.error(`未知命令 ${command}\n\n${USAGE}`);
      process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(`错误：${err.message}`);
  process.exitCode = 1;
});
