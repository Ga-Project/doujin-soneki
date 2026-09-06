"use client";

// 当日そなえ — アプリ本体の控えを端末に取る（Service Worker の登録と状態観測）。
// 会場は通信が混むため、一度ひらいた端末なら接続が無くても開けるようにする。
// 判定そのものは lib/offline.ts（単体テストあり）に置き、ここは副作用だけを持つ。
//
// 登録は全ページで走らせる（app/sonae.tsx をレイアウトに置いている）。
// トップだけ見て帰った人の端末にも控えが要るため。このフックは /tally で
// 状態を読むために使い、登録は冪等なのでどちらから呼んでも同じ 1 つに収束する。
//
// 語彙: 記帳データ（localStorage）は「保存」、アプリ本体の控えは「そなえ／控え」。
// 混ぜない（何が端末に残っているのか読み手が分からなくなるため）。

import { useCallback, useEffect, useState } from "react";
import {
  resolveSonaeState,
  shouldRegisterSonae,
  swPath,
  swScope,
  tallyShellUrl,
  type SonaeState,
} from "@/lib/offline";
import { SONAE_SEEN_NAME } from "../config";

const BASE = process.env.NEXT_PUBLIC_BASE_PATH;

/** 「控えを取りました」の知らせを既に見せたか。読めない環境では未読扱いにする。 */
function seenObi(): boolean {
  try {
    return window.localStorage.getItem(SONAE_SEEN_NAME) !== null;
  } catch {
    return false;
  }
}

/** 実際に画面へ出した時だけ呼ぶ（出していないのに既読にしない）。 */
export function markObiSeen(): void {
  try {
    window.localStorage.setItem(SONAE_SEEN_NAME, "1");
  } catch {
    /* 保存できない環境。次回また出るが実害はない */
  }
}

/**
 * 控えを撤去する。`?nosw` の逃げ道は sw 側の unregister だけでは成立しない
 * （同じページの JS が即座に登録し直す）ので、ページ側からも消しに行く。
 * 壊れた sw の fetch ハンドラに依存しないため、これが最後の頼りになる。
 */
function removeSonae(): Promise<void> {
  return navigator.serviceWorker
    .getRegistrations()
    .then((rs) => Promise.all(rs.map((r) => r.unregister())))
    .then(() => caches.keys())
    .then((ks) =>
      Promise.all(
        ks.filter((k) => k.startsWith("soneki-")).map((k) => caches.delete(k)),
      ),
    )
    .then(() => undefined)
    .catch(() => undefined);
}

/** Service Worker を登録する（冪等）。全ページから呼ばれる。 */
export function registerSonae(): Promise<boolean> {
  // 開発時は登録しない。控えが効くと編集が画面に反映されなくなる。
  if (process.env.NODE_ENV !== "production") return Promise.resolve(false);
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return Promise.resolve(false);
  }
  const search = typeof location === "undefined" ? "" : location.search;
  if (!shouldRegisterSonae({ search })) {
    void removeSonae();
    return Promise.resolve(false);
  }
  return navigator.serviceWorker
    // updateViaCache:"none" ＝ sw.js 自体を HTTP キャッシュ越しに読ませない。
    // 控えが壊れたときの差し替え（README の止め方）が確実に届くようにする。
    .register(swPath(BASE), { scope: swScope(BASE), updateViaCache: "none" })
    .then(() => true)
    .catch(() => false);
}

export function useSonae(): {
  state: SonaeState;
  /** 「この端末に控えを取りました」の知らせを出してよいか（初めて控えが揃った1回だけ） */
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
      setState("fuka");
      return;
    }

    let alive = true;
    const sync = async (failed: boolean): Promise<void> => {
      const controlled = navigator.serviceWorker.controller !== null;
      // 控えの実在を実測する。制御が付いただけで「開けます」と言わない。
      let cached = false;
      try {
        cached =
          (await caches.match(tallyShellUrl(BASE, location.origin))) !==
          undefined;
      } catch {
        /* Cache Storage を読めない環境は控え無しとみなす */
      }
      if (!alive) return;
      const next = resolveSonaeState({
        supported: true,
        failed,
        controlled,
        cached,
      });
      setState(next);
      // 知らせは控えが揃った時だけ。既読にするのは実際に描画した側の責務
      // （復元バー等に譲って表示されなかった回で焼き切らないため）。
      if (next === "ari" && !seenObi()) setShowObi(true);
    };

    registerSonae().then((ok) => {
      void sync(!ok);
    });

    // 初回訪問では登録直後にまだ controller が付いていない。制御が移った時点で
    // 「そなえ中 → そなえ済」へ繰り上げる（利用者を再読み込みまで待たせない）。
    const onChange = (): void => {
      void sync(false);
    };
    navigator.serviceWorker.addEventListener("controllerchange", onChange);
    void sync(false);

    return () => {
      alive = false;
      navigator.serviceWorker.removeEventListener("controllerchange", onChange);
    };
  }, []);

  const dismissObi = useCallback(() => setShowObi(false), []);

  return { state, showObi, dismissObi };
}
