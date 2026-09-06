// doujin-soneki — 当日そなえ（アプリ本体の控え）の判定ロジック。React 非依存で、
// DOM のグローバルには触らない（登録は引数で受け取り、それだけを観測する）。
//
// 会場（即売会）は通信が混むため、当日タリーを「開けない」事故が起こりうる。
// Service Worker でアプリシェルの控えを端末に持たせ、一度ひらいた端末なら
// 接続が無くても開けるようにする。ここには「どこに登録するか」と「いまどの状態か」
// の判定だけを置き、副作用は呼び出し側（app/sonae.tsx・app/tally/useSonae.ts）が持つ。
//
// 語彙の規約（混線を防ぐため厳守）:
//   記帳データ（localStorage）… 「保存」と呼ぶ
//   アプリ本体（SW の控え）  … 「控え」「そなえ」と呼ぶ。「保存」とは呼ばない
//
// 単体テストは test/offline.test.mjs。

/**
 * 当日そなえの状態。
 *   ari   … この端末に控えがある＝接続が無くても開ける
 *   junbi … 登録済みだが、まだ控えが行き渡っていない
 *   fuka  … 控えが取れない環境（非対応ブラウザ・非セキュア文脈・登録失敗）
 */
export type SonaeState = "ari" | "junbi" | "fuka";

/**
 * basePath を正規化する。GitHub Pages のプロジェクトページ配信では
 * `/doujin-soneki` のようなサブパスが入り、ルート配信では空になる。
 * 前後の揺れ（末尾スラッシュ有無・先頭スラッシュ欠落・空白）を吸収し、
 * 「空文字」または「/で始まり/で終わらない文字列」に揃える。
 */
export function normalizeBasePath(raw: string | undefined | null): string {
  const s = (raw ?? "").trim();
  if (s === "" || s === "/") return "";
  const withLead = s.startsWith("/") ? s : `/${s}`;
  return withLead.endsWith("/") ? withLead.slice(0, -1) : withLead;
}

/**
 * この読み込みで控えを取りに行ってよいか。
 *
 * 止め方（kill switch）が効いている配信では、そもそも登録しない。登録すると
 * 取り消し版が入り直し、解除と再読み込みを繰り返して素のサイトへ戻れない。
 * 判定をここに置くのは、呼び出し側で `&&` を書くと「札を見る前に登録して
 * いないか」を文字列の並び順でしか検査できなくなるため。
 *
 * `?nosw` は「壊れた控えから逃げる」ための最後の手段。sw 側の unregister
 * だけでは足りない（同じページの JS が即座に登録し直してしまう）ので、
 * 判定をここに置いて登録そのものを止める。
 *
 * 判断は **その読み込み限り** にする。端末に離脱を焼き付けると、
 * 以後どの訪問でも札が「そなえ不可（要電波）＝この環境では取れません」に
 * なり、原因が自分の操作であることが画面から分からないまま
 * 「当日は電波が要る」と誤って段取りを組ませる。直した版は
 * `updateViaCache: "none"` で確実に届くので、自動で復帰させる方が正しい。
 */
export function shouldRegisterSonae(input: {
  /** 止め方（kill switch）の札。false の配信では一切登録しない。 */
  enabled: boolean;
  search: string;
}): boolean {
  if (!input.enabled) return false;
  return !new URLSearchParams(input.search).has("nosw");
}

/**
 * Service Worker 本体の URL。`public/sw.js` は basePath 直下に配信される。
 * ページ相対で解決すると /tally/ から登録したときに /tally/sw.js を見に行って
 * しまうため、必ず basePath 基準の絶対パスで組み立てる。
 */
export function swPath(basePath: string | undefined | null): string {
  return `${normalizeBasePath(basePath)}/sw.js`;
}

/**
 * Service Worker の制御範囲。製品のルート（basePath 直下）に固定する。
 * これによりトップからでもタリーからでも同じ 1 つの登録を共有する。
 */
export function swScope(basePath: string | undefined | null): string {
  return `${normalizeBasePath(basePath)}/`;
}

/**
 * 端末に控えるページ（アプリシェル）。sw.js の SHELL と同一物（scope 相対）。
 * トップだけ開いた人が当日 /tally/ を開けないと、この増分の意味が無くなるので
 * 両方を必ず含める。trailingSlash:true のため各ルートは `<path>/index.html`。
 */
export const SHELL_PATHS: readonly string[] = [
  "", // トップ（シミュレータ）
  "tally/", // 頒布カウンター（当日の主戦場）
  "terms/",
  "privacy/",
];

/**
 * 圏外の受け皿から戻す先＝当日ひらくページ。`SHELL_PATHS` の位置に依存させず
 * 名前で持つ（必須一覧の辞書順から拾うと、ページが増えた日に唯一の出口が
 * 黙って別ページへ移り、ラベルだけ「頒布カウンター」のまま残る）。
 */
export const PRIMARY_SHELL = "tally/";

/**
 * その名前が「封をした世代の控え」か。別置き（`soneki-rt-*`）は含めない。
 *
 * ページ側が控えの実在を確かめるとき、`caches.match()` はオリジン内の全ての
 * キャッシュを見る。別置きにも同じ URL が入りうるので、名前で選り分けないと
 * 「世代は無いのに札は『そなえ済（電波がなくても開けます）』」が成立し、
 * 当日その場で裏切ることになる。世代は all-or-nothing なので、世代の中に
 * 1枚あることだけが「一式ある」を意味する。
 */
export function isSonaeGenerationCache(name: string): boolean {
  return name.startsWith("soneki-") && !name.startsWith("soneki-rt-");
}

/**
 * 控えの実在を確かめる URL。当日ひらくのはこの1枚で、これが控えに無ければ
 * 「電波がなくても開ける」とは言えない。sw の precache は世代ごとに
 * all-or-nothing なので、この1枚の実在が世代一式の実在を意味する。
 */
export function tallyShellUrl(
  basePath: string | undefined | null,
  origin: string,
): string {
  return new URL(`${swScope(basePath)}tally/`, origin).toString();
}

/**
 * 登録に載っている版から、この端末の控えの見通しを読む。
 *
 *   "matsu" … install 中の版が居る。決着（statechange）を待つ
 *   "ari"   … 待機中／活性の版が居る。控えは有りうるので失敗と断じない
 *   "nashi" … 版が1つも無い。redundant で畳まれた後＝この端末に控えは無い
 *
 * 「installing が無い＝順調」と読んではならない。登録は全ページで走らせている
 * ので、先に始まった呼び出しの install が、こちらが観測を張るより前に
 * redundant まで進みうる。その版は活性化しないので controllerchange も来ず、
 * 何も見なければ札は「そなえ中（開いたまま）」で永久に止まり、利用者は
 * 取れるはずのない控えを待ち続ける。
 */
export function readSonaeWorkers(input: {
  installing: boolean;
  waiting: boolean;
  active: boolean;
}): "matsu" | "ari" | "nashi" {
  if (input.installing) return "matsu";
  if (input.waiting || input.active) return "ari";
  return "nashi";
}

/**
 * 封をした世代の中に、その URL の控えがあるか。
 *
 * `caches.match()` をそのまま使うとオリジン内の全キャッシュを見るので、
 * 別置き（`soneki-rt-*`）に同じ URL が入っているだけで「控えあり」と読める。
 * それは「世代は無いのに札は『そなえ済（電波がなくても開けます）』」であり、
 * 当日その場で裏切ることになる。世代は all-or-nothing なので、世代の中に
 * 1枚あることだけが「一式ある」を意味する。
 *
 * 照合は書き手（sw.js）と同じ ignoreVary にする。片方だけ Vary を見ると、
 * 有る控えを無いと読んで札が「そなえ中」から動かなくなる。
 * `caches.open()` は使わない（**無ければ作る**ので、読むだけのつもりで
 * 消したばかりの控えを作り直してしまう）。
 */
export async function hasSonaeGeneration(
  store: CacheStorage,
  url: string,
): Promise<boolean> {
  try {
    for (const name of await store.keys()) {
      if (!isSonaeGenerationCache(name)) continue;
      const hit = await store.match(url, { cacheName: name, ignoreVary: true });
      if (hit !== undefined) return true;
    }
    return false;
  } catch {
    // Cache Storage を読めない環境は控え無しとみなす（無いのに有ると言うより、
    // 有るのに無いと言う方が当日の事故が小さい）。
    return false;
  }
}

/**
 * 版がまだ載っていない登録を、失敗と決めるまでの猶予（ms）。
 * register() の解決は install の開始より前に来ることがあり、その一瞬だけ
 * 登録に版が1つも無い。そこで即断すると、正常な初回訪問を「そなえ不可」に
 * してしまう。逆に待ち続けると「そなえ中」で永久に止まるので、上限を置く。
 */
export const WORKER_APPEAR_MS = 5000;

/**
 * install の成否を見届ける。register() は登録できた時点で解決するので、
 * その後 precache が欠けて版が redundant になっても呼び出し側は気づけない。
 * その版はもう活性化しないため controllerchange も来ず、札は「そなえ中」の
 * まま止まり、利用者に「開いたまま待て」と言い続けることになる。
 *
 * `reg.installing` だけを見てはならない。登録は全ページで走らせている
 * （SonaeRegister が無条件に registerSonae() を呼ぶ）ため、先に始まった
 * 呼び出しの install が、ここへ来るより前に redundant まで進みうる。
 * そのとき installing は既に null で、「null＝順調に終わった」と読むと
 * 初回インストールの失敗を1件も報告できない。installing / waiting / active の
 * 3つで読み、版が1つも無い状態を「控えが取れなかった」として確定させる。
 *
 * onSettled(true) は「この端末で控えが取れなかった」と確定したときだけ呼ぶ。
 * 活きている版が別にあるなら、redundant になったのは更新の試行が畳まれた
 * だけで、控え（前の世代）はそのまま使える。
 */
export function watchSonaeInstall(
  reg: ServiceWorkerRegistration,
  onSettled: (failed: boolean) => void,
  /** 版が現れるのを待つ猶予（ms）。試験から短くするためだけの口。 */
  appearMs: number = WORKER_APPEAR_MS,
): () => void {
  // この観測の周回で結論を出したか。新しい版が現れたら false に戻す
  // （閉じたままにすると、後から入った版の成否が札に出ない）。
  let settled = false;
  let waited = false;
  let watched: ServiceWorker | null = null;
  let offWorker = (): void => {};
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const report = (failed: boolean): void => {
    if (settled) return;
    settled = true;
    clearTimer();
    // 結論が出た版はもう見ない（見続けても `settled` に弾かれるだけ）。
    // 新しい版が現れたら updatefound が観測をやり直す。
    offWorker();
    offWorker = (): void => {};
    onSettled(failed);
  };

  const watchWorker = (worker: ServiceWorker): void => {
    // 同じ版に張り直さない。畳まれた版は `settle()` が弾くが、ここでも
    // 止めておかないと settle → watchWorker → settle の往復が閉じない。
    if (watched === worker) return;
    watched = worker;
    // 前の版の観測を外す。外さないと、畳まれた古い版が後から結論を出し、
    // 新しい版が正常に install 中でも「そなえ不可」と言い切ってしまう。
    offWorker();
    const onState = (): void => {
      if (worker.state === "installing") return;
      if (worker.state !== "redundant") {
        report(false);
        return;
      }
      // 畳まれた版。残っている版で読み直す（他に版があればこの端末の失敗ではない）。
      offWorker();
      offWorker = (): void => {};
      settle();
    };
    worker.addEventListener("statechange", onState);
    offWorker = (): void => worker.removeEventListener("statechange", onState);
    // 観測を張る前に決着していた版を、ここで拾う。
    onState();
  };

  function settle(): void {
    // 結論の出た周回では何もしない（updatefound が周回をやり直す）。
    if (settled) return;
    // 畳まれた版は「居ない」と読む。install の失敗では、版が redundant に
    // なった時点と `reg.installing` が null になる時点が別々に届くため、
    // 素直に読むと「install 中の版が居る」ことになり、その版をまた観測して
    // また畳まれたと読む往復が閉じない（結論が出ないまま札が「そなえ中」で
    // 止まる。これは、この関数が防ごうとしている当のもの）。
    const current = reg.installing;
    const installing =
      current !== null && current.state !== "redundant" ? current : null;
    switch (
      readSonaeWorkers({
        installing: installing !== null,
        waiting: reg.waiting !== null,
        active: reg.active !== null,
      })
    ) {
      case "matsu":
        if (installing !== null) watchWorker(installing);
        return;
      case "ari":
        report(false);
        return;
      case "nashi":
        if (waited) {
          report(true);
          return;
        }
        waited = true;
        clearTimer();
        timer = setTimeout(settle, appearMs);
        return;
    }
  }

  // 版が後から載る場合（別の呼び出しが始めた install を含む）も拾う。
  // 周回をやり直すので、前の結論で観測を閉じない。
  const onUpdateFound = (): void => {
    clearTimer();
    settled = false;
    waited = false;
    settle();
  };
  reg.addEventListener("updatefound", onUpdateFound);
  settle();

  return (): void => {
    clearTimer();
    offWorker();
    offWorker = (): void => {};
    reg.removeEventListener("updatefound", onUpdateFound);
  };
}

/**
 * 登録の結果から状態を決める。
 *
 * 「ari＝接続が無くても開ける」と言い切れるのは、sw がこのページを制御していて
 * **かつ控えが実在する**時だけ。登録できただけ・制御が付いただけでは ari と
 * 呼ばない（まだ控えの無い端末に「電波が無くても開けます」と表示すると、
 * 当日その場で裏切ることになるため）。
 */
export function resolveSonaeState(input: {
  supported: boolean;
  failed: boolean;
  controlled: boolean;
  cached: boolean;
}): SonaeState {
  if (!input.supported || input.failed) return "fuka";
  return input.controlled && input.cached ? "ari" : "junbi";
}

/**
 * 状態行に添える札の表示。取れていない状態でも札を消さない
 * （控えが無いことを黙るのは、当日に事故る側へ倒れるため）。
 *
 * 朱は使わない（「赤字・警告・分岐・印判」の4用途外＝朱の予算制）。
 * 未完了・不可はいずれも枠罫の破線（.fuda-junbi）で墨のまま表す。
 */
export function sonaeFuda(state: SonaeState): {
  text: string;
  sr: string;
  className: string;
} {
  switch (state) {
    case "ari":
      return {
        text: "そなえ済",
        sr: "（この端末に控えあり。電波がなくても開けます）",
        className: "fuda",
      };
    case "junbi":
      return {
        text: "そなえ中（開いたまま）",
        sr: "（控えを取っています。しばらく開いたままにしてください）",
        className: "fuda fuda-junbi",
      };
    case "fuka":
      // 「中」と同じ見た目にしない。junbi は待てば解消する途中、fuka は
      // これ以上変わらない終端で、利用者の当日の段取りが変わる（電波が要る）。
      // 破線＝進行中／実線＝確定、の対で墨のまま階層をつける。
      return {
        // 長くすると 375px 幅で状態行が2行に折り返し、行ごと画面外へ落ちる。
        // 三状態のうち唯一「当日の段取りを変えろ」と言う札が、自分の長さで
        // 自分を隠すことになる。帰結の詳細は下の sr と FAQ が持つ。
        text: "そなえ不可（要電波）",
        sr: "（この環境では控えを取れません。会場では電波が必要です）",
        className: "fuda fuda-fuka",
      };
  }
}
