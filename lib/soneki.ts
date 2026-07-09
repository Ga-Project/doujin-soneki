// doujin-soneki — 中核計算ロジック（純関数のみ・DOM/React 非依存）。
// すべての金額計算はここに集約し、UI は表示に徹する。単体テストは test/soneki.test.mjs。
//
// モデル:
//   損益(k) = k × (頒価 × (1 − 手数料率) − 定額手数料/冊) − (印刷総額 + 固定費)
//   k = 頒布数。印刷総額は「選択した刷り部数の行」で確定するため、各チャネルの
//   損益は k についての一次直線になる（グラフ仕様の前提）。

// ---------------------------------------------------------------------------
// パース（入力文字列 → 数値）。不正・空は null を返し、NaN/Infinity を外に出さない。
// ---------------------------------------------------------------------------

/** 非負の有限数のみ受理（"" / 負値 / 数値でない → null）。 */
export function parseNum(raw: string): number | null {
  const s = raw.trim();
  if (s === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/** 部数の実務上限。これを超える入力は受理しない（DOM 生成・描画の安全弁も兼ねる）。 */
export const MAX_COPIES = 100000;

/** 1 以上 MAX_COPIES 以下の整数のみ受理（部数用）。 */
export function parseCopies(raw: string): number | null {
  const n = parseNum(raw);
  if (n === null || !Number.isInteger(n) || n < 1 || n > MAX_COPIES)
    return null;
  return n;
}

/** 手数料率 0〜100（%）のみ受理。 */
export function parseFeePercent(raw: string): number | null {
  const n = parseNum(raw);
  if (n === null || n > 100) return null;
  return n;
}

// ---------------------------------------------------------------------------
// 印刷費の階段単価テーブル
// ---------------------------------------------------------------------------

/** 単価テーブル 1 行の入力（部数 ×「単価 or 総額」のどちらか基準で入力できる）。 */
export interface TierInput {
  copies: string;
  unit: string;
  total: string;
  /** 最後にユーザーが編集した側。導出値はもう一方に表示する。 */
  basis: "unit" | "total";
}

/** 正規化済みの単価行（部数・単価・総額がすべて確定した状態）。 */
export interface Tier {
  copies: number;
  unitCost: number;
  totalCost: number;
}

/**
 * 入力行を正規化する。basis 側の値と部数から他方を導出。
 * 部数が無い・basis 側の値が無い場合は null（未完成行）。
 */
export function normalizeTier(input: TierInput): Tier | null {
  const copies = parseCopies(input.copies);
  if (copies === null) return null;
  if (input.basis === "unit") {
    const unit = parseNum(input.unit);
    if (unit === null) return null;
    return { copies, unitCost: unit, totalCost: unit * copies };
  }
  const total = parseNum(input.total);
  if (total === null) return null;
  return { copies, unitCost: total / copies, totalCost: total };
}

/**
 * 階段状単価の区間選択: 部数 copies に適用される行（copies 以下で最大の部数の行）を返す。
 * どの行の部数にも届かない（最小行未満）場合は null。
 */
export function pickTierForCopies(
  tiers: readonly Tier[],
  copies: number,
): Tier | null {
  let picked: Tier | null = null;
  for (const t of tiers) {
    if (t.copies <= copies && (picked === null || t.copies > picked.copies)) {
      picked = t;
    }
  }
  return picked;
}

// ---------------------------------------------------------------------------
// チャネル（会場頒布 / 委託）と損益
// ---------------------------------------------------------------------------

/** チャネルの控除条件。feeRate は 0〜1、perItemFee は 1 冊あたりの定額控除（円）。 */
export interface ChannelParams {
  feeRate: number;
  perItemFee: number;
}

export type ChannelParseResult =
  | { ok: true; params: ChannelParams }
  | { ok: false; reason: "fee-empty" | "fee-invalid" | "per-item-invalid" };

/**
 * チャネル入力（手数料率%・定額手数料 円/冊）を検証して ChannelParams に解決する。
 * 不正入力は黙って 0 に置き換えず、必ず reason 付きで無効を返す（見えている入力と
 * 計算結果の食い違いを作らない）。
 *   - 会場頒布（direct）は常に手数料 0 / 定額 0
 *   - 手数料率: 空 = 入力待ち（fee-empty・エラー表示なしで除外）、0〜100 以外は fee-invalid
 *   - 定額手数料: 空 = 0 扱い、負値・数値でない入力は per-item-invalid
 */
export function parseChannelParams(
  kind: "direct" | "consign",
  fee: string,
  perItem: string,
): ChannelParseResult {
  if (kind === "direct") {
    return { ok: true, params: { feeRate: 0, perItemFee: 0 } };
  }
  const feePct = parseFeePercent(fee);
  if (feePct === null) {
    return {
      ok: false,
      reason: fee.trim() === "" ? "fee-empty" : "fee-invalid",
    };
  }
  const per = perItem.trim() === "" ? 0 : parseNum(perItem);
  if (per === null) {
    return { ok: false, reason: "per-item-invalid" };
  }
  return { ok: true, params: { feeRate: feePct / 100, perItemFee: per } };
}

/** 1 冊頒布あたりの手取り（円）。マイナスにもなり得る（定額控除 > 頒価×(1−率)）。 */
export function netPerCopy(price: number, ch: ChannelParams): number {
  return price * (1 - ch.feeRate) - ch.perItemFee;
}

/** k 部頒布時の損益（円）。baseCost = 印刷総額 + 固定費。 */
export function profitAt(
  k: number,
  price: number,
  ch: ChannelParams,
  baseCost: number,
): number {
  return k * netPerCopy(price, ch) - baseCost;
}

/**
 * 損益分岐部数（この部数の頒布で損益 ≥ 0 になる最小の整数部数）。
 * 1 冊あたり手取りが 0 以下なら何部頒布しても黒字にならない → null。
 * baseCost が 0 以下なら 0（最初から黒字）。
 */
export function breakEvenCopies(
  price: number,
  ch: ChannelParams,
  baseCost: number,
): number | null {
  const net = netPerCopy(price, ch);
  if (net <= 0) return baseCost <= 0 ? 0 : null;
  if (baseCost <= 0) return 0;
  return Math.ceil(baseCost / net);
}

/** 損益分岐の厳密な交点（グラフのマーカー位置用・非整数）。黒字化しないなら null。 */
export function breakEvenExact(
  price: number,
  ch: ChannelParams,
  baseCost: number,
): number | null {
  const net = netPerCopy(price, ch);
  if (net <= 0) return baseCost <= 0 ? 0 : null;
  if (baseCost <= 0) return 0;
  return baseCost / net;
}

/** 完売時（刷り部数 copies を全て頒布）の損益。 */
export function selloutProfit(
  copies: number,
  price: number,
  ch: ChannelParams,
  baseCost: number,
): number {
  return profitAt(copies, price, ch, baseCost);
}

/** 完売時の 1 冊あたり損益（円・四捨五入）。copies が 0 以下なら null。 */
export function perCopyAtSellout(
  copies: number,
  price: number,
  ch: ChannelParams,
  baseCost: number,
): number | null {
  if (copies <= 0) return null;
  return Math.round(selloutProfit(copies, price, ch, baseCost) / copies);
}

/**
 * 推奨頒価レンジ（入力値からの逆算・10 円単位に切り上げ）:
 *   sellout = 完売（copies 全部頒布）でちょうど損益 0 になる頒価
 *   at70    = 7 割頒布（floor(copies×0.7)・最低 1 部）でちょうど損益 0 になる頒価
 * 手数料率が 100% 以上相当なら null。市場実勢ではなく、あくまで入力値からの算出。
 */
export function priceRange(
  copies: number,
  ch: ChannelParams,
  baseCost: number,
): { sellout: number; at70: number } | null {
  if (copies < 1 || ch.feeRate >= 1) return null;
  const priceFor = (k: number): number =>
    Math.max(
      0,
      Math.ceil((baseCost / k + ch.perItemFee) / (1 - ch.feeRate) / 10) * 10,
    );
  const k70 = Math.max(1, Math.floor(copies * 0.7));
  return { sellout: priceFor(copies), at70: priceFor(k70) };
}

/** 配分プラン（チャネルごとの予定部数）の合計損益。 */
export function allocationProfit(
  plans: readonly { copies: number; ch: ChannelParams }[],
  price: number,
  baseCost: number,
): number {
  let revenue = 0;
  for (const p of plans) {
    revenue += p.copies * netPerCopy(price, p.ch);
  }
  return revenue - baseCost;
}

// ---------------------------------------------------------------------------
// グラフの軸目盛（キリ値）
// ---------------------------------------------------------------------------

/** range/target 以上で最小の 1/2/5 × 10^n を返す（軸目盛のキリ値ステップ）。 */
export function niceStep(range: number, target: number): number {
  if (range <= 0 || target <= 0) return 1;
  const rough = range / target;
  const pow = 10 ** Math.floor(Math.log10(rough));
  for (const m of [1, 2, 5, 10]) {
    if (m * pow >= rough) return m * pow;
  }
  return 10 * pow;
}

/**
 * 損益表（「表で見る」）の刻み幅。基本 25 部刻み、部数が大きい場合は
 * 行数が 40 行程度に収まるようキリ値（1/2/5×10^n）へ自動拡大する。
 */
export function tableStep(copies: number): number {
  return Math.max(25, niceStep(copies, 40));
}

/** [min, max] を含む範囲のキリ値目盛（step の整数倍のみ・0 を必ず含み得る）。 */
export function tickValues(min: number, max: number, target: number): number[] {
  if (!(max > min)) return [0];
  const step = niceStep(max - min, target);
  const ticks: number[] = [];
  for (
    let v = Math.ceil(min / step) * step;
    v <= max + step * 1e-9;
    v += step
  ) {
    // -0 を 0 に正規化
    ticks.push(v === 0 ? 0 : v);
  }
  return ticks;
}

// ---------------------------------------------------------------------------
// 表示フォーマット
// ---------------------------------------------------------------------------

const MINUS = "−"; // − 全角マイナス記号（ハイフンと区別）

/** 桁区切りの金額。「¥12,400」「−¥8,200」。小数は四捨五入。 */
export function formatYen(n: number): string {
  const v = Math.round(n);
  const abs = Math.abs(v).toLocaleString("ja-JP");
  return v < 0 ? `${MINUS}¥${abs}` : `¥${abs}`;
}

/** 符号付き金額。「+¥12,400」「−¥8,200」「±¥0」。 */
export function formatSignedYen(n: number): string {
  const v = Math.round(n);
  if (v === 0) return "±¥0";
  return v > 0 ? `+¥${v.toLocaleString("ja-JP")}` : formatYen(v);
}

/** Y 軸用の圧縮表記。「+2万」「−1万」「+2,500」「0」。 */
export function compactYen(n: number): string {
  const v = Math.round(n);
  if (v === 0) return "0";
  const sign = v > 0 ? "+" : MINUS;
  const abs = Math.abs(v);
  if (abs >= 10000) {
    const man = abs / 10000;
    const s = Number.isInteger(man) ? String(man) : man.toFixed(1);
    return `${sign}${s}万`;
  }
  return `${sign}${abs.toLocaleString("ja-JP")}`;
}

// ---------------------------------------------------------------------------
// 頒布タリー（イベントソーシング + Undo スタック）
// ---------------------------------------------------------------------------

export interface TallyItem {
  id: string;
  name: string;
  /** 搬入数（未設定は null）。 */
  carryIn: number | null;
  count: number;
  /** この頒布物の頒価（未設定 = シミュレータの頒価にフォールバック）。 */
  price?: number | null;
}

export type TallyEvent =
  | { type: "inc"; itemId: string }
  | { type: "set"; itemId: string; from: number; to: number };

/** イベントを適用した新しい items を返す（対象が無ければそのまま）。 */
export function applyTallyEvent(
  items: readonly TallyItem[],
  ev: TallyEvent,
): TallyItem[] {
  return items.map((it) => {
    if (it.id !== ev.itemId) return it;
    if (ev.type === "inc") return { ...it, count: it.count + 1 };
    return { ...it, count: Math.max(0, ev.to) };
  });
}

/** イベントの逆操作を適用する（Undo 用）。 */
function invertTallyEvent(
  items: readonly TallyItem[],
  ev: TallyEvent,
): TallyItem[] {
  return items.map((it) => {
    if (it.id !== ev.itemId) return it;
    if (ev.type === "inc") return { ...it, count: Math.max(0, it.count - 1) };
    return { ...it, count: Math.max(0, ev.from) };
  });
}

/**
 * 直近のイベントを取り消す。履歴が空なら何もしない。
 * 対象頒布物が削除済みのイベントは読み飛ばして、さらに前の操作を取り消す。
 */
export function undoTally(
  items: readonly TallyItem[],
  history: readonly TallyEvent[],
): { items: TallyItem[]; history: TallyEvent[] } {
  const rest = [...history];
  while (rest.length > 0) {
    const ev = rest.pop() as TallyEvent;
    if (items.some((it) => it.id === ev.itemId)) {
      return { items: invertTallyEvent(items, ev), history: rest };
    }
  }
  return { items: [...items], history: [] };
}

/** 残り部数（搬入数未設定なら null。売超過でも 0 で止める）。 */
export function remainingCopies(item: TallyItem): number | null {
  if (item.carryIn === null) return null;
  return Math.max(0, item.carryIn - item.count);
}
