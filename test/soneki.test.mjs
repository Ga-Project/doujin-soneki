// doujin-soneki — 中核ロジックの単体テスト（node:test 標準ランナー・追加依存なし）。
// 実行: pnpm test（Node が .ts を型ストリップして読み込む）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseNum,
  parseCopies,
  parseFeePercent,
  parseOptionalYen,
  MAX_COPIES,
  tableStep,
  normalizeTier,
  pickTierForCopies,
  parseChannelParams,
  parsePlannedCopies,
  activeChannelIds,
  resolveMainChannelId,
  deriveSimMoneyCore,
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
  // 実務上限（DOM 生成の安全弁）: 上限ちょうどは可・超過は不可
  assert.equal(parseCopies(String(MAX_COPIES)), MAX_COPIES);
  assert.equal(parseCopies(String(MAX_COPIES + 1)), null);
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
  assert.equal(
    normalizeTier({ copies: "100", unit: "", total: "", basis: "unit" }),
    null,
  );
  assert.equal(
    normalizeTier({ copies: "", unit: "320", total: "", basis: "unit" }),
    null,
  );
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

test("parseChannelParams: 定額手数料の不正入力はチャネル無効（黙って 0 にしない）", () => {
  // 正常系: 率 + 定額
  assert.deepEqual(parseChannelParams("consign", "30", "45"), {
    ok: true,
    params: { feeRate: 0.3, perItemFee: 45 },
  });
  // 定額が空 = 0 扱い
  assert.deepEqual(parseChannelParams("consign", "30", ""), {
    ok: true,
    params: { feeRate: 0.3, perItemFee: 0 },
  });
  // 定額の負値・数値でない入力は per-item-invalid（0 に置換して計算を続けない）
  assert.deepEqual(parseChannelParams("consign", "30", "-45"), {
    ok: false,
    reason: "per-item-invalid",
  });
  assert.deepEqual(parseChannelParams("consign", "30", "abc"), {
    ok: false,
    reason: "per-item-invalid",
  });
  // 率側の既存経路: 空は入力待ち（fee-empty）、範囲外は不正（fee-invalid）
  assert.deepEqual(parseChannelParams("consign", "", "0"), {
    ok: false,
    reason: "fee-empty",
  });
  assert.deepEqual(parseChannelParams("consign", "101", "0"), {
    ok: false,
    reason: "fee-invalid",
  });
  // 会場頒布は常に手数料 0 / 定額 0
  assert.deepEqual(parseChannelParams("direct", "", ""), {
    ok: true,
    params: { feeRate: 0, perItemFee: 0 },
  });
});

test("parseOptionalYen: 空欄は 0・不正な非空値は null（黙って 0 にしない）", () => {
  assert.equal(parseOptionalYen(""), 0);
  assert.equal(parseOptionalYen("  "), 0);
  assert.equal(parseOptionalYen("6000"), 6000);
  assert.equal(parseOptionalYen("0"), 0);
  // 負値・数値でない入力（固定費に貼り付けた -500 や e など）は null → 計算をブロック
  assert.equal(parseOptionalYen("-500"), null);
  assert.equal(parseOptionalYen("e"), null);
  assert.equal(parseOptionalYen("abc"), null);
});

test("parsePlannedCopies: 空欄/0 は配分しない・不正は黙ってスキップせず無効", () => {
  // 空欄・0 = 配分しない（意図された既定）
  assert.deepEqual(parsePlannedCopies(""), { ok: true, copies: null });
  assert.deepEqual(parsePlannedCopies("0"), { ok: true, copies: null });
  // 正常
  assert.deepEqual(parsePlannedCopies("150"), { ok: true, copies: 150 });
  // 負値・小数・数値でない・上限超過は ok:false（配分計算をブロック）
  assert.deepEqual(parsePlannedCopies("-10"), { ok: false });
  assert.deepEqual(parsePlannedCopies("1.5"), { ok: false });
  assert.deepEqual(parsePlannedCopies("e"), { ok: false });
  assert.deepEqual(parsePlannedCopies(String(MAX_COPIES + 1)), { ok: false });
});

test("deriveSimMoneyCore: 保存済み入力の不正は 0 扱いせず invalid を返す", () => {
  const base = {
    price: "500",
    tiers: [{ id: "t1", copies: "200", unit: "180", total: "", basis: "unit" }],
    selectedTierId: "t1",
    fixedEvent: "6000",
    fixedOther: "",
  };
  // 正常: baseCost = 36000 + 6000
  assert.deepEqual(deriveSimMoneyCore(base), {
    ok: true,
    price: 500,
    baseCost: 42000,
  });
  // 未入力（頒価が空）は not-configured（案内表示）
  assert.deepEqual(deriveSimMoneyCore({ ...base, price: "" }), {
    ok: false,
    reason: "not-configured",
  });
  assert.deepEqual(deriveSimMoneyCore(null), {
    ok: false,
    reason: "not-configured",
  });
  // 保存済みの不正固定費は 0 扱いにせず invalid（tally 側は損益をブロック）
  assert.deepEqual(deriveSimMoneyCore({ ...base, fixedEvent: "-500" }), {
    ok: false,
    reason: "invalid",
  });
  assert.deepEqual(deriveSimMoneyCore({ ...base, fixedOther: "abc" }), {
    ok: false,
    reason: "invalid",
  });
  // 非空で不正な頒価も invalid
  assert.deepEqual(deriveSimMoneyCore({ ...base, price: "-100" }), {
    ok: false,
    reason: "invalid",
  });
  // 選択行に入力があるのに不成立 = invalid、行が全部空 = not-configured
  assert.deepEqual(
    deriveSimMoneyCore({
      ...base,
      tiers: [{ id: "t1", copies: "200", unit: "", total: "", basis: "unit" }],
    }),
    { ok: false, reason: "invalid" },
  );
  assert.deepEqual(
    deriveSimMoneyCore({
      ...base,
      tiers: [{ id: "t1", copies: "", unit: "", total: "", basis: "unit" }],
    }),
    { ok: false, reason: "not-configured" },
  );
});

test("activeChannelIds / resolveMainChannelId: 主チャネルは計算対象と常に一致する", () => {
  const direct = {
    id: "direct",
    kind: "direct",
    fee: "0",
    perItem: "0",
    visible: true,
  };
  const c1 = {
    id: "c1",
    kind: "consign",
    fee: "30",
    perItem: "0",
    visible: true,
  };
  const c2 = {
    id: "c2",
    kind: "consign",
    fee: "",
    perItem: "0",
    visible: true,
  }; // 手数料未入力
  const c3 = {
    id: "c3",
    kind: "consign",
    fee: "10",
    perItem: "0",
    visible: false,
  }; // 表示OFF
  const c4 = {
    id: "c4",
    kind: "consign",
    fee: "20",
    perItem: "0",
    visible: true,
  }; // 4行目

  // 対象 = 表示ON・入力有効。手数料未入力(c2)・表示OFF(c3)は対象外
  assert.deepEqual(activeChannelIds([direct, c1, c2, c3], 3), ["direct", "c1"]);
  // 委託は先頭から3行まで（c4 は4行目なので有効入力でも対象外）
  assert.deepEqual(activeChannelIds([direct, c1, c2, c3, c4], 3), [
    "direct",
    "c1",
  ]);
  assert.deepEqual(activeChannelIds([direct, c1, c4], 3), [
    "direct",
    "c1",
    "c4",
  ]);

  // 選択が対象内ならそのまま
  assert.equal(resolveMainChannelId([direct, c1], 3, "c1"), "c1");
  // 表示OFFで対象から外れたら先頭の有効チャネルへ付け替え
  assert.equal(resolveMainChannelId([direct, c3], 3, "c3"), "direct");
  // 手数料未入力の委託を選んでいた場合も付け替え
  assert.equal(resolveMainChannelId([direct, c2], 3, "c2"), "direct");
  // 有効チャネルが1つも無ければ現状維持（系列は描かれない）
  assert.equal(
    resolveMainChannelId([{ ...direct, visible: false }, c2], 3, "c2"),
    "c2",
  );
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
  assert.equal(
    breakEvenCopies(500, { feeRate: 1, perItemFee: 0 }, 42000),
    null,
  );
  assert.equal(
    breakEvenCopies(100, { feeRate: 0, perItemFee: 100 }, 42000),
    null,
  );
  // 厳密交点はグラフマーカー用（非整数のまま返る）
  assert.equal(breakEvenExact(500, direct, 42100), 84.2);
});

test("profitAt / selloutProfit / perCopyAtSellout: 損益と 1 冊あたり", () => {
  const direct = { feeRate: 0, perItemFee: 0 };
  // 0 部時点は費用の全額がマイナス
  assert.equal(profitAt(0, 500, direct, 42000), -42000);
  assert.equal(selloutProfit(200, 500, direct, 42000), 58000);
  // 赤字ケース
  assert.equal(
    selloutProfit(100, 300, { feeRate: 0.3, perItemFee: 0 }, 28000),
    -7000,
  );
  // 1 冊あたり = 完売損益 ÷ 部数（四捨五入）
  assert.equal(
    perCopyAtSellout(320, 400, { feeRate: 0.3, perItemFee: 0 }, 77200),
    39,
  );
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

test("tableStep: 損益表の刻み幅は 25 部基準・大部数でも 40 行程度に収まる", () => {
  // 小部数は 25 部刻みのまま
  assert.equal(tableStep(200), 25);
  assert.equal(tableStep(800), 25);
  // 大部数はキリ値（1/2/5×10^n）へ自動拡大し、行数 = copies/step + 1 が 41 行以下
  for (const copies of [1000, 2000, 10000, 54321, MAX_COPIES]) {
    const step = tableStep(copies);
    assert.ok(
      Math.floor(copies / step) + 1 <= 41,
      `${copies}部で${step}刻みは行数過多`,
    );
  }
  assert.equal(tableStep(1000), 50);
  assert.equal(tableStep(MAX_COPIES), 5000);
});

test("niceStep / tickValues: 軸目盛はキリ値（1/2/5×10^n）", () => {
  assert.equal(niceStep(200, 4), 50);
  assert.equal(niceStep(1000, 5), 200);
  assert.equal(niceStep(70000, 5), 20000);
  assert.deepEqual(tickValues(0, 200, 4), [0, 50, 100, 150, 200]);
  // 負域を含む範囲でも step の整数倍（0 を含む）
  assert.deepEqual(
    tickValues(-42000, 58000, 5),
    [-40000, -20000, 0, 20000, 40000],
  );
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
  assert.equal(
    remainingCopies({ id: "a", name: "x", carryIn: null, count: 5 }),
    null,
  );
  assert.equal(
    remainingCopies({ id: "a", name: "x", carryIn: 30, count: 5 }),
    25,
  );
  assert.equal(
    remainingCopies({ id: "a", name: "x", carryIn: 30, count: 31 }),
    0,
  );
});
