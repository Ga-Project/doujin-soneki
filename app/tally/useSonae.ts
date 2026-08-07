"use client";

// 当日そなえ — アプリ本体の控えを端末に取る（Service Worker の登録と状態観測）。
// 会場は通信が混むため、一度ひらいた端末なら接続が無くても /tally を開けるようにする。
// 判定そのものは lib/offline.ts（単体テストあり）に置き、ここは副作用だけを持つ。
//
// 語彙: 記帳データ（localStorage）は「保存」、アプリ本体の控えは「そなえ／控え」。
// 混ぜない（何が端末に残っているのか読み手が分からなくなるため）。

import { useCallback, useEffect, useState } from "react";
import { resolveSonaeState, swPath, swScope, type SonaeState } from "@/lib/offline";
import { SONAE_SEEN_NAME } from "../config";

const BASE = process.env.NEXT_PUBLIC_BASE_PATH;

/** 「控えを取りました」の帯を既に見せたか。localStorage が使えない環境では常に未読扱い。 */
function seenObi(): boolean {
  try {
    return window.localStorage.getItem(SONAE_SEEN_NAME) !== null;
  } catch {
    return false;
  }
}

function markObiSeen(): void {
  try {
    window.localStorage.setItem(SONAE_SEEN_NAME, "1");
  } catch {
    /* 保存できない環境。次回また出るが実害はない */
  }
}

export function useSonae(): {
  state: SonaeState;
  /** 「この端末に控えを取りました」の帯を出すか（初めて控えが揃った1回だけ） */
  showObi: boolean;
  dismissObi: () => void;
} {
  // 初期値は SSR と一致させるため固定。実際の状態は登録後に effect で確定する。
  const [state, setState] = useState<SonaeState>("junbi");
  const [showObi, setShowObi] = useState(false);

  useEffect(() => {
    const supported =
      typeof navigator !== "undefined" && "serviceWorker" in navigator;
    if (!supported) {
      setState(resolveSonaeState({ supported, failed: false, controlled: false }));
      return;
    }

    let alive = true;
    const sync = (failed: boolean): void => {
      if (!alive) return;
      const controlled = navigator.serviceWorker.controller !== null;
      const next = resolveSonaeState({ supported: true, failed, controlled });
      setState(next);
      // 帯は「控えが揃った」瞬間に一度だけ。既読フラグはその場で立てて再訪で出さない。
      if (next === "ari" && !seenObi()) {
        markObiSeen();
        setShowObi(true);
      }
    };

    navigator.serviceWorker
      .register(swPath(BASE), { scope: swScope(BASE) })
      .then(() => sync(false))
      .catch(() => sync(true));

    // 初回訪問では登録直後にまだ controller が付いていない。制御が移った時点で
    // 「そなえ中 → そなえ済」へ繰り上げる（利用者を再読み込みまで待たせない）。
    const onChange = (): void => sync(false);
    navigator.serviceWorker.addEventListener("controllerchange", onChange);
    sync(false);

    return () => {
      alive = false;
      navigator.serviceWorker.removeEventListener("controllerchange", onChange);
    };
  }, []);

  const dismissObi = useCallback(() => setShowObi(false), []);

  return { state, showObi, dismissObi };
}
