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
  hasSonaeGeneration,
  resolveSonaeState,
  shouldRegisterSonae,
  swPath,
  swScope,
  tallyShellUrl,
  watchSonaeInstall,
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
  // 登録の解除と控えの破棄を**別々に**守る。1つの try で括ると、解除の失敗で
  // 控えの破棄まで飛ばされる（逃げ道が「前半が成功すること」に依存する）。
  try {
    const scope = new URL(swScope(BASE), location.origin).toString();
    const regs = await navigator.serviceWorker.getRegistrations();
    // 1つの解除が転けても残りを解除する。
    await Promise.all(
      regs
        .filter((r) => r.scope === scope)
        .map((r) => r.unregister().catch(() => false)),
    );
  } catch {
    /* 解除できない環境。控えの破棄は下で続ける */
  }
  try {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith("soneki-"))
        .map((k) => caches.delete(k).catch(() => false)),
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
  // 止め方（kill switch）と `?nosw` の判定は lib/offline.ts が持つ。
  // ここを通すと、取り消し版が入り直して解除と再読み込みを繰り返す。
  const search = typeof location === "undefined" ? "" : location.search;
  if (!shouldRegisterSonae({ enabled: SONAE_ENABLED, search })) {
    void removeSonae();
    return Promise.resolve(null);
  }
  try {
    return navigator.serviceWorker
      // updateViaCache:"none" ＝ sw.js 自体を HTTP キャッシュ越しに読ませない。
      // 控えが壊れたときの差し替え（README の止め方）が確実に届くようにする。
      .register(swPath(BASE), { scope: swScope(BASE), updateViaCache: "none" })
      .catch(() => null);
  } catch {
    // register() は同期に投げることがある（scope の解決に失敗する配信など）。
    // この関数はレイアウト（SonaeRegister）からも呼ばれるので、投げると
    // 控えが取れないどころか画面そのものが出なくなる。
    return Promise.resolve(null);
  }
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
    // 観測の通し番号。sync は非同期なので、先に始まった観測が後から
    // 古い実測値で上書きしうる（控えが揃った端末の札が「そなえ中」に戻る）。
    // 追い越されたものは捨てる。
    let seq = 0;
    const sync = async (): Promise<void> => {
      const mine = ++seq;
      // 控えの実在を実測する。制御が付いただけで「開けます」と言わない。
      // 判定そのもの（どのキャッシュを世代とみなすか）は lib/offline.ts が持つ。
      const cached = await hasSonaeGeneration(
        caches,
        tallyShellUrl(BASE, location.origin),
      );
      // 追い越されていたら、この観測はもう古い。
      if (!alive || mine !== seq) return;
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
      unwatch = watchSonaeInstall(reg, (installFailed) => {
        if (!alive) return;
        failed = installFailed;
        void sync();
      });
      // ここで sync() を足さない。watchSonaeInstall は張った時点で決着を
      // 見に行き、決着したら上の onSettled から sync() が走る。決着して
      // いない（install 中の）ときの初期表示は、下の無条件の sync() が持つ。
    }).catch(() => {
      // ここで投げると unwatch が入らないまま観測が残り（画面を離れても
      // 外れない）、札は結論を待ち続けて「そなえ中」で止まる。
      if (!alive) return;
      failed = true;
      void sync();
    });

    // 初回訪問では登録直後にまだ controller が付いていない。制御が移った時点で
    // 「そなえ中 → そなえ済」へ繰り上げる（利用者を再読み込みまで待たせない）。
    const onChange = (): void => {
      // 制御が付いた＝版が活きた。以前に「取れなかった」と確定させた判定は
      // もう古い。残したままだと、控えが実在するのに札が「そなえ不可」で
      // 固まり、当日「電波が要る」と誤った段取りを組ませる。
      failed = false;
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
