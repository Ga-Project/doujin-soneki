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
import { SONAE_ENABLED, SONAE_SEEN_NAME } from "../config";

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
 *
 * 解除するのは **この製品の scope の登録だけ**。getRegistrations() は
 * オリジン全体の登録を返すので、そのまま全部 unregister すると、
 * 同じオリジンに同居する別の公開物の Service Worker まで巻き添えで落とす。
 *
 * 全体を try で覆うのは、逃げ道が「壊れていても効く」ことに意味があるため。
 * 途中の1つが投げて呼び出し側（登録の入口）ごと倒れると、撤去も登録もされない
 * 宙ぶらりんになる。
 */
async function removeSonae(): Promise<void> {
  try {
    const scope = new URL(swScope(BASE), location.origin).toString();
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(
      regs.filter((r) => r.scope === scope).map((r) => r.unregister()),
    );
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith("soneki-")).map((k) => caches.delete(k)),
    );
  } catch {
    /* 消せなくても画面は妨げない。sw 側の撤去も同じことを試みている */
  }
}

/** Service Worker を登録する（冪等）。全ページから呼ばれる。 */
export function registerSonae(): Promise<ServiceWorkerRegistration | null> {
  // 開発時は登録しない。控えが効くと編集が画面に反映されなくなる。
  if (process.env.NODE_ENV !== "production") return Promise.resolve(null);
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return Promise.resolve(null);
  }
  // 止め方（kill switch）が効いている配信では、そもそも登録しない。
  // ここを通すと、取り消し版が入り直して解除と再読み込みを繰り返す。
  const search = typeof location === "undefined" ? "" : location.search;
  if (!SONAE_ENABLED || !shouldRegisterSonae({ search })) {
    void removeSonae();
    return Promise.resolve(null);
  }
  return navigator.serviceWorker
    // updateViaCache:"none" ＝ sw.js 自体を HTTP キャッシュ越しに読ませない。
    // 控えが壊れたときの差し替え（README の止め方）が確実に届くようにする。
    .register(swPath(BASE), { scope: swScope(BASE), updateViaCache: "none" })
    .catch(() => null);
}

/**
 * install の成否を見届ける。register() は登録できた時点で解決するので、
 * その後 precache が欠けて版が redundant になっても呼び出し側は気づけない。
 * その版はもう活性化しないため controllerchange も来ず、札は「そなえ中」の
 * まま止まり、利用者に「開いたまま待て」と言い続けることになる。
 *
 * onFailed は「この端末で控えが取れなかった」と確定したときだけ呼ぶ。
 * 活きている版が別にあるなら、redundant になったのは更新の試行が畳まれた
 * だけで、控え（前の世代）はそのまま使える。
 */
function watchInstall(
  reg: ServiceWorkerRegistration,
  onSettled: (failed: boolean) => void,
): () => void {
  const installing = reg.installing;
  if (installing === null) return () => {};
  const onState = (): void => {
    if (installing.state === "installing") return;
    onSettled(installing.state === "redundant" && reg.active === null);
  };
  installing.addEventListener("statechange", onState);
  return () => installing.removeEventListener("statechange", onState);
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
    // 控えが取れないと確定したか。install の失敗は register() の解決より後に
    // 分かるので、観測ごとの引数ではなくここに持つ（sync は非同期なので、
    // 引数で渡すと先に始まった観測が後から「そなえ済」で上書きしてしまう）。
    let failed = false;
    const sync = async (): Promise<void> => {
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
        controlled: navigator.serviceWorker.controller !== null,
        cached,
      });
      setState(next);
      // 知らせは控えが揃った時だけ。既読にするのは実際に描画した側の責務
      // （復元バー等に譲って表示されなかった回で焼き切らないため）。
      if (next === "ari" && !seenObi()) setShowObi(true);
    };

    let unwatch = (): void => {};
    void registerSonae().then((reg) => {
      if (!alive) return;
      if (reg === null) {
        failed = true;
        void sync();
        return;
      }
      // install が転けた版は activate されず redundant で終わる。
      // controllerchange も来ないので、ここを見ないと「そなえ中」で止まる。
      unwatch = watchInstall(reg, (installFailed) => {
        if (!alive) return;
        failed = installFailed;
        void sync();
      });
      void sync();
    });

    // 初回訪問では登録直後にまだ controller が付いていない。制御が移った時点で
    // 「そなえ中 → そなえ済」へ繰り上げる（利用者を再読み込みまで待たせない）。
    const onChange = (): void => {
      void sync();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onChange);
    void sync();

    return () => {
      alive = false;
      unwatch();
      navigator.serviceWorker.removeEventListener("controllerchange", onChange);
    };
  }, []);

  const dismissObi = useCallback(() => setShowObi(false), []);

  return { state, showObi, dismissObi };
}
