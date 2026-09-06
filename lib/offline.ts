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
 * "ari" は「まだ失敗ではない」であって「もう安心」ではない。活性の版が無く
 * 待機中の版だけなら、その版が活性化するまでこの端末は制御下に入らないので、
 * 呼び出し側（watchSonaeInstall）はそこから先も見届ける。
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
 * 控えの読みを諦めるまでの猶予（ms）。記憶域が**返らない**端末があり、
 * そこで止まると状態の確定そのものが返らず、札は最初の「そなえ中
 * （開いたまま）」から二度と動かない（install の失敗も、制御が付いたことも
 * 画面に出せなくなる）。
 */
export const CACHE_READ_MS = 5000;

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
 *
 * 読みには上限を置く（`CACHE_READ_MS`）。返らない記憶域は「控え無し」に畳む
 * ＝無いのに有ると言うより、有るのに無いと言う方が当日の事故が小さい。
 */
export async function hasSonaeGeneration(
  store: CacheStorage,
  url: string,
  /** 読みを諦めるまでの猶予（ms）。試験から短くするためだけの口。 */
  readMs: number = CACHE_READ_MS,
): Promise<boolean> {
  const scan = async (): Promise<boolean> => {
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
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), readMs);
  });
  try {
    return await Promise.race([scan(), stalled]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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
 * 初回インストールの版が、活性化まで進むのを待つ猶予（ms）。
 *
 * 活きた版がまだ無い端末では、install を終えた版はそのまま activate へ進む
 * （待たせる相手が居ない）。それが済まないまま止まるのは、activate 側が
 * 返らなくなったときで、その版は制御を引き取らない（clients.claim() まで
 * 進まない）。controllerchange も来ないので、上限を置かないと札は
 * 「そなえ中（開いたまま）」で永久に止まり、利用者は取れるはずのない控えを
 * 待ち続ける。
 *
 * 長めに取るのは、遅い端末の正常な活性化を「そなえ不可」と誤診しないため。
 * sw 側は activate の各段（掃除・制御の引き取り）に上限を置いているので、
 * 正常に進む端末はここに届く前に決着する。ここはその外側の、最後の網。
 * 誤診しても、制御が付いた時点で controllerchange が判定を取り消す
 * （useSonae が failed を戻す）ので、片道の事故にはならない。
 */
export const WORKER_ACTIVATE_MS = 20000;

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
 * **installed で見るのをやめてもならない**。活きた版がまだ無い端末では、
 * install を終えた版が activate まで進んで初めて制御が付く（＝札が動く）。
 * その前に版が畳まれること（別のタブが解除した・新しい版に追い越された）も、
 * 活性化そのものが返らないこともあり、どちらでも controllerchange は来ない。
 * そこで観測を外していると誰も気づけず、札は「そなえ中」で止まる。活きた版が
 * 無い登録では、activated（成功）か redundant（失敗）まで見届け、どちらも
 * 来なければ期限で畳む。
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
  /** 活性化を待つ猶予（ms）。試験から短くするためだけの口。 */
  activateMs: number = WORKER_ACTIVATE_MS,
): () => void {
  // この観測の周回で結論を出したか。新しい版が現れたら false に戻す
  // （閉じたままにすると、後から入った版の成否が札に出ない）。
  let settled = false;
  let waited = false;
  // いま活性化を待っている周回か（同じ周回で期限を張り直さない。張り直すと
  // installed → activating の遷移のたびに上限が伸び、期限が事実上消える）。
  let awaiting = false;
  let watched: ServiceWorker | null = null;
  let offWorker = (): void => {};
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  /**
   * 畳まれた版は「居ない」と読む。install の失敗では、版が redundant になる
   * 時点と、登録の枠（installing / waiting / active）が空になる時点が別々に
   * 届く。素直に読むと「まだ版が居る」ことになり、その版をまた観測してまた
   * 畳まれたと読む往復が閉じない（結論が出ないまま札が「そなえ中」で止まる。
   * これは、この関数が防ごうとしている当のもの）。
   *
   * 3つの枠すべてに同じ規則を当てる。active だけ素通しにすると、解除された
   * 直後の登録で畳まれた版を「活きた版が居る」と読み、初回インストールの
   * 失敗を「更新の試行が畳まれただけ」と誤認して1件も報せられない。
   */
  const live = (worker: ServiceWorker | null): ServiceWorker | null =>
    worker !== null && worker.state !== "redundant" ? worker : null;

  /**
   * 版の観測を外す。`watched` も落とす（落とさないと、同じ版をもう一度
   * 観測したい周回で「張り直さない」の判定に弾かれ、観測も期限も無いまま
   * 結論の出ない周回が残る）。
   */
  const detach = (): void => {
    offWorker();
    offWorker = (): void => {};
    watched = null;
  };

  const report = (failed: boolean): void => {
    if (settled) return;
    settled = true;
    awaiting = false;
    clearTimer();
    // 結論が出た版はもう見ない（見続けても `settled` に弾かれるだけ）。
    // 新しい版が現れたら updatefound が観測をやり直す。
    detach();
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
    // 別の版を見に来た＝前の版の活性化待ちは終わり。期限も持ち越さない
    // （持ち越すと、正常に install 中の新しい版を古い期限が「不可」にする）。
    awaiting = false;
    clearTimer();
    const onState = (): void => {
      if (worker.state === "installing") return;
      if (worker.state === "redundant") {
        // 畳まれた版。残っている版で読み直す
        // （他に版があれば、この端末の失敗ではない）。
        detach();
        awaiting = false;
        clearTimer();
        settle();
        return;
      }
      // 活性化した＝制御を引き取れる版が居る。ここで確定してよい。
      if (worker.state === "activated") {
        report(false);
        return;
      }
      // installed / activating。制御を握るのは活性の版で、この版ではない。
      const active = live(reg.active);
      if (active !== null && active !== worker) {
        // 活性化まで進んでいるなら控えは使える＝この版の行方は札を左右しない
        // （この版は更新の試行で、控えは前の世代がそのまま持っている）。
        if (active.state === "activated") {
          report(false);
          return;
        }
        // まだ活性化の途中。札を左右するのはそちらなので、見る先を移す
        // （この版は待機で、活性の版が片付くまで動かない）。
        watchWorker(active);
        return;
      }
      // 活きた版がまだ無い＝初回インストール。ここで「失敗ではない」と閉じては
      // ならない。制御が付くのは活性化してからで、その前に畳まれることも、
      // 活性化が返らないこともある。観測を外した後ではどちらにも気づけず、
      // controllerchange も来ないまま札が「そなえ中」で止まる。
      // 決着（activated / redundant）まで見届け、来なければ期限で畳む。
      if (awaiting) return;
      awaiting = true;
      clearTimer();
      timer = setTimeout(() => {
        timer = undefined;
        if (settled) return;
        // 期限。札は「取れない」に倒すが、**観測は外さない**。ここで外すと、
        // 遅れて活性化した版を誰も見なくなり、控えが実在するのに札が
        // 「そなえ不可（要電波）」で固まる（controllerchange が来なければ
        // 戻す機会も無い）。周回は開けたままにして、決着で言い直す。
        onSettled(true);
      }, activateMs);
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
    const installing = live(reg.installing);
    const waiting = live(reg.waiting);
    const active = live(reg.active);
    switch (
      readSonaeWorkers({
        installing: installing !== null,
        waiting: waiting !== null,
        active: active !== null,
      })
    ) {
      case "matsu":
        // install 中の版に期限は置かない。取得は会場の回線に律速され、
        // sw 側も「進んでいる限り待つ（無音で畳む）」で組んである。総時間で
        // 切ると、遅いだけで繋がる回線を「控えが取れない端末」に落とす。
        // 記憶域側の沈黙は sw が畳むので、ここに残るのは通信の遅さだけで、
        // そのあいだ「そなえ中（開いたまま）」は嘘ではない。
        if (installing !== null) watchWorker(installing);
        return;
      case "ari": {
        // 制御を引き取れるのは活性化まで進んだ版だけ。それが居るなら、
        // この端末は控えを使える（失敗ではない）。
        if (active !== null && active.state === "activated") {
          report(false);
          return;
        }
        // まだ活性化していない版（待機中・活性化中）しか居ない。register() の
        // 解決がここまで遅れると install 中の版を観測できないので、その版を
        // 拾って決着まで見届ける。ここで閉じると、活性化まで進まない版に
        // 誰も気づけず、controllerchange も来ないまま札が「そなえ中」で止まる。
        // "ari" は待機中か活性の版が居ることなので、どちらかは必ず居る。
        const pending = active ?? waiting;
        if (pending !== null) watchWorker(pending);
        return;
      }
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
    awaiting = false;
    // 前の周回の観測を持ち込まない。持ち込むと、次の周回が版を1つも
    // 見つけられなかったとき（枠が空になった直後）に古い版の観測だけが
    // 生き残り、その版の遷移が新しい周回の結論を横取りする。
    detach();
    settle();
  };
  reg.addEventListener("updatefound", onUpdateFound);
  settle();

  return (): void => {
    clearTimer();
    awaiting = false;
    detach();
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
