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
