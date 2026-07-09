"use client";

// 頒布タリー（/tally）— 即売会当日の相棒。
// 設計原則: 片手・親指・ノールック寄り。「一瞬で読めて、確実に押せて、間違えても戻せる」。
// 破壊操作（削除・全リセット）は編集パネルに隔離し confirm 必須。カウント動線には置かない。

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  applyTallyEvent,
  formatSignedYen,
  formatYen,
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
  type SimMoneyParams,
} from "../storage";
import { BrandMark } from "../chrome";

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

/** カウント修正の入力（blur/Enter で確定し、Undo 可能な set イベントとして積む）。 */
function CountFix({
  item,
  onCommit,
}: {
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
      type="number"
      inputMode="numeric"
      min="0"
      step="1"
      className="tabular"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.currentTarget.blur();
        }
      }}
      aria-label={`${item.name}のカウント修正`}
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
  const [editMode, setEditMode] = useState(false);
  const [popKey, setPopKey] = useState(0);
  const [simMoney, setSimMoney] = useState<SimMoneyParams | null>(null);

  const [wakeSupported, setWakeSupported] = useState(false);
  const [keepAwake, setKeepAwake] = useState(false);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);

  // --- 復元・保存 -----------------------------------------------------------

  useEffect(() => {
    const ok = storageAvailable();
    setStorageOk(ok);
    if (ok) {
      const saved = loadTally();
      if (saved !== null && saved.items.length > 0) {
        setData({ items: saved.items, history: saved.history });
        setActiveId(
          saved.activeId !== null && saved.items.some((i) => i.id === saved.activeId)
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
    saveTally({ v: 1, items: data.items, history: data.history, activeId, showMoney });
  }, [data, activeId, showMoney, loaded, storageOk]);

  // --- オフライン監視 --------------------------------------------------------

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
    setPopKey((k) => k + 1);
    if ("vibrate" in navigator) {
      navigator.vibrate(10);
    }
  };

  const undo = (): void => {
    setData((prev) => undoTally(prev.items, prev.history));
  };

  const addItem = (): void => {
    const item: TallyItem = {
      id: newId(),
      name: `頒布物${items.length + 1}`,
      carryIn: null,
      count: 0,
    };
    setData((prev) => ({ ...prev, items: [...prev.items, item] }));
    setActiveId(item.id);
    setEditMode(true);
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
    if (!window.confirm(`「${target.name}」を削除しますか？カウントも消えます。`)) return;
    const next = items.filter((i) => i.id !== id);
    setData((prev) => ({ ...prev, items: prev.items.filter((i) => i.id !== id) }));
    if (activeId === id) {
      setActiveId(next[0]?.id ?? null);
    }
  };

  const resetAll = (): void => {
    if (!window.confirm("すべての頒布物のカウントを 0 に戻しますか？この操作は取り消せません。")) {
      return;
    }
    setData((prev) => ({
      items: prev.items.map((i) => ({ ...i, count: 0 })),
      history: [],
    }));
  };

  const restartAll = (): void => {
    if (!window.confirm("前回の記録を消して最初からやり直しますか？")) return;
    clearTally();
    setData({ items: [], history: [] });
    setActiveId(null);
    setRestored(false);
    setRestoreDismissed(true);
  };

  // --- 表示 -----------------------------------------------------------------

  const remaining = active === null ? null : remainingCopies(active);
  const soldOut = active !== null && active.carryIn !== null && active.carryIn > 0 && remaining === 0;
  const totalCount = items.reduce((acc, i) => acc + i.count, 0);

  return (
    <div className="tally-page">
      <a className="skip-link" href="#tally-main">
        本文へスキップ
      </a>

      <header className="tally-header">
        <Link className="brand" href="/">
          <span className="brand-mark" aria-hidden="true">
            <BrandMark size={11} />
          </span>
          <span>同人ソンエキ</span>
        </Link>
        <Link className="to-sim" href="/">
          計算機へ
        </Link>
      </header>

      <main
        id="tally-main"
        tabIndex={-1}
        style={{ outline: "none", display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}
      >
        <h1 className="sr-only">即売会頒布カウンター</h1>

        {restored && !restoreDismissed && (
          <div className="alert restore-bar" role="status" style={{ margin: "var(--sp-3) var(--sp-4) 0" }}>
            <span>前回の記録を復元しました</span>
            <button type="button" className="btn btn-secondary" onClick={restartAll}>
              最初からやり直す
            </button>
            <button
              type="button"
              className="btn btn-ghost dismiss"
              aria-label="この通知を閉じる"
              onClick={() => setRestoreDismissed(true)}
            >
              ×
            </button>
          </div>
        )}
        {loaded && !storageOk && (
          <div className="alert alert-warn" role="status" style={{ margin: "var(--sp-3) var(--sp-4) 0" }}>
            この環境ではデータを保存できません。ページを閉じると記録が消えます
          </div>
        )}

        {/* 頒布物チップ列（+1 ゾーンから最も遠い上端） */}
        {items.length > 0 && (
          <div className="tally-chips" role="group" aria-label="頒布物の切替">
            {items.map((i) => (
              <button
                key={i.id}
                type="button"
                className="tchip"
                aria-pressed={i.id === activeId}
                onClick={() => setActiveId(i.id)}
              >
                <span>{i.name}</span>
                <span className="tchip-count tabular">{i.count}</span>
              </button>
            ))}
          </div>
        )}

        {/* カウントステージ / 編集パネル */}
        {items.length === 0 && loaded ? (
          <div className="tally-stage">
            <div className="empty-state">
              <span className="card-icon" aria-hidden="true">
                ⊕
              </span>
              <h3>頒布物を登録して、当日のカウントを始めましょう</h3>
              <button type="button" className="btn btn-primary" onClick={addItem}>
                頒布物を追加
              </button>
            </div>
          </div>
        ) : editMode ? (
          <div className="tally-stage">
            <div className="tally-edit">
              <h2>頒布物を編集</h2>
              {items.map((i) => (
                <div key={i.id} className="tally-edit-row">
                  <div className="field">
                    <label htmlFor={`name-${i.id}`}>名前</label>
                    <input
                      id={`name-${i.id}`}
                      type="text"
                      value={i.name}
                      onChange={(e) => updateItem(i.id, { name: e.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={`carry-${i.id}`}>搬入数</label>
                    <input
                      id={`carry-${i.id}`}
                      type="number"
                      inputMode="numeric"
                      min="0"
                      step="1"
                      className="tabular"
                      value={i.carryIn === null ? "" : String(i.carryIn)}
                      onChange={(e) => {
                        const raw = e.target.value;
                        const n = Number(raw);
                        updateItem(i.id, {
                          carryIn:
                            raw === "" || !Number.isInteger(n) || n < 0 ? null : n,
                        });
                      }}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={`fix-${i.id}`}>カウント修正</label>
                    <CountFix
                      item={i}
                      onCommit={(to) =>
                        pushEvent({ type: "set", itemId: i.id, from: i.count, to })
                      }
                    />
                  </div>
                  <button
                    type="button"
                    className="btn-icon"
                    onClick={() => deleteItem(i.id)}
                    aria-label={`${i.name}を削除`}
                  >
                    ×
                  </button>
                </div>
              ))}
              <div className="tally-edit-actions">
                <button type="button" className="btn btn-secondary" onClick={addItem}>
                  ＋ 頒布物を追加
                </button>
                <button type="button" className="link-danger" onClick={resetAll}>
                  全リセット（カウントを 0 に）
                </button>
              </div>
              <div className="tally-settings">
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={showMoney}
                    onChange={(e) => setShowMoney(e.target.checked)}
                  />
                  金額を表示（手取り・現在損益）
                </label>
                {wakeSupported && (
                  <label className="check-label">
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
                <button type="button" className="btn btn-primary" onClick={() => setEditMode(false)}>
                  編集を終える
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="tally-stage">
            {active !== null && (
              <>
                <p className="tally-item-name">{active.name}</p>
                {active.carryIn !== null && remaining !== null && (
                  <div className="tally-remaining">
                    {soldOut ? (
                      <span className="badge badge-ok">完売！</span>
                    ) : (
                      <span className="tabular">残り {remaining}部</span>
                    )}
                    <div className="tally-progress" aria-hidden="true">
                      <span
                        style={{
                          width: `${Math.min(100, (active.count / Math.max(1, active.carryIn)) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                )}
                <div className="tally-count-wrap">
                  <div
                    key={popKey}
                    className={`tally-count tabular${popKey > 0 ? " pop" : ""}`}
                  >
                    {active.count}
                  </div>
                  {popKey > 0 && (
                    <span key={`t${popKey}`} className="tap-toast tabular" aria-hidden="true">
                      ＋1
                    </span>
                  )}
                </div>
                <span className="sr-only" aria-live="polite" aria-atomic="true">
                  {active.name} {active.count}部
                </span>
                {soldOut && <p className="tally-money">完売おめでとうございます！</p>}
                {showMoney && (
                  <p className="tally-money tabular">
                    {simMoney !== null ? (
                      <>
                        実売 {totalCount}部 ・ 手取り {formatYen(totalCount * simMoney.price)} ・
                        現在損益{" "}
                        {formatSignedYen(totalCount * simMoney.price - simMoney.baseCost)}
                        （計算機の入力にもとづく概算）
                      </>
                    ) : (
                      "計算機で頒価と印刷費を入力すると、ここに損益が出ます"
                    )}
                  </p>
                )}
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setEditMode(true)}
                >
                  頒布物を編集
                </button>
              </>
            )}
          </div>
        )}

        {/* アクションゾーン（下端固定・thumb zone） */}
        {items.length > 0 && !editMode && (
          <div className="tally-actions">
            <button
              type="button"
              className="btn btn-secondary btn-undo"
              onClick={undo}
              disabled={history.length === 0}
            >
              ひとつ戻す
            </button>
            <button
              type="button"
              className="btn btn-primary btn-plus"
              onClick={increment}
              disabled={active === null}
            >
              ＋1 頒布
            </button>
          </div>
        )}

        {/* 保存インジケータ */}
        <p className="tally-save">
          {!storageOk
            ? "この環境では保存されません — 記録はページを閉じるまで有効です"
            : online
              ? "端末に自動保存 ✓・オフラインでも動きます"
              : "オフライン中 — データは端末に保存されています"}
        </p>
      </main>
    </div>
  );
}
