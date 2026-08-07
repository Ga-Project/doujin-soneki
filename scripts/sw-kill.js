/*
 * 控えの取り消し用 Service Worker（kill switch）。
 *
 * 使い方: 配ってしまった Service Worker が原因で画面が壊れたときに、
 * このファイルの中身で `public/sw.js` を上書きして push する。
 * 手順の全文は README「当日そなえ（オフライン対応）」を参照。
 *
 * これを配ると、各端末は次にサイトを開いた時点で
 *   ①この版に更新 →②自分の登録を解除 →③控えを全部削除 →④ページを再読み込み
 * を行い、以後は素の（Service Worker の無い）サイトに戻る。
 */

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
      await self.registration.unregister();
      // 制御下のページを、Service Worker の居ない状態で開き直させる
      const clients = await self.clients.matchAll({ type: "window" });
      for (const client of clients) client.navigate(client.url);
    })(),
  );
});

// 何も控えず、何も横取りしない
self.addEventListener("fetch", () => {});
