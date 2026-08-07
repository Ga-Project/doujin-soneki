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
 * ■ 取り出し方（3種類だけ）
 *   1. ページ遷移(navigate) … ネットワーク優先＋時間切れで控えへ（遅い会場回線で待たされない）
 *   2. その世代の資産        … 控え優先（世代内で完結しているので必ず整合する）
 *   3. それ以外の同一オリジン … 控えがあれば出しつつ裏で更新
 * 別オリジン（アクセス解析など）は一切介入しない。
 *
 * ■ 逃げ道（回復手段）
 *   - URL に `?nosw` を付けて開くと、この登録自体を解除して素のサイトへ戻る
 *   - 控えが壊れたときの止め方は README「当日そなえ（オフライン対応）」を参照
 */

// ビルドごとに一意な世代名。stamp-sw.mjs がこの宣言を置換する。
const BUILD = "__BUILD__";
const CACHE = `soneki-${BUILD}`;

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

/** scope 基準の絶対 URL に解決する。 */
function scoped(path) {
  return new URL(path, self.registration.scope).toString();
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
  return cache.match(request, { ignoreSearch: true, ignoreVary: true });
}

/** 資産の照合。クエリは区別する（キャッシュ破りを殺さない）。 */
function matchAsset(cache, request) {
  return cache.match(request, { ignoreVary: true });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      // 必須分は all-or-nothing（版ズレを構造的に防ぐ）。
      const entries = await Promise.all(
        REQUIRED.map(async (path) => {
          const url = scoped(path);
          try {
            const res = await fetch(url, { cache: "reload" });
            return res.ok ? [url, res] : null;
          } catch {
            return null;
          }
        }),
      );
      if (entries.some((e) => e === null)) {
        // 取り切れなかった＝この世代は名乗らない。**throw する**のが要点で、
        // ここで return すると install が「成功」として解決してしまい、
        // sw.js のバイトが変わらない限り二度と install が走らない
        // ＝一度取りこぼした端末が次のデプロイまで永久に控えを持てない。
        throw new Error("precache incomplete");
      }
      // ここでの put 失敗は「控えが1つ増えない」ではなく「版ズレした世代が
      // 成立する」ことを意味する（本文の転送は put の中で起きるので、
      // 混雑した回線で切れる失敗は res.ok を素通りしてここへ来る）。
      // したがって install では握りつぶさず、欠けたら世代ごと捨てる。
      const cache = await caches.open(CACHE);
      try {
        for (const [url, res] of entries) await cache.put(url, res);
      } catch (e) {
        await caches.delete(CACHE);
        throw e;
      }

      // 周辺ページは取れたら控える（取れなくても世代は成立させる）。
      // 必須集合を小さく保つほど、混雑した回線での成立率が上がる。
      await Promise.all(
        OPTIONAL.map(async (path) => {
          const url = scoped(path);
          try {
            const res = await fetch(url, { cache: "reload" });
            if (res.ok) await putSafe(cache, url, res);
          } catch {
            /* 任意なので取れなくてよい */
          }
        }),
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
      // 旧世代を掃除する。activate は全クライアントが離れた後なので、
      // 開いているページの足元から資産を抜くことにはならない。
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith("soneki-") && n !== CACHE)
          .map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

/** 控えが無いページをオフラインで開いたときの最後の受け皿。 */
function offlineNotice() {
  // 別ページの HTML を代わりに返すと「カウンターを開いたのにシミュレータが出る」
  // という取り違えになる。何が起きているかだけを正直に出す。
  // ⚠️ 色は app/choba.css のトークンと同値の複製（Service Worker から CSS を
  //    読めないため避けられない）。片方を変えたら両方直すこと。対応は:
  //      #f9f7f0 = --kami(昼) / #1f242e = --sumi(昼) / #fefdfb = --kami-2(昼)
  //      #151820 = --kami(夜) / #ede9de = --sumi(夜) / #1f2229 = --kami-2(夜)
  //      #2f5aa0 = --ai(昼)
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ひらけません — 同人ソンエキ</title>
<style>body{margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;
background:#f9f7f0;color:#1f242e;font-family:"Hiragino Kaku Gothic ProN","Hiragino Sans",sans-serif}
main{max-width:28rem;padding:24px;border:2px solid #1f242e;background:#fefdfb}
h1{font-family:"Hiragino Mincho ProN","Yu Mincho",serif;font-size:20px;margin:0 0 12px}
p{margin:8px 0 0;font-size:14px;line-height:1.9}
a{color:#2f5aa0}
@media(prefers-color-scheme:dark){body{background:#151820;color:#ede9de}main{background:#1f2229;border-color:#ede9de}}
</style></head><body><main>
<h1>このページの控えがありません</h1>
<p>電波の届くところで一度ひらくと、次からは通信が無くても開けるようになります。</p>
<p>すでに記帳した内容は、この端末の中に残っています。消えていません。</p>
<p><a href="./tally/">頒布カウンターをひらく</a></p>
</main></body></html>`;
  return new Response(html, {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/** ネットワークを待ちつつ、時間切れなら控えを返す（控えが無ければ待ち続ける）。 */
async function networkFirstWithFallback(event, request, cache) {
  const cached = await matchPage(cache, request);
  const network = fetch(request)
    .then(async (res) => {
      // 取れた本文だけを控えに反映する（エラーページで上書きしない）。
      // クエリを落としたキーで書き、utm 違いの重複が溜まらないようにする。
      if (res.ok) {
        const key = new URL(request.url);
        key.search = "";
        await putSafe(cache, key.toString(), res.clone());
      }
      return res;
    })
    .catch(() => null);
  // 勝敗が決まっても裏の取得と控えへの反映は最後まで走らせる
  event.waitUntil(network);

  if (cached) {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS);
    });
    const winner = await Promise.race([network, timeout]);
    clearTimeout(timer);
    return winner ?? cached;
  }

  return (await network) ?? offlineNotice();
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // 逃げ道: ?nosw のページを開いたら、この登録自体を解除する。
  // 介入を止めるだけでは、生成された文書は依然この登録の制御下に入り、
  // そのページが読む JS/CSS は結局ここを通ってしまう（＝逃がせない）。
  if (url.searchParams.has("nosw")) {
    if (request.mode === "navigate") {
      event.waitUntil(self.registration.unregister());
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
      const cache = await caches.open(CACHE);
      if (request.mode === "navigate") {
        return networkFirstWithFallback(event, request, cache);
      }

      const cached = await matchAsset(cache, request);
      // ハッシュ付きで内容不変。世代内で完結しているので控えをそのまま出す
      if (cached && url.pathname.includes("/_next/static/")) return cached;

      // 画像・manifest 等：控え優先で出しつつ裏で更新しておく
      if (cached) {
        event.waitUntil(
          fetch(request)
            .then(async (res) => {
              if (res.ok) await putSafe(cache, request, res);
            })
            .catch(() => {
              /* 圏外。控えのままでよい */
            }),
        );
        return cached;
      }

      try {
        const res = await fetch(request);
        // 控えへの書き込みを待たずに返す（長いストリームで応答が止まらないよう）
        if (res.ok) event.waitUntil(putSafe(cache, request, res.clone()));
        return res;
      } catch {
        // navigate は上で処理済みなのでここには来ない
        return Response.error();
      }
    })(),
  );
});
