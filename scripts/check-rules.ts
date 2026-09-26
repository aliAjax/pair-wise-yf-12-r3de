// 业务规则端到端校验：由 esbuild 打包后在 Node 中运行
class MemoryStore {
  private data = new Map<string, string>();
  getItem(key: string) { return this.data.has(key) ? this.data.get(key)! : null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
  clear() { this.data.clear(); }
}
(globalThis as any).localStorage = new MemoryStore();

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name} ${extra}`); }
}

const { stations } = await import("../src/business/stations");
const catalog = await import("../src/business/catalog");
const ledger = await import("../src/business/ledger");

const idA = stations.value[0].id;
const idB = stations.value[1].id;

// ---- 1. FEFO 扣减：三明治 先到期8(已售2剩6) + 后到期6 ----
let batchesA = ledger.ledger.batches.filter((b: any) => b.stationId === idA && b.barcode === "6901002").sort((a: any, b: any) => a.expireDate.localeCompare(b.expireDate));
check("种子：早批次已按预置销售扣减为6", batchesA[0].qty === 6, `got ${batchesA[0].qty}`);
let plan = ledger.planSale(idA, [{ barcode: "6901002", name: "三明治", qty: 9 }]);
check("FEFO 试算成功", plan.ok, plan.message);
check("FEFO 先扣早批次6再扣晚批次3", plan.lines[0].batch.id === batchesA[0].id && plan.lines[0].qty === 6 && plan.lines[1].qty === 3,
  JSON.stringify(plan.lines.map((l: any) => l.qty)));
let res = ledger.checkout(idA, [{ barcode: "6901002", name: "三明治", qty: 9 }]);
check("FEFO 结算成功", res.ok, res.message);
batchesA = ledger.ledger.batches.filter((b: any) => b.stationId === idA && b.barcode === "6901002");
check("FEFO 扣减后早批次0、晚批次3", batchesA.sort((a: any, b: any) => a.expireDate.localeCompare(b.expireDate)).map((b: any) => b.qty).join(",") === "0,3");

// ---- 2. 库存不足（过期批次不计可用）----
const expiredCoffee = ledger.ledger.batches.find((b: any) => b.barcode === "6901004" && b.expireDate < ledger.today.value);
check("种子存在已过期咖啡批次", !!expiredCoffee && expiredCoffee.qty === 5);
check("过期批次不可售", !ledger.isSaleable(expiredCoffee));
const coffeeAvail = ledger.saleableBatches(idA, "6901004").reduce((s: number, b: any) => s + b.qty, 0);
check("可售咖啡仅12（过期5件不算）", coffeeAvail === 12, `got ${coffeeAvail}`);
res = ledger.checkout(idA, [{ barcode: "6901004", name: "罐装咖啡", qty: 13 }]);
check("超量销售被拒（提示可用12）", !res.ok && res.message.includes("12"), res.message);

// ---- 3. 折扣不得低于进价 ----
const riceBall = ledger.ledger.batches.find((b: any) => b.barcode === "6901003");
check("饭团种子贴签5.0（进价4.0）", riceBall.promoPrice === 5);
res = ledger.setPromo(riceBall.id, 3.9);
check("贴签低于进价被拒", !res.ok && res.message.includes("低于进价"), res.message);
check("被拒后折扣价不变", riceBall.promoPrice === 5);
res = ledger.setPromo(riceBall.id, 4.0);
check("贴签等于进价允许", res.ok && riceBall.promoPrice === 4, res.message);
// 销售取折扣价
res = ledger.checkout(idA, [{ barcode: "6901003", name: "饭团", qty: 2 }]);
check("折扣批次按签价结算", res.ok && res.message.includes("8.00"), res.message);

// 商品规则：售价低于进价拒绝
let rule = catalog.upsertProduct({ barcode: "X1", name: "测试", cost: 5, price: 4.9, shelfDays: 10 });
check("商品售价低于进价拒绝", !rule.ok, rule.message);

// ---- 4. 撤销销售退回原批次 ----
const sale = ledger.ledger.sales.find((s: any) => s.lines.some((l: any) => l.barcode === "6901002" && l.qty === 2 && s.stationId === idA));
const earlyBatch = ledger.ledger.batches.find((b: any) => b.id === sale.lines[0].batchId);
const qtyBeforeVoid = earlyBatch.qty; // 0 (6 已被后续9件销售扣完)
res = ledger.voidSale(sale.id);
check("撤销成功", res.ok, res.message);
check("撤销把数量退回原批次", earlyBatch.qty === qtyBeforeVoid + 2, `before=${qtyBeforeVoid} after=${earlyBatch.qty}`);
res = ledger.voidSale(sale.id);
check("重复撤销拒绝", !res.ok);
// 当日销量排除撤销
const summary = ledger.daySummary(ledger.today.value, idA);
const validSales = ledger.ledger.sales.filter((s: any) => s.stationId === idA && !s.voided);
check("当日汇总只算未撤销笔数", summary.count === validSales.length, `${summary.count} vs ${validSales.length}`);
check("撤销数量退回后库存总额守恒可再售", ledger.saleableBatches(idA, "6901002").reduce((s: number, b: any) => s + b.qty, 0) === 5);

// ---- 5. 整批调拨 + 货位不足两边保留 ----
check("A站货位满载(6)", ledger.usedSlots(idA) === 6 && ledger.freeSlots(idA) === 0,
  `used=${ledger.usedSlots(idA)}`);
const bBatch = ledger.ledger.batches.find((b: any) => b.stationId === idB);
res = ledger.transferBatch(bBatch.id, idA);
check("调入站货位满 -> 拒绝且库存保留", !res.ok && res.message.includes("货位") && bBatch.stationId === idB, res.message);
check("两边库存不变（B仍持有）", ledger.ledger.batches.filter((b: any) => b.stationId === idB).length === 1);

// 拆零批次不可调拨
const splitBatch = ledger.ledger.batches.find((b: any) => b.barcode === "6901002" && b.stationId === idA && b.qty !== b.receiveQty);
check("存在已拆零批次", !!splitBatch);
check("拆零批次不在可调拨列表", !ledger.transferableBatches(idA).some((b: any) => b.id === splitBatch.id));
res = ledger.transferBatch(splitBatch.id, idB);
check("拆零批次调拨被拒", !res.ok && res.message.includes("整批"), res.message);

// 过期批次不可调拨
res = ledger.transferBatch(expiredCoffee.id, idB);
check("过期批次调拨被拒", !res.ok && expiredCoffee.stationId === idA, res.message);

// 整批可调拨成功：A站晚批次三明治(3/3? 晚批次原6扣3剩3 → 已拆零)；矿泉水24整批可调拨
const waterA = ledger.ledger.batches.find((b: any) => b.barcode === "6901001" && b.stationId === idA);
res = ledger.transferBatch(waterA.id, idB);
check("整批调拨成功（B站有空位）", res.ok, res.message);
check("调拨后批次归属B站", waterA.stationId === idB);
check("调拨释放A站货位(5)", ledger.usedSlots(idA) === 5 && ledger.freeSlots(idA) === 1);
check("调拨占用B站货位(2)", ledger.usedSlots(idB) === 2);
check("调拨留痕", ledger.ledger.transfers.length === 1 && ledger.ledger.transfers[0].qty === 24);

// ---- 6. 登记批次：货位 / 到期校验 / 陌生条码自动建档 ----
res = ledger.registerBatch({ stationId: idB, barcode: "6902000", name: "口香糖", cost: 2, qty: 5, expireDate: ledger.today.value });
check("B站货位足够登记成功", res.ok, res.message);
check("登记占用货位 B=3", ledger.usedSlots(idB) === 3);
const created = catalog.findProduct("6902000");
check("陌生条码自动建商品规则(售价=进价)", !!created && created.price === 2 && created.name === "口香糖");

// 把 B 填满后再拒绝
const capB = ledger.stationCapacity(idB);
let last: any;
for (let i = ledger.usedSlots(idB); i < capB; i++) {
  last = ledger.registerBatch({ stationId: idB, barcode: "6902000", name: "口香糖", cost: 2, qty: 1, expireDate: ledger.today.value });
}
check("连续登记直到货位满", last?.ok && ledger.freeSlots(idB) === 0, last?.message);
last = ledger.registerBatch({ stationId: idB, barcode: "6902000", name: "口香糖", cost: 2, qty: 1, expireDate: ledger.today.value });
check("货位满后新批次拒绝", !last.ok && last.message.includes("货位"), last.message);

// 过期日期拒绝
res = ledger.registerBatch({ stationId: idA, barcode: "6901001", name: "矿泉水", cost: 1, qty: 1, expireDate: "2000-01-01" });
check("到期日已过拒绝登记", !res.ok && res.message.includes("到期日"), res.message);

// 货位容量不能小于占用
res = ledger.setStationCapacity(idB, 1);
check("货位调小于占用拒绝", !res.ok);

// ---- 7. 撤销已调拨批次的销售 -> 仍退回原批次（现归属B站）----
// 先在 B 站卖一瓶刚调入的水，再撤销
res = ledger.checkout(idB, [{ barcode: "6901001", name: "矿泉水 550ml", qty: 1 }]);
check("调入批次可在B站销售", res.ok, res.message);
check("销售后批次拆零不可再整批调拨", !ledger.transferableBatches(idB).some((b: any) => b.id === waterA.id));
const waterSale = ledger.ledger.sales.find((s: any) => s.lines.some((l: any) => l.batchId === waterA.id));
const qtyBefore = waterA.qty;
res = ledger.voidSale(waterSale.id);
check("撤销退回原批次（虽然发生在B站销售）", res.ok && waterA.qty === qtyBefore + 1, res.message);

// ---- 8. 当日销量汇总数值 ----
const all = ledger.daySummary(ledger.today.value);
check("全站当日销量有件数与金额", all.qty > 0 && all.amount > 0, JSON.stringify(all));
check("折扣查询只返回未过期批次", ledger.promoBatches().every((b: any) => b.expireDate >= ledger.today.value));

// ---- 9. 持久化：刷新重载 ----
const persisted = JSON.parse(localStorage.getItem("hxwlfront-21-batch-ledger")!);
check("台账已落 localStorage（版本化）", persisted.version === 1 && Array.isArray(persisted.state.batches));
check("油站仍用旧 storage key", !!localStorage.getItem("hxwlfront-21-station-map"));

console.log(failures === 0 ? "\nALL RULES PASS" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
