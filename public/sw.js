/*
 * 同人ソンエキ — Service Worker（当日そなえ）
 *
 * 目的: 即売会の会場は通信が混み、ページを開けない/読み込みが終わらないことがある。
 * 一度ひらいた端末にアプリシェルの控えを持たせ、接続が無くても・遅くても開けるようにする。
 * 記帳データ自体は従来どおり localStorage にあり、ここでは扱わない。
 *
 * 方針（3種類だけ）:
 *   1. ページ遷移(navigate) … ネットワーク優先＋時間切れで控えへ（遅い会場回線で待たされない）
 *   2. ハッシュ付き静的資産(_next/static) … 内容が変わらないので控え優先
 *   3. その他の同一オリジン GET … 控え優先＋裏で更新
 * 別オリジン（アクセス解析など）は一切介入しない。
 *
 * 制御範囲は registration.scope（= basePath 直下）。相対 URL は全て scope 基準で解決する。
 * 登録・状態判定は lib/offline.ts（単体テストあり）、ここは副作用の実行のみを持つ。
 */

// 控えの版。シェルの構成を変えたら上げる（activate で旧版を掃除する）。
const CACHE = "soneki-shell-v1";

// 端末に控えるページ。lib/offline.ts の SHELL_PATHS と同一物（scope 相対）。
const SHELL = ["", "tally/", "terms/", "privacy/"];

// 遅い会場回線で待たされないための時間切れ（ms）。
// これを過ぎたら控えを返す。控えが無ければネットワークの完了を待つ。
const NETWORK_TIMEOUT_MS = 3000;

/** scope 基準の絶対 URL に解決する。 */
function scoped(path) {
  return new URL(path, self.registration.scope).toString();
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // 1 つでも失敗すると addAll 全体が落ちるため、ページごとに独立して控える。
      // （取れなかったページは次の訪問で拾う。install 自体は失敗させない）
      await Promise.all(
        SHELL.map(async (path) => {
          try {
            const url = scoped(path);
            const res = await fetch(url, { cache: "reload" });
            if (res.ok) await cache.put(url, res);
          } catch {
            /* このページは次の訪問で控える */
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
      const names = await caches.keys();
      await Promise.all(
        names.map((n) => (n === CACHE ? undefined : caches.delete(n))),
      );
      await self.clients.claim();
    })(),
  );
});

/** ネットワークを待ちつつ、時間切れなら控えを返す（控えが無ければ待ち続ける）。 */
async function networkFirstWithFallback(request, cache) {
  const cached = await cache.match(request);
  const network = fetch(request)
    .then(async (res) => {
      // 取れた本文だけを控えに反映する（エラーページで上書きしない）
      if (res.ok) await cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);

  if (cached) {
    const timeout = new Promise((resolve) =>
      setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS),
    );
    const winner = await Promise.race([network, timeout]);
    return winner ?? cached;
  }

  const res = await network;
  if (res) return res;
  // 控えも無く取得もできない：scope のトップを最後の受け皿にする
  return (await cache.match(scoped(""))) ?? Response.error();
}

/** 控え優先。無ければ取得して控える。 */
async function cacheFirst(request, cache) {
  const cached = await cache.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok) await cache.put(request, res.clone());
  return res;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const scope = new URL(self.registration.scope);
  // 別オリジン（アクセス解析など）と、制御範囲の外には介入しない
  if (url.origin !== scope.origin) return;
  if (!url.pathname.startsWith(scope.pathname)) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      if (request.mode === "navigate") {
        return networkFirstWithFallback(request, cache);
      }
      // ハッシュ付きで内容不変。控えがあれば即返す
      if (url.pathname.includes("/_next/static/")) {
        return cacheFirst(request, cache);
      }
      // 画像・manifest 等：控え優先で出しつつ裏で更新しておく
      const cached = await cache.match(request);
      if (cached) {
        event.waitUntil(
          fetch(request)
            .then(async (res) => {
              if (res.ok) await cache.put(request, res);
            })
            .catch(() => {
              /* 圏外。控えのままでよい */
            }),
        );
        return cached;
      }
      try {
        return await cacheFirst(request, cache);
      } catch {
        return Response.error();
      }
    })(),
  );
});
