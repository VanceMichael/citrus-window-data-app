import { num } from './load.mjs';
import { treeDayEvents } from './samples.mjs';

// Abramowitz & Stegun 7.1.26 误差函数近似
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.5 * ax);
  const poly =
    1.00002368 +
    t *
      (0.37409196 +
        t *
          (0.09678418 +
            t *
              (-0.18628806 +
                t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))));
  const tau = t * Math.exp(-ax * ax - 1.26551223 + t * poly);
  return sign * (1 - tau);
}

export function normalCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

// 正态分位数（对单调的 normalCdf 做二分反解，足够稳定）
export function normalQuantile(p) {
  let lo = -10;
  let hi = 10;
  for (let i = 0; i < 80; i += 1) {
    const mid = (lo + hi) / 2;
    if (normalCdf(mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function gradeTermsMap(gradeTermRows) {
  return Object.fromEntries(
    gradeTermRows.map(r => [r.grade, { minBrix: num(r.min_brix), maxFrac: num(r.max_unqualified_fraction) }]),
  );
}

// 按树级抽样事件做加权线性拟合 brix = a + b·day，权重为抽样扩展权重
export function fitMaturity(events) {
  const pts = events.filter(e => e.brix != null && e.weight > 0);
  if (pts.length < 3 || new Set(pts.map(e => e.day)).size < 2) return null;
  const W = pts.reduce((s, e) => s + e.weight, 0);
  const mx = pts.reduce((s, e) => s + e.weight * e.day, 0) / W;
  const my = pts.reduce((s, e) => s + e.weight * e.brix, 0) / W;
  let sxx = 0;
  let sxy = 0;
  for (const e of pts) {
    sxx += e.weight * (e.day - mx) ** 2;
    sxy += e.weight * (e.day - mx) * (e.brix - my);
  }
  if (sxx === 0) return null;
  const b = sxy / sxx;
  const a = my - b * mx;
  const w2 = pts.reduce((s, e) => s + e.weight ** 2, 0);
  const nEff = (W * W) / w2;
  const rss = pts.reduce((s, e) => s + e.weight * (e.brix - a - b * e.day) ** 2, 0);
  const s = nEff > 2 ? Math.sqrt((rss / W) * (nEff / (nEff - 2))) : Math.sqrt(rss / W);
  return { a, b, s: s > 0 ? s : 0.01, n: pts.length };
}

// 田间抽样集中在靠路的树，直接拿糖度阈值推断整批分档会失真。
// 用往期签收记录校准「抽样糖度均值 → 实际分档比例」的关系：
// fraction = c·Φ(a + b·μ)，c 为饱和上限（网格搜索），a/b 在 probit 尺度拟合。
export function calibrateGradeCurve(points) {
  const usable = points.filter(p => p.fraction != null && p.mu != null);
  if (usable.length < 2 || new Set(usable.map(p => p.mu)).size < 2) return null;
  const fMax = Math.max(...usable.map(p => p.fraction));
  let best = null;
  const startK = Math.max(5, Math.ceil(fMax * 100));
  for (let k = startK; k <= 100; k += 1) {
    const c = k / 100;
    const fit = fitProbitLine(usable, c);
    if (fit && (!best || fit.rss < best.rss)) best = { c, ...fit };
  }
  return best;
}

function fitProbitLine(points, c) {
  const xs = points.map(p => p.mu);
  const ys = points.map(p => normalQuantile(Math.min(0.98, Math.max(0.02, p.fraction / c))));
  const mx = xs.reduce((s, x) => s + x, 0) / xs.length;
  const my = ys.reduce((s, y) => s + y, 0) / ys.length;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (sxx === 0) return null;
  const b = sxy / sxx;
  const a = my - b * mx;
  const rss = points.reduce((s, _, i) => s + (ys[i] - a - b * xs[i]) ** 2, 0);
  // 残差下限 0.25（probit 尺度）：签收分级本身有噪声，
  // 校准点少或共线时不能假装关系被完全确定
  const residualSd = Math.max(Math.sqrt(rss / Math.max(points.length - 2, 1)), 0.25);
  return { a, b, rss, residualSd, n: points.length, mx, sxx };
}

// 校准曲线的分档比例区间：μ 的不确定性 + 校准残差（含少样本/外推的杠杆放大）
export function gradeFractionBand(curve, mu, muSd) {
  const z = curve.a + curve.b * mu;
  const leverage = Math.sqrt(1 + 1 / curve.n + (mu - curve.mx) ** 2 / curve.sxx);
  const dz = Math.abs(curve.b) * muSd + curve.residualSd * leverage;
  return {
    lo: curve.c * normalCdf(z - dz),
    mid: curve.c * normalCdf(z),
    hi: curve.c * normalCdf(z + dz),
  };
}

// 无校准依据时的回退：按 grade-terms 糖度阈值直接推断（标注 uncalibrated）
export function thresholdBand(mu, muSd, minBrix) {
  const z = (mu - minBrix) / muSd;
  return { lo: normalCdf(z - 1), mid: normalCdf(z), hi: normalCdf(z + 1) };
}

// 汇总往期签收记录为校准点：μ 取各地块成熟度模型在该签收日的估计
function calibrationPoints(historyRows, modelsByOrchard, knownBefore) {
  const points = { A: [], B: [] };
  for (const h of historyRows) {
    if (num(h.known_day) > knownBefore) continue;
    const model = modelsByOrchard.get(h.orchard);
    if (!model) continue;
    const mu = model.a + model.b * num(h.day);
    const harvestKg = num(h.harvest_kg);
    points.A.push({ mu, fraction: num(h.grade_a_kg) / harvestKg });
    points.B.push({ mu, fraction: (num(h.grade_a_kg) + num(h.grade_b_kg)) / harvestKg });
  }
  return points;
}

function fitModelsByOrchard(tables, events) {
  const models = new Map();
  for (const orchard of tables.orchards) {
    models.set(orchard.orchard, fitMaturity(events.filter(e => e.orchard === orchard.orchard)));
  }
  return models;
}

function gradeBands(curves, terms, mu, muSd) {
  const bands = {};
  for (const grade of Object.keys(terms)) {
    bands[grade] = curves[grade]
      ? { ...gradeFractionBand(curves[grade], mu, muSd), calibrated: true }
      : { ...thresholdBand(mu, muSd, terms[grade].minBrix), calibrated: false };
  }
  return bands;
}

// 每块地未来 [fromDay, toDay] 的可采收数量与品质达标范围。
// 降水/进园信息取自 field-access（已按 asOf 过滤），无记录的日照实标注。
export function forecast(tables, fromDay, toDay) {
  const terms = gradeTermsMap(tables['grade-terms']);
  const events = treeDayEvents(tables.samples);
  const models = fitModelsByOrchard(tables, events);
  const points = calibrationPoints(tables['harvest-history'], models, Infinity);
  const curves = { A: calibrateGradeCurve(points.A), B: calibrateGradeCurve(points.B) };
  const access = new Map(tables['field-access'].map(f => [`${f.orchard}|${num(f.day)}`, f]));
  return tables.orchards.map(orchard => {
    const model = models.get(orchard.orchard);
    const days = [];
    for (let day = fromDay; day <= toDay; day += 1) {
      const acc = access.get(`${orchard.orchard}|${day}`) ?? null;
      const weather = acc ? acc.weather : null;
      const closed = acc != null && (acc.from === '' || acc.to === '');
      const capacityKg = weather == null ? null : num(weather === 'wet' ? orchard.wet_kg : orchard.dry_kg);
      const mu = model ? model.a + model.b * day : null;
      const grades = model ? gradeBands(curves, terms, mu, model.s) : null;
      days.push({
        day,
        weather,
        window: acc ? { from: acc.from, to: acc.to } : null,
        closed,
        capacityKg,
        brix: model ? { lo: mu - model.s, mid: mu, hi: mu + model.s } : null,
        grades,
        expectedKg:
          grades && capacityKg != null
            ? Object.fromEntries(
                Object.entries(grades).map(([grade, p]) => [
                  grade,
                  { lo: capacityKg * p.lo, mid: capacityKg * p.mid, hi: capacityKg * p.hi },
                ]),
              )
            : null,
      });
    }
    return {
      orchard: orchard.orchard,
      zone: orchard.zone,
      brandAllowed: orchard.brand_allowed === 'true',
      model: model ? { intercept: model.a, slope: model.b, sd: model.s, n: model.n } : null,
      days,
    };
  });
}

// 用往期不同成熟窗口检验预测稳定性：
// 每次签收只用其 known_day 之前可知的抽样与签收记录建模校准，再与实物分档对照
export function backtest(tables) {
  const terms = gradeTermsMap(tables['grade-terms']);
  const events = treeDayEvents(tables.samples);
  const history = [...tables['harvest-history']].sort((a, b) => num(a.known_day) - num(b.known_day));
  const results = [];
  for (const h of history) {
    const known = num(h.known_day);
    const day = num(h.day);
    const harvestKg = num(h.harvest_kg);
    const actualA = num(h.grade_a_kg) / harvestKg;
    const actualB = (num(h.grade_a_kg) + num(h.grade_b_kg)) / harvestKg;
    const trainEvents = events.filter(e => e.knownDay != null && e.knownDay < known);
    const models = fitModelsByOrchard(tables, trainEvents);
    const model = models.get(h.orchard);
    if (!model) {
      results.push({ inspection: h.inspection, orchard: h.orchard, day, skipped: true, actualA, actualB });
      continue;
    }
    const points = calibrationPoints(history, models, known - 1);
    const curves = { A: calibrateGradeCurve(points.A), B: calibrateGradeCurve(points.B) };
    const mu = model.a + model.b * day;
    const bands = gradeBands(curves, terms, mu, model.s);
    results.push({
      inspection: h.inspection,
      orchard: h.orchard,
      day,
      skipped: false,
      calibrated: bands.A.calibrated,
      actualA,
      actualB,
      predA: bands.A,
      predB: bands.B,
      hitA: actualA >= bands.A.lo && actualA <= bands.A.hi,
      hitB: actualB >= bands.B.lo && actualB <= bands.B.hi,
      errA: actualA - bands.A.mid,
      errB: actualB - bands.B.mid,
    });
  }
  const usable = results.filter(r => !r.skipped);
  const calibrated = usable.filter(r => r.calibrated);
  const meanAbs = key => usable.reduce((s, r) => s + Math.abs(r[key]), 0) / (usable.length || 1);
  const hitRate = (rows, key) => rows.filter(r => r[key]).length / (rows.length || 1);
  return {
    results,
    summary: {
      count: usable.length,
      skipped: results.length - usable.length,
      calibratedCount: calibrated.length,
      maeA: meanAbs('errA'),
      maeB: meanAbs('errB'),
      hitRateA: hitRate(usable, 'hitA'),
      hitRateB: hitRate(usable, 'hitB'),
      calibratedHitRateA: hitRate(calibrated, 'hitA'),
      calibratedHitRateB: hitRate(calibrated, 'hitB'),
    },
  };
}
