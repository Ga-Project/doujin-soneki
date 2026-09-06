/*
 * 控えの取り消し用 Service Worker（kill switch）。
 *
 * 使い方: 配ってしまった Service Worker が原因で画面が壊れたときに、
 * このファイルの中身で `public/sw.js` を上書きして push する。
 * 手順の全文は README「当日そなえ（オフライン対応）」を参照。
 *
 * これを配ると、各端末は次にサイトを開いた時点で
 *   ①この版に更新 →②控えを全部削除 →③自分の登録を解除 →④ページを再読み込み
 * を行い、以後は素の（Service Worker の無い）サイトに戻る。
 */

// ビルド後の焼き込み（scripts/stamp-sw.mjs）はこの3つの宣言を必須にしている。
// kill 版は何も控えないので中身は使わないが、宣言が無いとビルドが落ち、
// **まさに kill switch が要る場面で配れない**（回復手段が出荷不能になる）。
const BUILD = "__BUILD__";
const SHELL_MAIN = "__SHELL_MAIN__";
const REQUIRED = ["__REQUIRED__"].filter((p) => p !== "__REQUIRED__");
const OPTIONAL = ["__OPTIONAL__"].filter((p) => p !== "__OPTIONAL__");
void BUILD;
void SHELL_MAIN;
void REQUIRED;
void OPTIONAL;

/**
 * 待つのをやめる上限（ms）。仕事そのものは止めない。
 * 記憶域が返らない端末では、控えの破棄で止まったきり解除も開き直しも
 * 起きない ＝回復手段が要る場面で静かに効かない。失敗もここで受け止める。
 */
const STEP_TIMEOUT_MS = 5000;

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

self.addEventListener("install", (event) => {
  // 失敗や沈黙で install ごと落とさない（落とすと取り消し版が入らず、
  // まさに回復が要る場面で配れない）。繰り上げが効かなくても、次の
  // 立ち上げで活性化すれば撤去は走る。
  event.waitUntil(atMost((async () => self.skipWaiting())(), STEP_TIMEOUT_MS));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // 撤去の3手（控えの破棄・登録の解除・開き直し）を**別々に**守る。
      // まとめて await すると、記憶域が読めない／返らない端末では控えの破棄で
      // 止まった時点で解除も開き直しも起きない ＝回復手段が要る場面で静かに
      // 効かない。素のサイトへ戻すのに要るのは解除だけなので、前段で止めない。
      const purge = (async () => {
        // 同一オリジンには別の公開物も載るため、消すのは自分の世代だけに絞る。
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
      // 制御下のページを、Service Worker の居ない状態で開き直させる。
      // 開き直した先が登録し直すとこの版が入り直し、解除と再読み込みを
      // 繰り返す（無限ループ）。ページ側の登録は app/config.ts の
      // SONAE_ENABLED = false で止めておくこと。片方だけでは止まらない。
      // navigate() を持たない実装がある。素で呼ぶと unregister の後で投げ、
      // 開き直しが起きないまま activate ごと失敗する（回復手段が要る場面で
      // 静かに効かない）。拒まれた場合も、利用者が自分で開き直せば戻れる。
      const reopen = (async () => {
        const clients = await self.clients.matchAll({ type: "window" });
        // 1つずつ待たない。返らないタブが1つあると、残りのタブが壊れた版の
        // まま取り残される（撤去は済んでいるのに画面だけ戻らない）。
        await Promise.all(
          clients.map((client) => {
            // 素で呼ぶと、その場で投げる実装が1つあるだけで残りの map が
            // 走らない（返ってくる約束の catch では同期の throw を拾えない）。
            try {
              if (typeof client.navigate !== "function") return null;
              return client.navigate(client.url).catch(() => {
                /* 開き直させられなくても解除は済んでいる */
              });
            } catch {
              /* この1つを諦めるだけ。解除はもう済んでいる */
              return null;
            }
          }),
        );
      })();
      await atMost(reopen, STEP_TIMEOUT_MS);
    })(),
  );
});

// 何も控えず、何も横取りしない
self.addEventListener("fetch", () => {});
