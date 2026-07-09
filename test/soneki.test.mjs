// doujin-soneki — 中核ロジックの単体テスト（node:test 標準ランナー・追加依存なし）。
// 実行: pnpm test（Node が .ts を型ストリップして読み込む）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseNum,
  parseCopies,
  parseFeePercent,
  normalizeTier,
  pickTierForCopies,
  netPerCopy,
  profitAt,
  breakEvenCopies,
  breakEvenExact,
  selloutProfit,
  perCopyAtSellout,
  priceRange,
  allocationProfit,
  niceStep,
  tickValues,
  formatYen,
  formatSignedYen,
  compactYen,
  applyTallyEvent,
  undoTally,
  remainingCopies,
} from "../lib/soneki.ts";

test("parseNum / parseCopies / parseFeePercent: 不正入力を null に落とし NaN を出さない", () => {
  assert.equal(parseNum("500"), 500);
  assert.equal(parseNum(" 12.5 "), 12.5);
  assert.equal(parseNum(""), null);
  assert.equal(parseNum("-1"), null);
  assert.equal(parseNum("abc"), null);
  assert.equal(parseNum("Infinity"), null);
  assert.equal(parseCopies("200"), 200);
  assert.equal(parseCopies("0"), null);
  assert.equal(parseCopies("12.5"), null);
  assert.equal(parseFeePercent("30"), 30);
  assert.equal(parseFeePercent("0"), 0);
  assert.equal(parseFeePercent("100"), 100);
  assert.equal(parseFeePercent("101"), null);
});

test("normalizeTier: 単価基準・総額基準の両方から行を確定する", () => {
  // 部数×単価 → 総額を導出
  assert.deepEqual(
    normalizeTier({ copies: "100", unit: "320", total: "", basis: "unit" }),
    { copies: 100, unitCost: 320, totalCost: 32000 },
  );
  // 部数×総額 → 単価を導出
  assert.deepEqual(
    normalizeTier({ copies: "200", unit: "", total: "36000", basis: "total" }),
    { copies: 200, unitCost: 180, totalCost: 36000 },
  );
  // 未完成行（部数のみ・basis 側の値なし）は null
  assert.equal(normalizeTier({ copies: "100", unit: "", total: "", basis: "unit" }), null);
  assert.equal(normalizeTier({ copies: "", unit: "320", total: "", basis: "unit" }), null);
});

test("pickTierForCopies: 階段単価の区間選択と境界値", () => {
  const tiers = [
    { copies: 100, unitCost: 280, totalCost: 28000 },
    { copies: 200, unitCost: 180, totalCost: 36000 },
    { copies: 300, unitCost: 140, totalCost: 42000 },
  ];
  // 境界ちょうど → その行
  assert.equal(pickTierForCopies(tiers, 200)?.copies, 200);
  // 境界の 1 部下 → ひとつ下の行
  assert.equal(pickTierForCopies(tiers, 199)?.copies, 100);
  // 境界の 1 部上 → 同じ行のまま
  assert.equal(pickTierForCopies(tiers, 201)?.copies, 200);
  // 最大行超過 → 最大行
  assert.equal(pickTierForCopies(tiers, 1000)?.copies, 300);
  // 最小行未満 → null
  assert.equal(pickTierForCopies(tiers, 99), null);
  assert.equal(pickTierForCopies([], 100), null);
});

test("netPerCopy: 手数料率と定額控除を頒価から差し引く", () => {
  assert.equal(netPerCopy(500, { feeRate: 0, perItemFee: 0 }), 500);
  assert.equal(netPerCopy(500, { feeRate: 0.3, perItemFee: 0 }), 350);
  // 率 + 定額（例: 5.6% + 45円/冊）
  assert.equal(netPerCopy(1000, { feeRate: 0.056, perItemFee: 45 }), 899);
});

test("breakEvenCopies: 損益分岐部数と境界値", () => {
  const direct = { feeRate: 0, perItemFee: 0 };
  // 42000 ÷ 500 = 84 ちょうど（割り切れる境界）
  assert.equal(breakEvenCopies(500, direct, 42000), 84);
  // 端数は切り上げ（84 部では足りない → 85 部）
  assert.equal(breakEvenCopies(500, direct, 42100), 85);
  // 費用 0 → 0 部から黒字
  assert.equal(breakEvenCopies(500, direct, 0), 0);
  // 手取り 0 以下 → 黒字にならない
  assert.equal(breakEvenCopies(500, { feeRate: 1, perItemFee: 0 }, 42000), null);
  assert.equal(breakEvenCopies(100, { feeRate: 0, perItemFee: 100 }, 42000), null);
  // 厳密交点はグラフマーカー用（非整数のまま返る）
  assert.equal(breakEvenExact(500, direct, 42100), 84.2);
});

test("profitAt / selloutProfit / perCopyAtSellout: 損益と 1 冊あたり", () => {
  const direct = { feeRate: 0, perItemFee: 0 };
  // 0 部時点は費用の全額がマイナス
  assert.equal(profitAt(0, 500, direct, 42000), -42000);
  assert.equal(selloutProfit(200, 500, direct, 42000), 58000);
  // 赤字ケース
  assert.equal(selloutProfit(100, 300, { feeRate: 0.3, perItemFee: 0 }, 28000), -7000);
  // 1 冊あたり = 完売損益 ÷ 部数（四捨五入）
  assert.equal(perCopyAtSellout(320, 400, { feeRate: 0.3, perItemFee: 0 }, 77200), 39);
  assert.equal(perCopyAtSellout(0, 500, direct, 42000), null);
});

test("priceRange: 完売基準〜7割頒布基準の頒価を 10 円単位で逆算する", () => {
  const direct = { feeRate: 0, perItemFee: 0 };
  const r = priceRange(200, direct, 42000);
  assert.ok(r);
  // 完売: 42000/200 = 210 → 210 円
  assert.equal(r.sellout, 210);
  // 7 割 = 140 部: 42000/140 = 300 → 300 円
  assert.equal(r.at70, 300);
  // 手数料 30% なら 1/(1-0.3) 倍して切り上げ
  const rf = priceRange(200, { feeRate: 0.3, perItemFee: 0 }, 42000);
  assert.ok(rf);
  assert.equal(rf.sellout, 300);
  // 手数料 100% は算出不能
  assert.equal(priceRange(200, { feeRate: 1, perItemFee: 0 }, 42000), null);
});

test("allocationProfit: チャネル配分（予定部数）の合計損益", () => {
  const plans = [
    { copies: 100, ch: { feeRate: 0, perItemFee: 0 } }, // 会場: 100×500
    { copies: 50, ch: { feeRate: 0.3, perItemFee: 0 } }, // 委託: 50×350
  ];
  // 50000 + 17500 − 42000 = 25500
  assert.equal(allocationProfit(plans, 500, 42000), 25500);
  assert.equal(allocationProfit([], 500, 42000), -42000);
});

test("niceStep / tickValues: 軸目盛はキリ値（1/2/5×10^n）", () => {
  assert.equal(niceStep(200, 4), 50);
  assert.equal(niceStep(1000, 5), 200);
  assert.equal(niceStep(70000, 5), 20000);
  assert.deepEqual(tickValues(0, 200, 4), [0, 50, 100, 150, 200]);
  // 負域を含む範囲でも step の整数倍（0 を含む）
  assert.deepEqual(tickValues(-42000, 58000, 5), [-40000, -20000, 0, 20000, 40000]);
});

test("formatYen / formatSignedYen / compactYen: 金額表記", () => {
  assert.equal(formatYen(12400), "¥12,400");
  assert.equal(formatYen(-8200), "−¥8,200");
  assert.equal(formatSignedYen(12400), "+¥12,400");
  assert.equal(formatSignedYen(-8200), "−¥8,200");
  assert.equal(formatSignedYen(0), "±¥0");
  assert.equal(compactYen(20000), "+2万");
  assert.equal(compactYen(-10000), "−1万");
  assert.equal(compactYen(15000), "+1.5万");
  assert.equal(compactYen(2500), "+2,500");
  assert.equal(compactYen(0), "0");
});

test("タリー: +1 と Undo（直近操作の取り消しスタック）", () => {
  const a = { id: "a", name: "新刊A", carryIn: 30, count: 0 };
  const b = { id: "b", name: "既刊B", carryIn: null, count: 5 };
  let items = [a, b];
  let history = [];

  // +1 を 2 回（a, b の順）
  items = applyTallyEvent(items, { type: "inc", itemId: "a" });
  history = [...history, { type: "inc", itemId: "a" }];
  items = applyTallyEvent(items, { type: "inc", itemId: "b" });
  history = [...history, { type: "inc", itemId: "b" }];
  assert.equal(items.find((i) => i.id === "a")?.count, 1);
  assert.equal(items.find((i) => i.id === "b")?.count, 6);

  // Undo は直近（b）から取り消す
  ({ items, history } = undoTally(items, history));
  assert.equal(items.find((i) => i.id === "b")?.count, 5);
  assert.equal(history.length, 1);

  // さらに Undo で a も戻る
  ({ items, history } = undoTally(items, history));
  assert.equal(items.find((i) => i.id === "a")?.count, 0);

  // 履歴が空の Undo は何もしない（0 未満に落ちない）
  ({ items, history } = undoTally(items, history));
  assert.equal(items.find((i) => i.id === "a")?.count, 0);
  assert.equal(history.length, 0);
});

test("タリー: カウント修正(set)の Undo と削除済み頒布物の読み飛ばし", () => {
  const a = { id: "a", name: "新刊A", carryIn: null, count: 3 };
  const b = { id: "b", name: "既刊B", carryIn: null, count: 1 };
  let items = [a, b];
  let history = [];

  // カウント修正 3 → 10
  items = applyTallyEvent(items, { type: "set", itemId: "a", from: 3, to: 10 });
  history = [...history, { type: "set", itemId: "a", from: 3, to: 10 }];
  items = applyTallyEvent(items, { type: "inc", itemId: "b" });
  history = [...history, { type: "inc", itemId: "b" }];

  // b を削除した後の Undo は、b のイベントを読み飛ばして a の set を取り消す
  items = items.filter((i) => i.id !== "b");
  ({ items, history } = undoTally(items, history));
  assert.equal(items.find((i) => i.id === "a")?.count, 3);
  assert.equal(history.length, 0);
});

test("remainingCopies: 残り部数は搬入数設定時のみ・0 で止まる", () => {
  assert.equal(remainingCopies({ id: "a", name: "x", carryIn: null, count: 5 }), null);
  assert.equal(remainingCopies({ id: "a", name: "x", carryIn: 30, count: 5 }), 25);
  assert.equal(remainingCopies({ id: "a", name: "x", carryIn: 30, count: 31 }), 0);
});
