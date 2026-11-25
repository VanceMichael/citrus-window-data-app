import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, cp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTables, filterAsOf, latestKnownDay } from '../tools/lib/load.mjs';
import { treeDayEvents, coverage } from '../tools/lib/samples.mjs';
import { backtest, forecast, calibrateGradeCurve, gradeFractionBand } from '../tools/lib/maturity.mjs';
import {
  boxComposition,
  packChecksByBox,
  gradeOfBox,
  brandEligibility,
  storeDayStatus,
  boxLocations,
} from '../tools/lib/quality.mjs';
import {
  buildContext,
  evaluateBoxForOrder,
  orderStatus,
  statementStatus,
  findDoubleBooking,
  buyerView,
  internalView,
} from '../tools/lib/commitments.mjs';
import { evaluatePlan, comparePlans } from '../tools/lib/plans.mjs';
import { gradeTermsMap } from '../tools/lib/maturity.mjs';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));
const { tables } = await loadTables(FIXTURES);
const AS_OF = latestKnownDay(tables);

test('同树同日的多条记录合并为一次树级抽样', () => {
  const events = treeDayEvents(tables.samples);
  const merged = events.find(e => e.orchard === 'O1' && e.tree === 'T1' && e.day === 1);
  assert.ok(merged, '应存在 O1/T1/第1天事件');
  assert.equal(merged.rows, 2, 'S1 与 S2 属于同一次抽样');
  assert.ok(Math.abs(merged.brix - 10.5) < 1e-9, '复合果样取加权平均糖度');
  const s7 = events.find(e => e.orchard === 'O4' && e.day === 7);
  assert.equal(s7.brix, null, 'S7 无有效读数');
});

test('覆盖统计可见无效读数，且合并后的事件数少于原始行数', () => {
  const cov = coverage(filterAsOf(tables, AS_OF));
  assert.ok(cov.totalEvents < cov.totalRows, '同树同日合并后独立抽样次数应减少');
  assert.deepEqual(cov.perOrchard.O4.invalidEvents, [{ tree: 'T1', day: 7 }]);
  assert.deepEqual(cov.uncovered, [], '各地块当季均有有效覆盖');
});

test('来源更正按可知日回滚：第6天 B1 全是 O1，第9天拆出 O3', () => {
  const before = boxComposition('B1', tables, 6);
  assert.deepEqual(before, [{ lot: 'L1', orchard: 'O1', kg: 305 }]);
  const after = boxComposition('B1', tables, 9);
  assert.deepEqual(after, [
    { lot: 'L1', orchard: 'O1', kg: 220 },
    { lot: 'L1', orchard: 'O3', kg: 85 },
  ]);
});

test('箱品级按来源分别判定，不靠平均数：B1 因 O3 部分只能定 B', () => {
  const tables9 = filterAsOf(tables, 9);
  const terms = gradeTermsMap(tables9['grade-terms']);
  const checks = packChecksByBox(tables9);
  const ctx = { boxRows: new Map(tables9.boxes.map(b => [b.box, b])) };
  const gradeB1 = gradeOfBox(ctx.boxRows.get('B1'), boxComposition('B1', tables, 9), checks.get('B1'), terms);
  assert.equal(gradeB1.effective, 'B');
  const gradeB3 = gradeOfBox(ctx.boxRows.get('B3'), boxComposition('B3', tables, 9), checks.get('B3'), terms);
  assert.equal(gradeB3.effective, 'A');
  const gradeB4day8 = gradeOfBox(
    ctx.boxRows.get('B4') ?? { grade: 'pending' },
    boxComposition('B4', tables, 8),
    packChecksByBox(filterAsOf(tables, 8)).get('B4'),
    terms,
  );
  assert.equal(gradeB4day8.effective, 'pending', '第8天复验结果还未知');
  const gradeB4day9 = gradeOfBox(
    { grade: 'pending' },
    boxComposition('B4', tables, 9),
    checks.get('B4'),
    terms,
  );
  assert.equal(gradeB4day9.effective, 'B', '第9天复验可知后定为 B');
});

test('品牌资格：任一来源不在允许范围则整箱不可签', () => {
  const orchards = new Map(tables.orchards.map(o => [o.orchard, o]));
  assert.equal(brandEligibility(boxComposition('B1', tables, 9), orchards).ok, false);
  assert.equal(brandEligibility(boxComposition('B1', tables, 6), orchards).ok, true);
  assert.equal(brandEligibility(boxComposition('B3', tables, 9), orchards).ok, true);
});

test('库温：过温确证与记录不完整分别判定，且按可知日推进', () => {
  const day7 = storeDayStatus(filterAsOf(tables, 7));
  const c1d7 = day7.get('C1|7');
  assert.equal(c1d7.confirmedOverTemp, false, '第7天时 18:00 读数还未知');
  assert.equal(c1d7.incomplete, true, '10:00 读数缺失');
  const day8 = storeDayStatus(filterAsOf(tables, 8));
  assert.equal(day8.get('C1|7').confirmedOverTemp, true, '第8天确证 7.2℃ 超限');
});

test('箱位置只认 complete：B1 第7天仍在 C1，第8天起在 C2', () => {
  const locations = boxLocations(filterAsOf(tables, 9));
  const b1 = locations.get('B1');
  assert.equal(b1.planned.length, 1, 'M2 是 planned，不算移出');
  const stores = b1.intervals.map(i => i.store);
  assert.deepEqual(stores, ['C1', 'C2']);
  assert.equal(b1.intervals[0].toDay, 8);
});

test('回测覆盖往期全部成熟窗口，校准窗口命中率可计算', () => {
  const result = backtest(filterAsOf(tables, AS_OF));
  assert.equal(result.summary.count, 16);
  assert.equal(result.summary.calibratedCount, 12);
  for (const rate of [result.summary.hitRateA, result.summary.calibratedHitRateA]) {
    assert.ok(rate >= 0 && rate <= 1);
  }
  assert.ok(result.summary.calibratedHitRateA >= 0.5, '校准窗口命中率应在合理水平');
  const first = result.results.find(r => r.inspection === 'V10');
  assert.equal(first.calibrated, false, '首个窗口无校准依据');
});

test('预测给出各地块达标范围，未成熟量保留区间而非单点', () => {
  const blocks = forecast(filterAsOf(tables, AS_OF), 9, 9);
  const o1 = blocks.find(b => b.orchard === 'O1').days[0];
  assert.ok(o1.brix.lo < o1.brix.mid && o1.brix.mid < o1.brix.hi);
  assert.ok(o1.grades.A.lo < o1.grades.A.hi, 'A档比例是区间');
  assert.equal(o1.grades.A.calibrated, true);
  assert.ok(o1.expectedKg.A.hi <= o1.capacityKg);
  const o3 = blocks.find(b => b.orchard === 'O3');
  assert.equal(o3.brandAllowed, false);
});

test('校准曲线拟合饱和上限', () => {
  const curve = calibrateGradeCurve([
    { mu: 8, fraction: 0.2 },
    { mu: 9, fraction: 0.4 },
    { mu: 10, fraction: 0.5 },
    { mu: 11, fraction: 0.52 },
  ]);
  assert.ok(curve.c <= 1 && curve.c >= 0.52);
  const band = gradeFractionBand(curve, 10, 0.5);
  assert.ok(band.lo <= band.mid && band.mid <= band.hi);
});

test('订单履约：第9天 P1 部分可做，受影响箱与重量可见', () => {
  const orders = orderStatus(tables, 9);
  const p1 = orders.find(o => o.order === 'P1');
  assert.equal(p1.verdict, '部分可做');
  assert.equal(p1.deliverableKg, 160, '已锁的合格箱 B3 仍按承诺交付');
  assert.equal(p1.affected.length, 1);
  assert.equal(p1.affected[0].box, 'B1');
  assert.equal(p1.affected[0].kg, 220);
  const p2 = orders.find(o => o.order === 'P2');
  assert.equal(p2.deliverableKg, 0);
  const p3 = orders.find(o => o.order === 'P3');
  const b4 = p3.replacements.boxes.find(b => b.box === 'B4');
  assert.equal(b4.status, '可交');
  const b2 = p3.replacements.boxes.find(b => b.box === 'B2');
  assert.equal(b2.status, '待重新确认', '过温确证的箱不计入可交');
});

test('订单履约随可知日变化：第6天 B1 对 P1 仍可交', () => {
  const orders = orderStatus(tables, 6);
  const p1 = orders.find(o => o.order === 'P1');
  const b1 = p1.holds.find(h => h.box === 'B1');
  assert.equal(b1.eval.status, '可交');
  assert.equal(p1.holds.length, 1, 'B3 的预留第7天才知');
});

test('品牌声明逐箱核对：更正只推翻受影响的个别箱', () => {
  const statements = statementStatus(tables, 9);
  const z1 = statements.find(s => s.statement === 'Z1');
  const z2 = statements.find(s => s.statement === 'Z2');
  assert.equal(z1.valid, false);
  assert.ok(z1.reasons.some(r => r.includes('A1')));
  assert.equal(z2.valid, true, '同一订单的其余声明不受影响');
  const day6 = statementStatus(tables, 6);
  assert.equal(day6.find(s => s.statement === 'Z1').valid, true, '更正可知前声明有效');
});

test('重复预留：承诺量或承诺加申请超出箱量即报冲突', () => {
  assert.equal(findDoubleBooking(filterAsOf(tables, AS_OF)).filter(f => f.severity === '冲突').length, 0);
  const synthetic = {
    boxes: [
      { box: 'X1', kg: '100' },
      { box: 'X2', kg: '100' },
    ],
    holds: [
      { order: 'P1', box: 'X1', kg: '80', state: 'signed' },
      { order: 'P2', box: 'X1', kg: '50', state: 'reserved' },
      { order: 'P1', box: 'X2', kg: '60', state: 'signed' },
      { order: 'P2', box: 'X2', kg: '50', state: 'requested' },
    ],
    orders: [
      { order: 'P1', client: 'M1' },
      { order: 'P2', client: 'M2' },
    ],
  };
  const findings = findDoubleBooking(synthetic);
  assert.ok(findings.some(f => f.box === 'X1' && f.severity === '冲突'), '承诺 130kg 超出 100kg');
  assert.ok(findings.some(f => f.box === 'X2' && f.severity === '冲突'), '承诺加申请 110kg 超出 100kg');
});

test('买手视图只有公开口径，内部视图才见缺口与断测', () => {
  const buyer = buyerView(tables, 9, 'P1');
  assert.ok(buyer.statements.length > 0);
  assert.ok(buyer.boxes.length > 0);
  assert.equal('uncoveredOrchards' in buyer, false);
  assert.equal('tempIssues' in buyer, false);
  const z1 = buyer.statements.find(s => s.statement === 'Z1');
  assert.equal(z1.publicCaliber, '声明受影响，待重新签发');
  const internal = internalView(tables, 9);
  assert.ok(internal.tempIssues.some(t => t.store === 'C1' && t.day === 7 && t.confirmedOverTemp));
  assert.ok(internal.boxTempGaps.length > 0, '无记录的库-日要看得见');
  assert.ok(internal.reallocation.some(r => r.order === 'P1' && r.state === 'signed' && r.note.includes('不能被重配')));
});

test('方案评估：停入日采摘与超库容转柜都被判违规', () => {
  const closed = evaluatePlan({ name: 't', harvest: [{ orchard: 'O2', day: 7, kg: 100 }], transfers: [] }, tables, 9);
  assert.ok(closed.violations.some(v => v.includes('停入')));
  const overflow = evaluatePlan(
    { name: 't', harvest: [], transfers: [{ kg: 500, to: 'C1', day: 6 }] },
    tables,
    9,
  );
  assert.ok(overflow.violations.some(v => v.includes('超出库容')));
  const overCapacity = evaluatePlan(
    { name: 't', harvest: [{ orchard: 'O2', day: 8, kg: 1000 }], transfers: [] },
    tables,
    9,
  );
  assert.ok(overCapacity.violations.some(v => v.includes('可采量')));
});

test('方案比较：示例方案甲可行、乙因第8天 C2 超容违规', async () => {
  const spec = JSON.parse(await readFile(path.join(FIXTURES, 'plans.example.json'), 'utf8'));
  const { evaluated, recommendation } = comparePlans(spec.plans, tables, 9);
  const [a, b] = evaluated;
  assert.equal(a.feasible, true);
  assert.equal(b.feasible, false);
  assert.ok(b.violations.some(v => v.includes('C2') && v.includes('超出库容')));
  assert.equal(recommendation, a.name);
  for (const plan of evaluated) {
    for (const h of plan.harvest) {
      assert.equal(h.uncertain, true, '未成熟量必须标注不确定');
      assert.ok(h.expected.A.hi > h.expected.A.lo);
    }
  }
});

test('evaluateBoxForOrder：储存时长超限判不可直交', () => {
  const ctx = buildContext(tables, 9);
  const order = { order: 'PX', grade: 'B', brand: 'false', earliest: '12', latest: '13', max_store_days: '1' };
  const result = evaluateBoxForOrder(order, 'B3', ctx);
  assert.equal(result.status, '不可直交');
  assert.ok(result.reasons.some(r => r.includes('储存时长')));
});

test('add 命令校验字段数与引用（通过临时副本）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'citrus-'));
  await cp(FIXTURES, dir, { recursive: true });
  const { execFile } = await import('node:child_process');
  const run = args =>
    new Promise(resolve => {
      execFile('node', [fileURLToPath(new URL('../tools/citrus.mjs', import.meta.url)), ...args, '--data', dir], (err, stdout, stderr) => {
        resolve({ code: err ? err.code : 0, stdout, stderr });
      });
    });
  const ok = await run(['add', 'samples', 'S8,O1,T3,8,8,11.9,clear,2']);
  assert.equal(ok.code, 0);
  const content = await readFile(path.join(dir, 'samples.csv'), 'utf8');
  assert.ok(content.trimEnd().endsWith('S8,O1,T3,8,8,11.9,clear,2'));
  const badFields = await run(['add', 'samples', 'S9,O1,T3']);
  assert.notEqual(badFields.code, 0);
  const badLink = await run(['add', 'samples', 'S9,O9,T3,8,8,11.0,clear,1']);
  assert.notEqual(badLink.code, 0);
  assert.ok(badLink.stderr.includes('O9'));
});
