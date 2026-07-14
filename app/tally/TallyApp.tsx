"use client";

// 頒布タリー（/tally）— 「朱墨の帳場」の押印面。
// 設計原則: 屋内の暗めの会場・立ちっぱなし・片手・視線は目の前のお客さん。
// ＋1 は全幅の「角印」（判を捺す行為）として下部に固定し、それ以外の操作は
// すべて勘定面（上半分）に隔離。角印との間に24px以上の不感帯を置く。
// 確認ダイアログでなく Undo で冗長性を確保（連打はそのまま加算）。

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  applyTallyEvent,
  formatChobo,
  remainingCopies,
  undoTally,
  type TallyEvent,
  type TallyItem,
} from "@/lib/soneki";
import {
  clearTally,
  deriveSimMoney,
  loadSim,
  loadTally,
  saveTally,
  storageAvailable,
  type SimMoneyResult,
} from "../storage";

const HISTORY_LIMIT = 300;

let idSeq = 0;
function newId(): string {
  idSeq += 1;
  return `i-${Date.now().toString(36)}-${idSeq}`;
}

/** 画面ロック抑止（Screen Wake Lock API）の最小型。対応端末のみ機能を出す。 */
interface WakeLockSentinelLike {
  release: () => Promise<void>;
}
type NavigatorWithWakeLock = Navigator & {
  wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinelLike> };
};

/** カウント修正の直接入力（blur/Enter で確定し、Undo 可能な set イベントとして積む）。 */
function CountFix({
  id,
  item,
  onCommit,
}: {
  id: string;
  item: TallyItem;
  onCommit: (to: number) => void;
}) {
  const [draft, setDraft] = useState(String(item.count));
  useEffect(() => {
    setDraft(String(item.count));
  }, [item.count]);
  const commit = (): void => {
    const n = Number(draft);
    if (Number.isInteger(n) && n >= 0 && n !== item.count) {
      onCommit(n);
    } else {
      setDraft(String(item.count));
    }
  };
  return (
    <input
      id={id}
      type="number"
      inputMode="numeric"
      min="0"
      step="1"
      className="kinyu-input suji"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/** items と Undo 履歴は 1 つの state で持ち、常に原子的に更新する（連打時の不整合防止）。 */
interface TallyData {
  items: TallyItem[];
  history: TallyEvent[];
}

export function TallyApp() {
  const [data, setData] = useState<TallyData>({ items: [], history: [] });
  const { items, history } = data;
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showMoney, setShowMoney] = useState(false);

  const [loaded, setLoaded] = useState(false);
  const [storageOk, setStorageOk] = useState(true);
  const [restored, setRestored] = useState(false);
  const [restoreDismissed, setRestoreDismissed] = useState(false);
  const [online, setOnline] = useState(true);
  const [seiriOpen, setSeiriOpen] = useState(false);
  const [suteppaOpen, setSuteppaOpen] = useState(false);
  const [tsuikaOpen, setTsuikaOpen] = useState(false);
  const [modoshita, setModoshita] = useState(0); // 「戻しました」表示（0=非表示）
  const [kingakuNote, setKingakuNote] = useState(false); // 金額ON初回の注意書き
  const [simMoney, setSimMoney] = useState<SimMoneyResult>({
    ok: false,
    reason: "not-configured",
  });

  // ＋追加のインライン3欄（別画面に飛ばない）
  const [newName, setNewName] = useState("");
  const [newPrice, setNewPrice] = useState("");
  const [newCarry, setNewCarry] = useState("");

  const [wakeSupported, setWakeSupported] = useState(false);
  const [keepAwake, setKeepAwake] = useState(false);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const chipsRef = useRef<HTMLDivElement | null>(null);

  // アクティブな頒布物のツメが横スクロール外にあれば見える位置へ寄せる
  useEffect(() => {
    const chip = chipsRef.current?.querySelector('[aria-pressed="true"]');
    chip?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  // --- 復元・保存 -----------------------------------------------------------

  useEffect(() => {
    const ok = storageAvailable();
    setStorageOk(ok);
    if (ok) {
      const saved = loadTally();
      if (saved !== null && saved.items.length > 0) {
        setData({ items: saved.items, history: saved.history });
        setActiveId(
          saved.activeId !== null &&
            saved.items.some((i) => i.id === saved.activeId)
            ? saved.activeId
            : (saved.items[0]?.id ?? null),
        );
        setShowMoney(saved.showMoney);
        setRestored(true);
      }
      setSimMoney(deriveSimMoney(loadSim()));
    }
    setWakeSupported("wakeLock" in navigator);
    setOnline(navigator.onLine);
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded || !storageOk) return;
    saveTally({
      v: 1,
      items: data.items,
      history: data.history,
      activeId,
      showMoney,
    });
  }, [data, activeId, showMoney, loaded, storageOk]);

  // --- オフライン監視（エラー扱いしない: 電波がなくて当たり前の道具） --------

  useEffect(() => {
    const on = (): void => setOnline(true);
    const off = (): void => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  // --- Screen Wake Lock（任意・対応端末のみ） -------------------------------

  const requestWakeLock = useCallback(async (): Promise<void> => {
    try {
      const nav = navigator as NavigatorWithWakeLock;
      if (nav.wakeLock === undefined) return;
      wakeLockRef.current = await nav.wakeLock.request("screen");
    } catch {
      // 省電力モード等で拒否されることがある（機能は任意なので黙って続行）
    }
  }, []);
  const releaseWakeLock = useCallback((): void => {
    void wakeLockRef.current?.release().catch(() => undefined);
    wakeLockRef.current = null;
  }, []);
  useEffect(() => {
    if (!keepAwake) return;
    const onVisible = (): void => {
      if (document.visibilityState === "visible") {
        void requestWakeLock();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      releaseWakeLock();
    };
  }, [keepAwake, requestWakeLock, releaseWakeLock]);

  // --- 操作 -----------------------------------------------------------------

  const active = items.find((i) => i.id === activeId) ?? null;

  const pushEvent = (ev: TallyEvent): void => {
    setData((prev) => ({
      items: applyTallyEvent(prev.items, ev),
      history: [...prev.history, ev].slice(-HISTORY_LIMIT),
    }));
  };

  const increment = (): void => {
    if (active === null) return;
    pushEvent({ type: "inc", itemId: active.id });
    // 捺印フィードバック: カウントは即時更新・振動は存在チェックのみの漸進的強化
    navigator.vibrate?.(10);
  };

  const undo = (): void => {
    setData((prev) => undoTally(prev.items, prev.history));
    setModoshita((k) => k + 1);
  };
  // 「戻しました」を2秒で消す
  useEffect(() => {
    if (modoshita === 0) return;
    const t = setTimeout(() => setModoshita(0), 2000);
    return () => clearTimeout(t);
  }, [modoshita]);

  /** ツメ帯のインライン3欄から頒布物を記帳する。 */
  const addItemFromForm = (): void => {
    const name = newName.trim() === "" ? `頒布物${items.length + 1}` : newName;
    const priceN = Number(newPrice);
    const carryN = Number(newCarry);
    const item: TallyItem = {
      id: newId(),
      name,
      carryIn:
        newCarry.trim() !== "" && Number.isInteger(carryN) && carryN >= 0
          ? carryN
          : null,
      count: 0,
      price:
        newPrice.trim() !== "" && Number.isFinite(priceN) && priceN >= 0
          ? priceN
          : null,
    };
    setData((prev) => ({ ...prev, items: [...prev.items, item] }));
    setActiveId(item.id);
    setNewName("");
    setNewPrice("");
    setNewCarry("");
    setTsuikaOpen(false);
  };

  const updateItem = (id: string, patch: Partial<TallyItem>): void => {
    setData((prev) => ({
      ...prev,
      items: prev.items.map((i) => (i.id === id ? { ...i, ...patch } : i)),
    }));
  };

  const deleteItem = (id: string): void => {
    const target = items.find((i) => i.id === id);
    if (target === undefined) return;
    if (!window.confirm(`「${target.name}」を削除しますか？記帳も消えます。`))
      return;
    const next = items.filter((i) => i.id !== id);
    setData((prev) => ({
      ...prev,
      items: prev.items.filter((i) => i.id !== id),
    }));
    if (activeId === id) {
      setActiveId(next[0]?.id ?? null);
    }
  };

  const resetAll = (): void => {
    if (
      !window.confirm(
        "すべての頒布物の記帳を 0 に戻しますか？この操作は取り消せません。",
      )
    ) {
      return;
    }
    setData((prev) => ({
      items: prev.items.map((i) => ({ ...i, count: 0 })),
      history: [],
    }));
  };

  const restartAll = (): void => {
    if (!window.confirm("前回の記帳を消して最初からやり直しますか？")) return;
    clearTally();
    setData({ items: [], history: [] });
    setActiveId(null);
    setRestored(false);
    setRestoreDismissed(true);
  };

  // --- 表示 -----------------------------------------------------------------

  const remaining = active === null ? null : remainingCopies(active);
  const soldOut =
    active !== null &&
    active.carryIn !== null &&
    active.carryIn > 0 &&
    remaining === 0;
  const totalCount = items.reduce((acc, i) => acc + i.count, 0);

  // シミュレータの保存入力に不正がある場合はその頒価・費用を一切使わない
  const simInvalid = !simMoney.ok && simMoney.reason === "invalid";
  const simPrice = simMoney.ok ? simMoney.price : null;

  /** 頒布物の実効頒価（頒布物ごとの設定 → 帳面（シミュレータ）の頒価の順）。 */
  const unitPriceOf = (item: TallyItem): number | null =>
    item.price ?? simPrice;
  const activePrice = active === null ? null : unitPriceOf(active);
  const allPriced =
    items.length > 0 && items.every((i) => unitPriceOf(i) !== null);
  const totalRevenue = allPriced
    ? // allPriced 分岐内なので unitPriceOf は non-null（?? 0 は型絞り込み用で到達しない）
      items.reduce((acc, i) => acc + i.count * (unitPriceOf(i) ?? 0), 0)
    : null;

  return (
    <div className="tally-men">
      <a className="tobira" href="#tally-honmon">
        本文へ飛ぶ
      </a>

      {/* 帳頭 */}
      <header className="tally-gashira">
        <Link className="modoru" href="/">
          ← 帳面へ
        </Link>
        <span className="dai">当日の記帳</span>
        <label className="kingaku-switch">
          金額
          <input
            type="checkbox"
            checked={showMoney}
            onChange={(e) => {
              setShowMoney(e.target.checked);
              if (e.target.checked) setKingakuNote(true);
            }}
          />
          {showMoney && <span aria-hidden="true">入</span>}
        </label>
      </header>

      <main
        id="tally-honmon"
        tabIndex={-1}
        style={{
          outline: "none",
          display: "flex",
          flexDirection: "column",
          flex: 1,
          minHeight: 0,
        }}
      >
        <h1 className="sr-only">即売会頒布カウンター</h1>

        {restored && !restoreDismissed && (
          <div className="fukugen" role="status">
            <span>前回の記帳を開きました</span>
            <span className="migiyose">
              <button
                type="button"
                className="bt bt-sub bt-sm"
                onClick={restartAll}
              >
                白紙に戻す
              </button>
              <button
                type="button"
                className="bt-kesu"
                aria-label="この知らせを閉じる"
                onClick={() => setRestoreDismissed(true)}
              >
                ×
              </button>
            </span>
          </div>
        )}
        {loaded && !storageOk && (
          <div className="fusen fusen-shu" role="status">
            ※ この環境では保存できません。ページを閉じると記帳が消えます。
          </div>
        )}

        {/* ツメ帯（頒布物切替・＋追加のインライン展開） */}
        {items.length > 0 && (
          <div
            className="tsume-tai"
            role="group"
            aria-label="頒布物の切替"
            ref={chipsRef}
          >
            {items.map((i) => {
              const zan = remainingCopies(i);
              const iSold = i.carryIn !== null && i.carryIn > 0 && zan === 0;
              return (
                <button
                  key={i.id}
                  type="button"
                  className="tsume"
                  aria-pressed={i.id === activeId}
                  onClick={() => setActiveId(i.id)}
                >
                  <span>{i.name}</span>
                  {iSold ? (
                    <span className="fuda">完売</span>
                  ) : (
                    zan !== null && <span className="suji">残{zan}</span>
                  )}
                  {zan === null && <span className="suji">{i.count}</span>}
                </button>
              );
            })}
            <button
              type="button"
              className="tsume"
              onClick={() => setTsuikaOpen((v) => !v)}
              aria-expanded={tsuikaOpen}
            >
              ＋追加
            </button>
          </div>
        )}

        {tsuikaOpen && (
          <div className="tsuika-ran">
            <div className="kinyu">
              <label className="ran" htmlFor="new-name">
                頒布物の名前
              </label>
              <input
                id="new-name"
                type="text"
                className="kinyu-input"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={`頒布物${items.length + 1}`}
              />
            </div>
            <div className="narabi">
              <div className="kinyu">
                <label className="ran" htmlFor="new-price">
                  頒価（円・任意）
                </label>
                <input
                  id="new-price"
                  type="number"
                  inputMode="numeric"
                  min="0"
                  className="kinyu-input suji"
                  value={newPrice}
                  onChange={(e) => setNewPrice(e.target.value)}
                  placeholder={simPrice === null ? "" : String(simPrice)}
                />
              </div>
              <div className="kinyu">
                <label className="ran" htmlFor="new-carry">
                  搬入数（部・任意）
                </label>
                <input
                  id="new-carry"
                  type="number"
                  inputMode="numeric"
                  min="0"
                  step="1"
                  className="kinyu-input suji"
                  value={newCarry}
                  onChange={(e) => setNewCarry(e.target.value)}
                />
              </div>
            </div>
            <div style={{ display: "flex", gap: "var(--ma-2)" }}>
              <button
                type="button"
                className="bt bt-main"
                onClick={addItemFromForm}
              >
                記帳する
              </button>
              <button
                type="button"
                className="bt bt-sub"
                onClick={() => setTsuikaOpen(false)}
              >
                やめる
              </button>
            </div>
          </div>
        )}

        {/* 勘定面（上半分・＋1以外の操作はここに隔離） */}
        {items.length === 0 && loaded ? (
          <div className="kanjo-men">
            <p className="sai">頒布物を記帳して、当日のカウントを始めます。</p>
            <button
              type="button"
              className="bt bt-main"
              onClick={() => setTsuikaOpen(true)}
              style={{ marginTop: "var(--ma-2)" }}
            >
              頒布物を追加
            </button>
            {tsuikaOpen && (
              <div className="tsuika-ran" style={{ marginTop: "var(--ma-2)" }}>
                <div className="kinyu">
                  <label className="ran" htmlFor="new-name-0">
                    頒布物の名前
                  </label>
                  <input
                    id="new-name-0"
                    type="text"
                    className="kinyu-input"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="頒布物1"
                  />
                </div>
                <div className="narabi">
                  <div className="kinyu">
                    <label className="ran" htmlFor="new-price-0">
                      頒価（円・任意）
                    </label>
                    <input
                      id="new-price-0"
                      type="number"
                      inputMode="numeric"
                      min="0"
                      className="kinyu-input suji"
                      value={newPrice}
                      onChange={(e) => setNewPrice(e.target.value)}
                      placeholder={simPrice === null ? "" : String(simPrice)}
                    />
                  </div>
                  <div className="kinyu">
                    <label className="ran" htmlFor="new-carry-0">
                      搬入数（部・任意）
                    </label>
                    <input
                      id="new-carry-0"
                      type="number"
                      inputMode="numeric"
                      min="0"
                      step="1"
                      className="kinyu-input suji"
                      value={newCarry}
                      onChange={(e) => setNewCarry(e.target.value)}
                    />
                  </div>
                </div>
                <div style={{ display: "flex", gap: "var(--ma-2)" }}>
                  <button
                    type="button"
                    className="bt bt-main"
                    onClick={addItemFromForm}
                  >
                    記帳する
                  </button>
                  <button
                    type="button"
                    className="bt bt-sub"
                    onClick={() => setTsuikaOpen(false)}
                  >
                    やめる
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : seiriOpen ? (
          /* 帳面の整理（管理系操作の隔離パネル） */
          <div className="kanjo-men">
            <div className="seiri">
              <h2>帳面の整理</h2>
              {items.map((i) => (
                <div key={i.id} className="seiri-gyo">
                  <div className="kinyu kinyu-na">
                    <label className="ran" htmlFor={`name-${i.id}`}>
                      名前
                    </label>
                    <input
                      id={`name-${i.id}`}
                      type="text"
                      className="kinyu-input"
                      value={i.name}
                      onChange={(e) =>
                        updateItem(i.id, { name: e.target.value })
                      }
                    />
                  </div>
                  <div className="kinyu kinyu-su">
                    <label className="ran" htmlFor={`price-${i.id}`}>
                      頒価（円）
                    </label>
                    <input
                      id={`price-${i.id}`}
                      type="number"
                      inputMode="numeric"
                      min="0"
                      className="kinyu-input suji"
                      placeholder={
                        simPrice === null ? "未設定" : String(simPrice)
                      }
                      value={
                        i.price === null || i.price === undefined
                          ? ""
                          : String(i.price)
                      }
                      onChange={(e) => {
                        const raw = e.target.value;
                        const n = Number(raw);
                        updateItem(i.id, {
                          price:
                            raw === "" || !Number.isFinite(n) || n < 0
                              ? null
                              : n,
                        });
                      }}
                    />
                  </div>
                  <div className="kinyu kinyu-su">
                    <label className="ran" htmlFor={`carry-${i.id}`}>
                      搬入数（部）
                    </label>
                    <input
                      id={`carry-${i.id}`}
                      type="number"
                      inputMode="numeric"
                      min="0"
                      step="1"
                      className="kinyu-input suji"
                      value={i.carryIn === null ? "" : String(i.carryIn)}
                      onChange={(e) => {
                        const raw = e.target.value;
                        const n = Number(raw);
                        updateItem(i.id, {
                          carryIn:
                            raw === "" || !Number.isInteger(n) || n < 0
                              ? null
                              : n,
                        });
                      }}
                    />
                  </div>
                  <div className="kinyu kinyu-su">
                    <label className="ran" htmlFor={`fix-${i.id}`}>
                      記帳の修正
                    </label>
                    <CountFix
                      id={`fix-${i.id}`}
                      item={i}
                      onCommit={(to) =>
                        pushEvent({
                          type: "set",
                          itemId: i.id,
                          from: i.count,
                          to,
                        })
                      }
                    />
                  </div>
                  <button
                    type="button"
                    className="bt-kesu"
                    onClick={() => deleteItem(i.id)}
                    aria-label={`${i.name}を削除`}
                  >
                    ×
                  </button>
                </div>
              ))}
              <div
                style={{
                  display: "flex",
                  gap: "var(--ma-2)",
                  flexWrap: "wrap",
                }}
              >
                <button
                  type="button"
                  className="bt bt-sub bt-sm"
                  onClick={() => {
                    setSeiriOpen(false);
                    setTsuikaOpen(true);
                  }}
                >
                  ＋ 頒布物を追加
                </button>
                <button
                  type="button"
                  className="shu-moji-bt"
                  onClick={resetAll}
                >
                  全リセット（記帳を0に）
                </button>
              </div>
              <div
                style={{
                  borderTop: "var(--rule-hoso)",
                  paddingTop: "var(--ma-2)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--ma-05)",
                }}
              >
                {wakeSupported && (
                  <label className="sumi-check">
                    <input
                      type="checkbox"
                      checked={keepAwake}
                      onChange={(e) => {
                        setKeepAwake(e.target.checked);
                        if (e.target.checked) {
                          void requestWakeLock();
                        }
                      }}
                    />
                    画面を点けたままにする
                  </label>
                )}
              </div>
              <div>
                <button
                  type="button"
                  className="bt bt-main"
                  onClick={() => setSeiriOpen(false)}
                >
                  整理を終える
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="kanjo-men">
            {active !== null && (
              <>
                {soldOut && (
                  <div className="kanbai-in" aria-hidden="true">
                    完売御礼
                  </div>
                )}
                <div className="tally-kazoe">
                  <span className="mae">頒布</span>
                  <span className="kazu">{active.count}</span>
                  <span className="mae">部</span>
                </div>
                {active.carryIn !== null && remaining !== null && (
                  <p className="tally-zan">
                    {soldOut ? (
                      <span>完売御礼。おつかれさまでした</span>
                    ) : (
                      <>
                        残{" "}
                        <span className={remaining <= 10 ? "wazuka" : ""}>
                          {remaining}
                        </span>{" "}
                        部 ／ 搬入{active.carryIn}
                        {remaining <= 10 && remaining > 0 && (
                          <span className="wazuka sai"> 残りわずか</span>
                        )}
                      </>
                    )}
                  </p>
                )}
                <span className="sr-only" aria-live="polite" aria-atomic="true">
                  {soldOut
                    ? `${active.name}、完売です`
                    : `${active.count}部目。${remaining !== null ? `残り${remaining}部` : active.name}`}
                </span>
                {modoshita > 0 && (
                  <p className="sai" role="status">
                    戻しました
                  </p>
                )}
                {showMoney && (
                  <div className="tally-shokei sai">
                    {simInvalid ? (
                      <p>
                        帳面（計算機）の入力に訂正があるため、損益を出せません。帳面で直してください
                      </p>
                    ) : (
                      <>
                        {activePrice !== null ? (
                          <p>
                            小計{" "}
                            {(active.count * activePrice).toLocaleString(
                              "ja-JP",
                            )}
                            円（{active.count}部 ×{" "}
                            {activePrice.toLocaleString("ja-JP")}円）
                          </p>
                        ) : (
                          <p>
                            この頒布物の頒価が未設定です。整理か帳面で頒価を入れると小計が出ます
                          </p>
                        )}
                        {totalRevenue !== null && (
                          <p>
                            全体 実売{totalCount}部・手取り{" "}
                            {totalRevenue.toLocaleString("ja-JP")}円
                            {simMoney.ok && (
                              <>
                                ・現在損益{" "}
                                <span
                                  className={
                                    totalRevenue - simMoney.baseCost < 0
                                      ? "wazuka"
                                      : ""
                                  }
                                  aria-label={
                                    formatChobo(
                                      totalRevenue - simMoney.baseCost,
                                    ).aria
                                  }
                                >
                                  {
                                    formatChobo(
                                      totalRevenue - simMoney.baseCost,
                                    ).text
                                  }
                                  円
                                </span>
                              </>
                            )}
                          </p>
                        )}
                        {totalRevenue === null && items.length > 1 && (
                          <p>
                            頒価が未設定の頒布物があるため、全体の損益は出していません
                          </p>
                        )}
                      </>
                    )}
                    {kingakuNote && (
                      <p>
                        ※ 金額は既定で伏せています —
                        ブースの画面は買い手からも見えるため
                      </p>
                    )}
                  </div>
                )}

                {suteppaOpen ? (
                  <div className="suteppa">
                    <button
                      type="button"
                      className="bt bt-sub"
                      disabled={active.count <= 0}
                      onClick={() =>
                        pushEvent({
                          type: "set",
                          itemId: active.id,
                          from: active.count,
                          to: active.count - 1,
                        })
                      }
                      aria-label="1減らす"
                    >
                      −
                    </button>
                    <span className="ima suji">{active.count}</span>
                    <button
                      type="button"
                      className="bt bt-sub"
                      onClick={() =>
                        pushEvent({ type: "inc", itemId: active.id })
                      }
                      aria-label="1増やす"
                    >
                      ＋
                    </button>
                    <button
                      type="button"
                      className="bt bt-sub bt-sm"
                      onClick={() => setSuteppaOpen(false)}
                    >
                      閉じる
                    </button>
                  </div>
                ) : null}

                {/* 勘定面の最下行: 修正系（角印から不感帯を挟んで隔離） */}
                <div className="tally-sosa">
                  <button
                    type="button"
                    className="bt bt-sub bt-sm"
                    onClick={() => setSuteppaOpen((v) => !v)}
                  >
                    数を修正
                  </button>
                  <button
                    type="button"
                    className="bt bt-sub"
                    onClick={undo}
                    disabled={history.length === 0}
                  >
                    ひとつ戻す
                  </button>
                  <button
                    type="button"
                    className="bt bt-sub bt-sm"
                    onClick={() => setSeiriOpen(true)}
                  >
                    帳面の整理
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* 押印面（下部・全幅角印。上との間に不感帯24px以上） */}
        {items.length > 0 && !seiriOpen && (
          <div className="oshiin-men">
            <button
              type="button"
              className="oshiin"
              onClick={increment}
              disabled={active === null || soldOut}
            >
              {soldOut ? (
                <span className="osu-ji">完売</span>
              ) : (
                <>
                  <span className="osu-kazu">＋１</span>
                  <span className="osu-ji">頒布</span>
                </>
              )}
            </button>
            {soldOut && (
              <p
                className="sai"
                role="status"
                style={{ textAlign: "center", marginTop: "var(--ma-1)" }}
              >
                完売済みです。戻す場合は［ひとつ戻す］
              </p>
            )}
          </div>
        )}

        {/* 状態行 */}
        <p className={`tally-jotai${online ? "" : " is-offline"}`}>
          {!storageOk
            ? "この環境では保存されません — 記帳はページを閉じるまで有効"
            : online
              ? "記帳中・端末に保存済み"
              : "オフライン記帳中・端末に保存済み"}
        </p>
      </main>
    </div>
  );
}
