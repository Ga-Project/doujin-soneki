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
 *   - URL に `?nosw` を付けると、この Service Worker は一切介入しない（素の網に到達できる）
 *   - 控えが壊れたときの止め方は README「当日そなえ（オフライン対応）」を参照
 */

// ビルドごとに一意な世代名。stamp-sw.mjs が __BUILD__ を置換する。
// 置換されないまま配信された場合は "dev" 世代として動く（ローカル開発）。
const BUILD = "__BUILD__";
const CACHE = `soneki-${BUILD}`;

// この世代で控える URL（scope 相対）。stamp-sw.mjs が配列ごと置換する。
// 未置換（＝ローカル開発の `next dev`）ではプレースホルダを落として空にし、
// 控えを作らずに素通しする（開発中に古い控えを掴ませない）。
const PRECACHE = ["__PRECACHE__"].filter((p) => p !== "__PRECACHE__");

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
 * クエリ違いで控えを取り逃さないための照合。
 * `?utm_source=...` 付きの共有リンクでも同じ控えに当てる。
 */
function matchCached(cache, request) {
  return cache.match(request, { ignoreSearch: true, ignoreVary: true });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      // all-or-nothing。1つでも欠けた世代は作らない（版ズレを構造的に防ぐ）。
      const entries = await Promise.all(
        PRECACHE.map(async (path) => {
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
        // 取り切れなかった＝この世代は名乗らない。次の訪問でやり直す。
        return;
      }
      const cache = await caches.open(CACHE);
      for (const [url, res] of entries) await putSafe(cache, url, res);

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
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ひらけません — 同人ソンエキ</title>
<style>body{margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;
background:#f9f7f0;color:#1f242e;font-family:"Hiragino Kaku Gothic ProN","Hiragino Sans",sans-serif}
main{max-width:28rem;padding:24px;border:2px solid #1f242e;background:#fdfcf7}
h1{font-family:"Hiragino Mincho ProN","Yu Mincho",serif;font-size:20px;margin:0 0 12px}
p{margin:8px 0 0;font-size:14px;line-height:1.9}
@media(prefers-color-scheme:dark){body{background:#151820;color:#e8e2d6}main{background:#1f242e;border-color:#e8e2d6}}
</style></head><body><main>
<h1>このページの控えがありません</h1>
<p>電波の届くところで一度ひらくと、次からは通信が無くても開けるようになります。</p>
<p>すでに記帳した内容は、この端末の中に残っています。消えていません。</p>
</main></body></html>`;
  return new Response(html, {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/** ネットワークを待ちつつ、時間切れなら控えを返す（控えが無ければ待ち続ける）。 */
async function networkFirstWithFallback(event, request, cache) {
  const cached = await matchCached(cache, request);
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
  // 逃げ道: ?nosw を付けた要求には一切介入しない（素の網に到達できる）
  if (url.searchParams.has("nosw")) return;

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

      const cached = await matchCached(cache, request);
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
        if (res.ok) await putSafe(cache, request, res.clone());
        return res;
      } catch {
        return request.mode === "navigate" ? offlineNotice() : Response.error();
      }
    })(),
  );
});
