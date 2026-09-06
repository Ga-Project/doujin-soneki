/*
 * 同人ソンエキ — Service Worker（当日そなえ）
 *
 * 目的: 即売会の会場は通信が混み、ページを開けない/読み込みが終わらないことがある。
 * 一度ひらいた端末にアプリ一式の控えを持たせ、接続が無くても・遅くても開けるようにする。
 * 記帳データ自体は従来どおり localStorage にあり、ここでは扱わない。
 *
 * ■ 世代（generation）方式 — この設計の要
 * 控えは「ビルド1回＝1世代」で、`soneki-<ビルド印>` という名前のキャッシュに入れる。
 * install では **その世代の HTML と、その HTML が参照する資産を丸ごと一括投入**し、
 * 1つでも取れなければ世代ごと捨てる（all-or-nothing）。
 * こうしないと「HTML は新しいのに JS は古い世代のまま」という版ズレが起き、
 * 画面は出るのに操作が効かない（＝会場で最悪の）無音の failure になる。
 * 控える一覧とビルド印は `scripts/stamp-sw.mjs` がビルド後に焼き込む。
 *
 * ■ 世代は install で封をする（後から書き換えない）
 * install を終えた世代のキャッシュには、以後 **一切書かない**。
 * 後から新しい応答で一部だけ差し替えると、「HTML や RSC は新版・JS は旧版」という
 * 版ズレが、all-or-nothing で守ったはずの世代の内側に成立してしまうため。
 * 更新は「sw の更新 → install → activate」だけが行う。
 * 世代に属さない同一オリジンの取得物は、別置きの `soneki-rt-<ビルド印>` に置く。
 *
 * ■ 取り出し方（3種類だけ）
 *   1. ページ遷移(navigate) … ネットワーク優先＋時間切れで控えへ（遅い会場回線で待たされない）
 *   2. その世代の資産        … 控えをそのまま（世代内で完結しているので必ず整合する）
 *   3. それ以外の同一オリジン … 別置きに控えがあれば出しつつ裏で更新
 * 別オリジン（アクセス解析など）は一切介入しない。
 *
 * ■ 逃げ道（回復手段）
 *   - URL に `?nosw` を付けて開くと、この登録自体を解除して素のサイトへ戻る
 *   - 控えが壊れたときの止め方は README「当日そなえ（オフライン対応）」を参照
 */

// ビルドごとに一意な世代名。stamp-sw.mjs がこの宣言を置換する。
const BUILD = "__BUILD__";
// 世代の控え。install でだけ書き、以後は読むだけ（＝封をする）。
const CACHE = `soneki-${BUILD}`;
// 世代に属さない同一オリジンの取得物の置き場。fetch から書くのはこちらだけ。
const RUNTIME = `soneki-rt-${BUILD}`;

// 圏外の受け皿から戻す先。stamp-sw.mjs が lib/offline.ts の PRIMARY_SHELL を
// 焼き込む。必須一覧から辞書順で拾うと、ページが増えた日に唯一の出口が
// 黙って別ページへ移り、ラベルだけ「頒布カウンター」のまま残る。
const SHELL_MAIN = "__SHELL_MAIN__";

// この世代で控える URL（scope 相対）。stamp-sw.mjs が配列ごと置換する。
// 未置換のときは空。なお開発時はそもそも登録しない（registerSonae が
// 本番ビルドでのみ登録する）ので、この経路には入らない。
// 必須: 当日の主戦場（記帳画面・トップと、それらが実際に読む実体）。
// 1つでも欠けたら世代を作らない。
const REQUIRED = ["__REQUIRED__"].filter((p) => p !== "__REQUIRED__");
// 任意: 規約などの周辺ページ。取れたら控える。
const OPTIONAL = ["__OPTIONAL__"].filter((p) => p !== "__OPTIONAL__");

// 遅い会場回線で待たされないための時間切れ（ms）。
// これを過ぎたら控えを返す。控えが無ければネットワークの完了を待つ。
const NETWORK_TIMEOUT_MS = 3000;

// 任意分の「無音」の長さ（ms）。必須が揃っているのに任意の沈黙で
// install が終わらない、という人質状態を作らないため。
const OPTIONAL_TIMEOUT_MS = 8000;

// 立ち上げ・撤去の1手ごとに置く上限（ms）。記憶域の読み書きと、制御の
// 引き取り（clients.claim）が対象。どちらも回線に依存せず、正常な端末なら
// 一瞬で返る。返らない端末で無期限に待つと install や activate が開いたままに
// なり、札は「そなえ中（開いたまま）」から動かない。失敗としても畳まれない
// ので再試行もされず、利用者は取れない控えを待ち続ける。
const STEP_TIMEOUT_MS = 5000;

// 別置きの裏更新に与える上限（ms）。応答は控えから既に返しているので、
// ここで待ち続ける理由は無い。期限が無いと、沈黙した1本が waitUntil を
// 握ったまま Service Worker を生かし続ける。
const RUNTIME_TIMEOUT_MS = 15000;

// 取得を諦めるまでの「無音」の長さ（ms）。**総時間の上限ではない**。
//
// 応答ヘッダが返っても本文が来ないことはあり、本文の転送（cache.put）で止まると
// install は無期限に開いたままになる ＝端末は「そなえ中」から動かず、失敗として
// 畳まれないので再試行もされない。だから期限は要る。
//
// ただし**総時間**で切ってはならない。取得は同時に走って回線を分け合うので、
// 総時間で切ると、1本ずつは進んでいるのに全部が同時に期限へ当たり、世代ごと
// 捨てられる ＝「遅いだけで繋がる回線」を「控えが取れない端末」に落とす。
// それはこの機能が守ろうとしている当のもの。
// そこで、ヘッダまではこの長さで待ち、本文は「この長さのあいだ1バイトも
// 来なければ諦める」（進んでいる限り待つ）で見る。
const REQUIRED_TIMEOUT_MS = 30000;

// `?nosw` を受けた後は、この版は何も横取りしない。
// 逃げ道のページ自身が読む資産（`_next/static/...`）には `?nosw` が付かないので
// 通常経路に落ち、`caches.open(CACHE)` が**消したばかりの控えを作り直す**
// （逃げたつもりの端末に控えが残る／実測で確認）。フラグで介入ごと止める。
let optedOut = false;

/**
 * 古い世代を掃除する。残すのは現世代の控えと、その世代に紐づく別置きの2つだけ。
 * 規則を二度書くと、片方だけ「残す集合」を直した日に、配布中の控えを抜くか、
 * 消し損ねるかになる。
 *
 * 開いているページの足元から資産を抜かないことは、呼び出し元がそれぞれ別の
 * 理由で保証する:
 *   activate … 旧世代を配っていた版はもう退いている
 *   install  … 活きた版が無い端末でだけ呼ぶ（配っている控えがそもそも無い）
 */
async function sweepStale() {
  const names = await caches.keys();
  const stale = names.filter(
    (n) => n.startsWith("soneki-") && n !== CACHE && n !== RUNTIME,
  );
  await Promise.all(stale.map((n) => caches.delete(n)));
}

/** scope 基準の絶対 URL に解決する。 */
function scoped(path) {
  return new URL(path, self.registration.scope).toString();
}

/**
 * 期限付きの中断 signal を作る。`AbortSignal.timeout()` は使わない。
 *
 * Service Worker は動くのに静的ヘルパーだけ無いブラウザ（古い Safari/iOS 等）が
 * 実在し、そこでは `AbortSignal.timeout(...)` の評価そのものが投げる。投げる
 * 場所が install の頭なので、必須分の取得へ入る前に install ごと reject し、
 * その端末は控えを一切持てなくなる（＝オフライン対応が丸ごと消える）。
 * `AbortController` + `setTimeout` なら、Service Worker がある環境には必ず有る。
 *
 * 返り値の `done()` は必ず呼ぶこと（呼ばないと期限まで待つタイマーが残り、
 * 取得が早く終わった分だけ Service Worker の生存が無駄に延びる）。
 *
 * `expired` は期限で false に解決する時計。中断そのものが無い環境（signal を
 * 渡せない）でも、これと競走させれば「いつまでも終わらない」を作らずに済む。
 * 期限が signal だけに乗っていると、中断が無い端末では install が永遠に開いた
 * まま＝札が「そなえ中」から動かず、失敗として畳まれず再試行もされない。
 */
function timeoutSignal(ms) {
  const controller =
    typeof AbortController === "undefined" ? null : new AbortController();
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => {
      if (controller !== null) controller.abort();
      resolve(false);
    }, ms);
  });
  return {
    signal: controller === null ? undefined : controller.signal,
    expired,
    done() {
      clearTimeout(timer);
    },
  };
}

/**
 * `waitUntil` に渡す裏仕事の「引き延ばし」に上限を置く。
 *
 * 仕事そのものは止めない（応答は既に返しているので中断する理由が無い）。
 * 上限を越えたら Service Worker を生かし続けるのをやめるだけ。期限が無いと、
 * 沈黙した1本が waitUntil を握ったまま端末の電池を削る。
 */
function atMost(work, ms) {
  let timer;
  const capped = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([work, capped]).then(
    () => clearTimeout(timer),
    () => clearTimeout(timer),
  );
}

/**
 * 本文を読み切って、控えに書ける形にして返す。
 * 「ms のあいだ1バイトも来なければ諦める」で見る（止まったら諦める）。
 *
 * 総時間で切ってはならない。取得は同時に走って回線を分け合うので、総時間の
 * 期限は事実上いつも全部に同時に当たり、遅いだけで繋がる回線を「控えが
 * 取れない端末」に落とす。無音で見れば、進んでいる転送は最後まで通る。
 *
 * 読み切ってから組み直すのは、**流れのまま控えへ渡さない**ため。流れを本文に
 * 持つ応答を組めない実装があり、そこで転ぶと「取れたはずの1本」が取れない
 * 扱いになって世代ごと落ちる。バイト列からなら、Service Worker のある環境なら
 * どこでも組める。
 *
 * 本文を読めない実装（`response.body` を持たない）では、元の応答をそのまま
 * 返す。その場合ここでは無音を見られないので、期限は呼び出し側の
 * 「控えへ書く」段（総時間）だけが持つ。無音が続いたときは投げる。
 */
async function bodyWithin(res, ms) {
  if (!res.body || typeof res.body.getReader !== "function") return res;
  const reader = res.body.getReader();
  const parts = [];
  let size = 0;
  let timer;
  try {
    for (;;) {
      const idle = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      });
      const chunk = await Promise.race([reader.read(), idle]);
      clearTimeout(timer);
      if (chunk === null) throw new Error("stalled");
      if (chunk.done) break;
      parts.push(chunk.value);
      size += chunk.value.length;
    }
  } catch (e) {
    clearTimeout(timer);
    void reader.cancel().catch(() => {
      /* 既に閉じている */
    });
    throw e;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return new Response(bytes, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

/**
 * 1本を取得し、そのまま控えへ書く。
 *
 * 取得（ヘッダ）・本文・書き込みの3つに、それぞれ期限を持たせる。どれか1つ
 * でも期限が無いと、そこで止まった端末の install が開いたままになり、札は
 * 「そなえ中」から動かず、失敗として畳まれないので再試行もされない。
 *
 * 取れたら true。取れない（非OK・失敗・期限切れ・書き込み失敗）なら false。
 * 書き込みの失敗を false に含めるのが要点で、本文の転送で切れる失敗は
 * res.ok を素通りしてここへ来る。
 */
async function fetchInto(cache, url, ms) {
  // ① ヘッダまで。中断が使えない端末では signal が効かないので、時計とも
  //    競走させる（どちらの端末でも必ず畳めるようにする）。
  const head = timeoutSignal(ms);
  let res;
  try {
    const fetching = fetch(url, { cache: "reload", signal: head.signal });
    res = await Promise.race([fetching, head.expired.then(() => null)]);
    if (res === null) {
      // 見切った後で届くことがある（中断が使えない端末では走り続ける）。
      // 読まれない流れを worker に溜めないよう、届いたら閉じる。
      void fetching.then(discardBody, () => {
        /* 届かなかったなら閉じるものも無い */
      });
      return false;
    }
    if (!res.ok) {
      // 使わない応答は本文を閉じる（会場の捕捉ページが毎回 503 を返すと、
      // 読まれない流れが取得の数だけ worker に溜まる）。
      discardBody(res);
      return false;
    }
  } catch {
    return false;
  } finally {
    head.done();
  }

  // ② 本文。進んでいる限り待ち、無音が続いたら諦める。
  let body;
  try {
    body = await bodyWithin(res, ms);
  } catch {
    return false;
  }

  // ③ 控えへ書く。ここにも必ず期限を置く（記憶域が詰まったまま返らないと、
  //    install が開いたままになり、札が「そなえ中」から動かない）。
  const write = timeoutSignal(ms);
  try {
    const put = cache.put(url, body).then(() => true);
    const written = await Promise.race([put, write.expired]);
    if (written) return true;
    // 見切った後で書き終わることがある。封をした世代に残すと、別の版の
    // バイトが世代の内側に混ざりうるので、書き終わり次第それを取り消す。
    void put.then(
      () =>
        cache.delete(url).catch(() => {
          /* 消せなくても、この1本を「取れた」とは数えない */
        }),
      () => {
        /* 書けずに終わったなら残らない */
      },
    );
    return false;
  } catch {
    return false;
  } finally {
    write.done();
  }
}

/**
 * 使わない応答の本文を閉じる。読まれない流れを worker に溜めないため。
 * 時間切れで見切った後に届く分も、ここを通して閉じる。
 */
function discardBody(res) {
  if (!res || !res.body) return;
  try {
    void res.body.cancel().catch(() => {});
  } catch {
    /* 既に読まれている／閉じられている */
  }
}

/**
 * 「読めなかった」の印。**控えに無い（undefined）と必ず区別する**。
 *
 * 一緒くたにすると、世代に入っている URL を「無い」と読んでネットワークの
 * 応答を別置きへ書き、次からそれを返す。会場の捕捉ページが 200 を返す回線
 * では、ハッシュ付き JS の URL に HTML が貼り付き、封をした世代の外側に
 * 版ズレが成立する（画面は出るのに操作が効かない＝当日いちばん困る壊れ方）。
 */
const UNREADABLE = { unreadable: true };

/**
 * 記憶域の読みに上限を置く。読めない・返らないなら UNREADABLE。
 *
 * 取り出しの経路でここが止まると `respondWith` が永久に解決せず、回線が
 * 完全でも画面が出ない ＝「Service Worker が居ない方がマシ」という状態を
 * 作ってしまう。控えを諦めて素通りする方が、必ず軽い。
 */
async function readWithin(work) {
  const clock = timeoutSignal(STEP_TIMEOUT_MS);
  try {
    const got = await Promise.race([work, clock.expired]);
    // 期限切れは false（timeoutSignal の時計）。控えに無い undefined と混ぜない。
    return got === false ? UNREADABLE : got;
  } catch {
    return UNREADABLE;
  } finally {
    clock.done();
  }
}

/** 控えを開く。開けない・返らないなら UNREADABLE。 */
function openCache(name) {
  return readWithin(caches.open(name));
}

/**
 * 控えに触らずネットワークへ流す。控えを確かめられなかった回の出口で、
 * 「Service Worker が居ないのと同じ」に落とすためのもの。
 */
async function passThrough(request) {
  try {
    return await fetch(request);
  } catch {
    // 遷移は上流（networkFirstWithFallback）が受け皿まで面倒を見るので、
    // ここへ来るのは資産だけ。資産に受け皿は無い（HTML を返すと、読み手は
    // JS や CSS として解釈して別の壊れ方をする）。
    return Response.error();
  }
}

/** 控えに入れられなくても表示は妨げない（quota 超過などで put は失敗しうる）。 */
async function putSafe(cache, request, response) {
  try {
    await cache.put(request, response);
  } catch {
    /* 控えが増えないだけ。取得済みの応答はそのまま返す */
  }
}

/**
 * ページ遷移の照合。`?utm_source=...` 付きの共有リンクでも同じ控えに当てる。
 * ignoreSearch を資産にまで広げると `?v=` 等のキャッシュ破りが効かなくなるので、
 * ここ（navigate）専用にする。
 */
function matchPage(cache, request) {
  if (cache === UNREADABLE) return Promise.resolve(UNREADABLE);
  return readWithin(cache.match(request, { ignoreSearch: true, ignoreVary: true }));
}

/**
 * 資産の照合。クエリは区別する（キャッシュ破りを殺さない）。
 * ただし RSC ペイロード（`index.txt`）だけは例外で、Next が毎回
 * `?_rsc=<hash>` を付けて要求するため、クエリを見ると控えに永久に当たらない。
 * 静的 export では同一ファイルへの CDN 回避クエリなので無視して正しい。
 */
function matchAsset(cache, request) {
  if (cache === UNREADABLE) return Promise.resolve(UNREADABLE);
  const isRscPayload = new URL(request.url).pathname.endsWith("/index.txt");
  return readWithin(
    cache.match(request, {
      ignoreVary: true,
      ...(isRscPayload ? { ignoreSearch: true } : {}),
    }),
  );
}

/**
 * 資産を控えるときの鍵。RSC ペイロードだけはクエリを落として書く。
 * 落とさないと、遷移のたびに違う `?_rsc=<hash>` で同じ実体が積み上がり、
 * 照合（ignoreSearch）は最初の1つに当たり続けるので、増えた分は死蔵になる。
 *
 * 効くのは別置きだけ（世代に入っている `index.txt` は上の控えで返るので
 * ここへ来ない）。すなわち、任意分が取れなかった端末の周辺ページが対象。
 */
function assetKey(request) {
  const url = new URL(request.url);
  if (!url.pathname.endsWith("/index.txt")) return request.url;
  url.search = "";
  return url.toString();
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      // 焼き込まれていない版は名乗らせない。REQUIRED が空のまま活きると
      // 「何も控えないのに install は成功し、全 GET を溜め込むだけの世代なし
      // ワーカー」に静かに退化する（そのとき札は「そなえ済」と出てしまう）。
      // 落としておけば、サイトは Service Worker が居ないのと同じ挙動に戻る。
      if (BUILD === "__BUILD__" || REQUIRED.length === 0) {
        throw new Error("sw is not stamped");
      }
      // 活きている版がまだ無い端末に限り、先に古い `soneki-*` を掃除する。
      // install が途中で強制終了（タブを閉じた・端末が worker を回収した）
      // されると書きかけの世代が残るが、その掃除は activate ＝**成功した
      // install の後**にしか走らない。会場で install が続けて失敗する端末では
      // 掃除の機会が来ないまま容量だけが埋まり、やがて put が通らなくなって
      // 控えを永久に持てなくなる。
      // 活きている版がある場合は触らない（今まさに配っている控えを抜く）。
      // 掃除そのものは best-effort。ここで投げたり返らなかったりすると、
      // 1本も取りに行かないまま install が落ちる／開いたままになる ＝掃除で
      // 救うはずだった端末を、掃除のせいで控え無しに固定してしまう。
      if (self.registration.active === null) {
        await atMost(sweepStale(), STEP_TIMEOUT_MS);
      }

      // 必須分は all-or-nothing（版ズレを構造的に防ぐ）。
      // 1本ずつ「取得してその場で控える」。期限も1本ごとに張る。
      // 控えを開く段にも期限を置く（開けないなら控えは持てないので、
      // 開いたまま止まるより、失敗として畳んで次の機会に回す方が良い）。
      const opening = timeoutSignal(STEP_TIMEOUT_MS);
      let cache;
      try {
        cache = await Promise.race([caches.open(CACHE), opening.expired]);
      } finally {
        opening.done();
      }
      if (cache === false) throw new Error("storage stalled");
      const got = await Promise.all(
        REQUIRED.map((path) =>
          fetchInto(cache, scoped(path), REQUIRED_TIMEOUT_MS),
        ),
      );
      if (got.some((ok) => !ok)) {
        // 取り切れなかった＝この世代は名乗らない。
        // 書きかけを残さない（半端な世代が残ると、版ズレした一式が
        // 「揃っている」ものとして読まれる）。
        // 後始末にも期限を置く。ここで返らないと install は開いたままになり、
        // 版は畳まれず（redundant にならず）再試行の機会も来ない。
        await atMost(caches.delete(CACHE), STEP_TIMEOUT_MS);
        // **throw する**のが要点で、ここで return すると install が「成功」と
        // して解決してしまい、sw.js のバイトが変わらない限り二度と install が
        // 走らない＝一度取りこぼした端末が次のデプロイまで永久に控えを持てない。
        throw new Error("precache incomplete");
      }

      // 周辺ページは取れたら控える（取れなくても世代は成立させる）。
      // 必須集合を小さく保つほど、混雑した回線での成立率が上がる。
      // 任意分にも時間切れを付ける。付けないと、必須が全て揃っているのに
      // 任意の1本が無応答（エラーではなく沈黙）なだけで install が完了せず、
      // activate も「そなえ済」への繰り上げも起きない。
      await Promise.all(
        OPTIONAL.map((path) =>
          fetchInto(cache, scoped(path), OPTIONAL_TIMEOUT_MS),
        ),
      );

      // 初回インストール（既存の版が無い）に限り、待たずに制御下へ入る。
      // 初回訪問の「そなえ中 → そなえ済」をその場で成立させるため。
      // 更新時は待機のままにして、開いているページの資産を途中ですり替えない
      // （会場で再読み込みを促す UI は作らない方針＝次の自然な立ち上げで入れ替わる）。
      if (self.registration.active === null) await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // 旧世代の掃除は始めるだけにして、待つのは制御を引き取った後にする。
      // 掃除は後片付けにすぎないのに、その決着を待ってから claim すると、
      // 記憶域が読めない／返らない端末では claim へ届かない（届いても期限の
      // ぶん遅れる）。そのあいだ控えは揃っているのにページは制御下に入らず、
      // ページ側は controllerchange を待ち続けて札が「そなえ中（開いたまま）」
      // で止まる ＝取れている控えを、取れていないかのように見せる。
      // atMost で括るのは**作る時点**。後から括ると、失敗が誰にも受け取られない
      // まま次の待ちを跨ぎ、unhandledrejection として worker の外に出る。
      // どちらの atMost も仕事は止めず、待つのをやめるだけ（失敗も飲む）。
      const swept = atMost(sweepStale(), STEP_TIMEOUT_MS);
      await atMost((async () => self.clients.claim())(), STEP_TIMEOUT_MS);
      await swept;
    })(),
  );
});

/** 控えが無いページをオフラインで開いたときの最後の受け皿。 */
function offlineNotice(request) {
  // 別ページの HTML を代わりに返すと「カウンターを開いたのにシミュレータが出る」
  // という取り違えになる。何が起きているかだけを正直に出す。
  // ⚠️ 色は app/choba.css のトークンと同値の複製（Service Worker から CSS を
  //    読めないため避けられない）。片方を変えたら両方直すこと。対応は:
  //      #f9f7f0 = --kami(昼) / #1f242e = --sumi(昼) / #fefdfb = --kami-2(昼)
  //      #15181e = --kami(夜) / #ede9de = --sumi(夜) / #1f2229 = --kami-2(夜)
  //      #2f5aa0 = --ai(昼) / #84b1eb = --ai(夜)
  //    夜帳のリンク色を落とすと、この画面で唯一操作できる要素が 2.34:1
  //    （AA 未達）になる。昼夜の対で必ず持つこと。
  // 相対 URL で書くと、この画面が出る場面（/terms/ や未知パスを圏外で開いた時）
  // ほど解決先が外れる。唯一の出口なので scope 基準の絶対パスで組む。
  // 行き先は手書きせず、焼き込まれた値を使う（lib/offline.ts が正本で、
  // sw.js 側に二重定義を作らないため）。
  const tallyHref = new URL(SHELL_MAIN, self.registration.scope).pathname;
  void request;
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ひらけません — 同人ソンエキ</title>
<style>body{margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;
background:#f9f7f0;color:#1f242e;font-family:"Hiragino Kaku Gothic ProN","Hiragino Sans",sans-serif}
main{max-width:28rem;padding:24px;border:2px solid #1f242e;background:#fefdfb}
h1{font-family:"Hiragino Mincho ProN","Yu Mincho",serif;font-size:20px;margin:0 0 12px}
p{margin:8px 0 0;font-size:14px;line-height:1.9}
a{color:#2f5aa0}
@media(prefers-color-scheme:dark){body{background:#15181e;color:#ede9de}main{background:#1f2229;border-color:#ede9de}a{color:#84b1eb}}
</style></head><body><main>
<h1>このページの控えがありません</h1>
<p>電波の届くところで一度ひらくと、次からは通信が無くても開けるようになります。</p>
<p>すでに記帳した内容は、この端末の中に残っています。消えていません。</p>
<p><a href="${tallyHref}">頒布カウンターをひらく</a></p>
</main></body></html>`;
  return new Response(html, {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/** ネットワークを待ちつつ、時間切れなら控えを返す（控えが無ければ待ち続ける）。 */
async function networkFirstWithFallback(request, cache) {
  const hit = await matchPage(cache, request);
  // 読めなかった回は「控え無し」として進む。ここは控えに書き戻さないので、
  // 読めないまま進んでも世代に混ざるものが無い。
  const cached = hit === UNREADABLE ? undefined : hit;
  // ネットワークで取れた本文を**世代の控えに書き戻さない**。
  // 書き戻すと「HTML だけ新しい世代・JS は古い世代のまま」という版ズレを
  // 世代キャッシュの内側に作れてしまう（install の all-or-nothing が守って
  // いる不変条件を、実行時の1行が破る）。控えの更新は
  // 「sw の更新 → install → activate」だけが行う。
  // 控えには書かないので、この取得の結果を読むのは下の勝負だけ。
  // だから waitUntil で引き延ばさない。引き延ばすと、控えを返して用が済んだ後も
  // 沈黙した1本のために Service Worker が生かされ続ける（会場では電池が要る）。
  const network = fetch(request).catch(() => null);

  if (cached) {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS);
    });
    const winner = await Promise.race([network, timeout]);
    clearTimeout(timer);
    // 4xx/5xx は「取れた」に数えない。控えのある画面を、配信面や経路の一時的な
    // 不調が返したエラーページで置き換えると、控えがあるのに当日ひらけなくなる。
    // 転送（navigate は redirect:"manual" なので type:"opaqueredirect"＝ok は false）も
    // 同じ扱いにする。控えのある URL が正しく転送されることはこの静的配信では無く、
    // 会場で転送が返るのはたいてい接続前のログイン画面だからである。
    // 控えが無い場合は下で素通しするので、正当な転送はブラウザが追える。
    if (winner && winner.ok) return winner;
    // 使わない応答は本文を閉じる。開いたままにすると、混雑した回線で
    // 読まれない流れが worker に溜まる。
    discardBody(winner);
    // 時間切れで見切った側は、この後で届く。届いた分も閉じる
    // （会場で常に通るのはこちらの経路なので、ここを抜かすと意味が無い）。
    if (winner === null) void network.then(discardBody);
    return cached;
  }

  // `??` は使わない。この1行の構文だけで、Service Worker は動くが新しい構文を
  // 解さないブラウザで sw.js 全体が読めなくなる（＝控えが丸ごと取れない）。
  const fetched = await network;
  return fetched === null ? offlineNotice(request) : fetched;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  // 離脱済みならこの版は何もしない（消した控えを作り直さない）
  if (optedOut) return;

  const url = new URL(request.url);
  // 逃げ道: ?nosw のページを開いたら、この登録自体を解除する。
  // 介入を止めるだけでは、生成された文書は依然この登録の制御下に入り、
  // そのページが読む JS/CSS は結局ここを通ってしまう（＝逃がせない）。
  if (url.searchParams.has("nosw")) {
    if (request.mode === "navigate") {
      optedOut = true;
      // 登録の解除と控えの破棄をここで完結させる。ページ側にも同じ撤去は
      // 置いてあるが、そちらは JS が動くことが前提。壊れた版から逃げる手段が
      // 「アプリが正常に動くこと」に依存していては、要る場面で効かない。
      // 控えの破棄と登録の解除を**別々に**守る。まとめて await すると、記憶域が
      // 読めない／返らない端末では破棄で止まった時点で解除まで届かず、この版が
      // 制御を持ったまま残る（optedOut は worker が畳まれるまでの一時的な札
      // なので、次の起動ではまた横取りが始まる）。逃げ道は壊れた端末でこそ
      // 効く必要がある。atMost は失敗も沈黙もここで受け止める。
      event.waitUntil(
        (async () => {
          const purge = (async () => {
            const names = await caches.keys();
            // 1本の失敗で残りを止めない（消せた分だけでも減らす）。
            await Promise.all(
              names
                .filter((n) => n.startsWith("soneki-"))
                .map((n) => caches.delete(n).catch(() => false)),
            );
          })();
          await atMost(purge, STEP_TIMEOUT_MS);
          await atMost(self.registration.unregister(), STEP_TIMEOUT_MS);
        })(),
      );
    }
    return;
  }

  const scope = new URL(self.registration.scope);
  // 別オリジン（アクセス解析など）と、制御範囲の外には介入しない
  if (url.origin !== scope.origin) return;
  // scope 直下のスラッシュ無し URL（/doujin-soneki）も自分の範囲として扱う
  const inScope =
    url.pathname.startsWith(scope.pathname) ||
    `${url.pathname}/` === scope.pathname;
  if (!inScope) return;

  event.respondWith(
    (async () => {
      try {
        return await respond(event, request);
      } catch {
        // Cache Storage が読めない端末（容量逼迫・記憶域の破損）でここが
        // 転ぶと、respondWith は network error になる ＝回線が完全でも
        // サイトが開けない。Service Worker が居ない方がマシ、という状態を
        // 作らないため、素通しに落とす。
        try {
          return await fetch(request);
        } catch {
          return request.mode === "navigate"
            ? offlineNotice(request)
            : Response.error();
        }
      }
    })(),
  );
});

/** 取り出しの本体（控え→別置き→ネットワーク）。 */
async function respond(event, request) {
  const cache = await openCache(CACHE);
  if (request.mode === "navigate") {
    return networkFirstWithFallback(request, cache);
  }

  // この世代の控え。ハッシュ付き資産も RSC ペイロードも manifest も、
  // 世代内で完結しているのでそのまま出す（そして書き換えない）。
  //
  // RSC ペイロードはハッシュを持たない（`<ルート>/index.txt`）ので、更新の直後、
  // 旧版が現役のまま新しい HTML をネットワークから受け取ったページに対して、
  // 旧世代のペイロードを返す組み合わせが起こりうる。ここをネットワーク優先に
  // 倒さないのは、当日の会場（遅いが繋がる回線）で画面の行き来のたびに
  // 時間切れまで待たせることになり、この機能が守ろうとしている当のものを
  // 損なうため。版が食い違ったとき Next は payload の buildId を突き合わせて
  // ブラウザ遷移に落とす（fetchServerResponse: `if (buildId !== payloadBuildId)`
  // で MPA 遷移へ）ので、結果は「その1回だけ全体再読み込みになる」で収まり、
  // 古い内容が出たり遷移が壊れたりはしない。
  // ここで裏の更新をかけると、新しいデプロイの実体が旧世代の中に混ざり、
  // all-or-nothing が守っている版の一致がその世代の内側で崩れる。
  const shipped = await matchAsset(cache, request);
  if (shipped === UNREADABLE) {
    // 世代を確かめられなかった。この回は控えに一切触らずに素通しする。
    // 先へ進むと、世代に入っているはずの URL にネットワークの応答を別置きへ
    // 貼り付け、以後それを返す ＝封をした世代の外側に版ズレを作る
    // （会場の捕捉ページが 200 を返す回線では、JS の URL に HTML が入る）。
    return passThrough(request);
  }
  if (shipped) return shipped;

  // ここから先は世代に属さない同一オリジンの取得物。書くのは別置きだけ。
  const opened = await openCache(RUNTIME);
  const runtime = opened === UNREADABLE ? null : opened;
  const held = runtime === null ? UNREADABLE : await matchAsset(runtime, request);
  // 別置きを読めなかった回も、書かずに素通しする（何が入っているか分からない
  // まま上書きすると、次の取り出しでそれを返すことになる）。
  const cached = held === UNREADABLE ? undefined : held;
  const writable = held === UNREADABLE ? null : runtime;
  const key = assetKey(request);

  // 控え優先で出しつつ裏で更新しておく。
  // 裏の更新にも期限を置く。既に控えを返した後なので待つ理由が無く、
  // 期限が無いと沈黙した1本が waitUntil を握ったまま Service Worker を
  // 生かし続ける（会場では端末の電池が要る）。
  if (cached) {
    const budget = timeoutSignal(RUNTIME_TIMEOUT_MS);
    const refresh = fetch(request, { signal: budget.signal })
      .then(async (res) => {
        if (res.ok) await putSafe(writable, key, res);
        else discardBody(res);
      })
      .catch(() => {
        /* 圏外・時間切れ。控えのままでよい */
      })
      .then(() => budget.done());
    // signal だけに頼らない。中断が使えない端末では signal が効かず、
    // 沈黙した1本が waitUntil を握ったまま worker を生かし続ける。
    try {
      event.waitUntil(atMost(refresh, RUNTIME_TIMEOUT_MS));
    } catch {
      // 引き延ばしを受け付けない状態でも、控えは返す。ここで投げると外側の
      // 受けが取り直しに行き、控えがあるのに回線の応答（会場の捕捉ページ）を
      // 返すことになる。
    }
    return cached;
  }

  let res;
  try {
    res = await fetch(request);
  } catch {
    // 圏外。ここで投げると外側の受けが**もう一度**取りに行くので、
    // 混雑した回線で待ち時間が倍になる。navigate は上で処理済み。
    return Response.error();
  }
  // 控えへの書き込みを待たずに返す（長いストリームで応答が止まらないよう）。
  // 書き込みは裏で行う。ここで縛れるのは **Service Worker の寿命だけ** で、
  // 複製の読み出し自体は止められない（この応答はページへ返すものなので、
  // signal で中断するとページの読み込みごと壊す）。
  //
  // ここを try で覆わない。取れた応答を、控えへの書き込みの都合（waitUntil が
  // 受け付けない・複製できない）で捨ててはならない。
  if (res.ok && writable !== null) {
    try {
      event.waitUntil(
        atMost(putSafe(writable, key, res.clone()), RUNTIME_TIMEOUT_MS),
      );
    } catch {
      /* 控えが1つ増えないだけ。取れた応答はそのまま返す */
    }
  }
  return res;
}
