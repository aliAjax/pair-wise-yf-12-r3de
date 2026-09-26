import { ref } from "vue";

/**
 * 商品规则业务文件
 * 条码为主键，维护名称、进价、售价、保质期天数。
 * 规则：任何折扣价都不得低于进价，校验集中在 assertDiscountFloor / canDiscount。
 */

export type Product = {
  barcode: string;
  name: string;
  /** 进价（成本价），折扣底价 */
  cost: number;
  /** 正常售价 */
  price: number;
  /** 保质期天数，登记批次时用来预填到期日 */
  shelfDays: number;
};

const CATALOG_STORAGE_KEY = "hxwlfront-21-product-catalog";
const CATALOG_VERSION = 1;

const seedProducts: Product[] = [
  { barcode: "6901001", name: "矿泉水 550ml", cost: 1.2, price: 3.0, shelfDays: 365 },
  { barcode: "6901002", name: "三明治", cost: 6.5, price: 12.0, shelfDays: 3 },
  { barcode: "6901003", name: "饭团", cost: 4.0, price: 8.0, shelfDays: 2 },
  { barcode: "6901004", name: "罐装咖啡", cost: 3.5, price: 7.0, shelfDays: 180 }
];

function loadProducts(): Product[] {
  const raw = localStorage.getItem(CATALOG_STORAGE_KEY);
  if (!raw) return seedProducts.map((item) => ({ ...item }));
  try {
    const parsed = JSON.parse(raw) as { version?: number; products?: Product[] };
    if (Array.isArray(parsed?.products)) {
      return parsed.products.filter((p) => p && typeof p.barcode === "string");
    }
  } catch {
    /* 数据损坏时回落到种子数据 */
  }
  return seedProducts.map((item) => ({ ...item }));
}

export const products = ref<Product[]>(loadProducts());

export function persistCatalog() {
  localStorage.setItem(CATALOG_STORAGE_KEY, JSON.stringify({ version: CATALOG_VERSION, products: products.value }));
}

export function findProduct(barcode: string): Product | undefined {
  return products.value.find((product) => product.barcode === barcode);
}

export type RuleResult = { ok: boolean; message: string };

/** 折扣不得低于进价；售价同样不能低于进价 */
export function assertDiscountFloor(barcode: string, price: number): RuleResult {
  const product = findProduct(barcode);
  if (!product) return { ok: false, message: `条码 ${barcode} 未登记商品规则` };
  if (!Number.isFinite(price) || price < 0) return { ok: false, message: "价格不合法" };
  if (price + 1e-9 < product.cost) {
    return { ok: false, message: `折扣价 ¥${price.toFixed(2)} 低于进价 ¥${product.cost.toFixed(2)}，不能贴签` };
  }
  return { ok: true, message: "" };
}

export function upsertProduct(input: Product): RuleResult {
  if (!input.barcode.trim()) return { ok: false, message: "条码不能为空" };
  if (!input.name.trim()) return { ok: false, message: "商品名称不能为空" };
  if (!Number.isFinite(input.cost) || input.cost < 0) return { ok: false, message: "进价不合法" };
  if (!Number.isFinite(input.price) || input.price + 1e-9 < input.cost) {
    return { ok: false, message: "售价不得低于进价" };
  }
  if (!Number.isInteger(input.shelfDays) || input.shelfDays <= 0) {
    return { ok: false, message: "保质期天数须为正整数" };
  }
  const product: Product = {
    barcode: input.barcode.trim(),
    name: input.name.trim(),
    cost: round2(input.cost),
    price: round2(input.price),
    shelfDays: input.shelfDays
  };
  const index = products.value.findIndex((item) => item.barcode === product.barcode);
  if (index >= 0) {
    products.value[index] = product;
  } else {
    products.value = [...products.value, product];
  }
  persistCatalog();
  return { ok: true, message: index >= 0 ? "商品规则已更新" : "商品已登记" };
}

export function removeProduct(barcode: string, inUse: boolean): RuleResult {
  if (inUse) return { ok: false, message: "该商品已有批次台账记录，不能删除规则" };
  products.value = products.value.filter((product) => product.barcode !== barcode);
  persistCatalog();
  return { ok: true, message: "商品规则已删除" };
}

/** 台账登记陌生条码时自动建档（默认售价=进价，避免没有规则可依），返回的 message 供界面提示 */
export function ensureProduct(barcode: string, name: string, cost: number, shelfDays = 30): { product: Product; created: boolean } {
  const existing = findProduct(barcode);
  if (existing) return { product: existing, created: false };
  const product: Product = { barcode: barcode.trim(), name: name.trim() || `商品${barcode}`, cost: round2(cost), price: round2(cost), shelfDays };
  products.value = [...products.value, product];
  persistCatalog();
  return { product, created: true };
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
