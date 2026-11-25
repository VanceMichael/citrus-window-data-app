# 芦柑成熟度证据、分批交货与品牌批声明

业务资料均为合成记录。表头字段及跨表引用见 `fixtures/format.json`。

## 数据说明

day 是采收季起点的相对天数，负数为前期历史。brix 为糖度，空值表示无有效读数。samples 的 weight 是树区抽样扩展权重；同树不同日用于纵向，同树同日多点属于同一次树级抽样。商品名义重量计千克。箱由箱号标识，多个来源行属于同一箱。grade-terms 比例指低于该档最低糖度的质量分数，任一来源不在品牌范围则无法对整箱签品牌。
适用库温上限与容量取 cooling。过温确证和无完整记录分别判，后续补报时间取 temperature.known_day。signed 不能被重配，reserved 只在批准释放后才重新可用。
harvest-history 是往期按地块、采收窗签收的实物量记录，分档重量单位为千克。known_day 之前只能使用此前可知的采样和天气信息。
pack-checks 是包装抽检的原始称重，列明检验组低于对应档位的实测重量。不同抽检日并列，较晚检验何时可知由 known_day 给出。boxes 是当前来源登记；source-notices 记更正了多少来自哪个果园的箱重，用于核查当时实际收到的来源证明。brand-register 是按订单与箱号留下的品牌声明，signed 表明声明已给买手，reserved 仅留货。cold-movements 的 实际占用以 complete 为准，planned 尚未移出，库温风险按实际所在库判断。field-access 记地块实际可进园的时窗，窗为空表示停入。

CSV 使用 UTF-8、逗号分隔，无引号与内嵌换行。未提供的字段是空字符串，作为关系值的 `-` 表示不适用。多值字段用竖线分隔，数值和日期单位见业务约定。

## 资料检查

使用 Node.js 22.23.4，依赖仅为 Node.js 标准库。运行 `npm ci --ignore-scripts --offline` 准备工作区。

运行 `npm run check:materials` 检查合成交接资料的字段与记录引用。运行 `npm test` 检查交接资料的读取和校验。

## 履约与预测工具

`tools/citrus.mjs`（或 `npm run citrus -- <命令>`）供采收、包装、订单与库管人员共用。每次新采样、分选、转柜记录追加进 CSV 后重跑即可；`--as-of N` 只看第 N 天及之前可知的记录，`--json` 输出机读结果，`--data` 指定资料目录（默认 `fixtures/`）。

```
node tools/citrus.mjs summary                  当日总览：订单结论、覆盖与冷库缺口
node tools/citrus.mjs coverage                 抽样覆盖与未覆盖地块（同树同日只算一次树级抽样）
node tools/citrus.mjs forecast --from 9 --to 14  各地块可采收量与达标范围，附往期窗口回测
node tools/citrus.mjs orders                   各订单已承诺量是否仍做得到、受影响箱与缺口
node tools/citrus.mjs statements               品牌声明逐箱核对（更正/复验只推翻个别箱）
node tools/citrus.mjs boxes                    各箱实测品级、来源构成与库温状态
node tools/citrus.mjs plans fixtures/plans.example.json  比较采摘与转柜方案
node tools/citrus.mjs buyer P1                 买手视图：交付窗口与所拿箱的公开口径
node tools/citrus.mjs internal                 内部视图：未覆盖、断测、重复预留与待重配
node tools/citrus.mjs add samples "S8,O1,T3,8,8,11.9,clear,2"  追加记录（先校验再写入）
```

### 口径约定

- 同树同日的多条样本（含复合果样）合并为一次树级抽样，不重复计覆盖。
- 成熟度预测用加权线性模型拟合糖度-天数；田间抽样集中在靠路的树，直接按糖度阈值推断整批分档会失真，因此达标比例用往期签收记录校准（饱和上限 + probit 拟合），并用不同成熟窗口回测，命中率与未校准窗口如实列出。
- 箱品级按来源果园分别对照 grade-terms，不靠多来源平均；任一来源不在品牌允许范围，整箱不可签品牌。boxes 是当前登记，晚于查询日的来源更正会回滚到当时口径。
- 箱的可交状态分三档：可交 / 待重新确认（来源更正、过温确证、复验未完成等，重新确认前不计入可交）/ 不可直交（品级、品牌、储存窗口硬条件不满足）。过温确证与温度断测分别判定。
- signed 不能被重配；reserved 只在批准释放后才可重新分配；承诺量与承诺加申请量超出箱量即报重复预留冲突。
- 方案比较核对进园时窗（雨湿停入）、冷库共用容量（只认 complete 的转柜）与已约交期；未成熟的量一律给区间并标注不确定。

