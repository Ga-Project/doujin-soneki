# doujin-soneki — 同人ソンエキ

同人誌の損益分岐シミュレータ（`/`）と即売会当日の頒布カウンター（`/tally`）。
印刷所の階段単価・委託手数料・固定費から、損益分岐部数・完売時損益・頒価の目安を
SVG 損益グラフで表示する。登録不要・計算はすべてブラウザ内で完結し、入力は
localStorage にのみ保存される（サーバー送信なし）。

Next.js 14 (App Router)。static export（`out/` に静的書き出し）でサーバランタイム不要にし、ホスティングに配信する。

## セットアップ & 開発

```bash
./setup.sh                 # pnpm install
pnpm dev                   # http://localhost:3000（ホットリロード）
```

## ビルド（static export）

```bash
pnpm build                 # next build → out/ に静的 HTML/CSS/JS を生成
ls out/index.html          # 生成物の確認

./run.sh serve             # out/ をビルドしてローカル配信（http://localhost:3000）
```

`out/` がそのまま配信物。`next start`（サーバ常駐）は使わない。

## テスト

```bash
pnpm test                  # node --test（標準ランナー・追加の依存なし）
```

## デプロイ

GitHub Pages（GitHub Actions で自動デプロイ）。同梱の `.github/workflows/pages.yml` が
`main` への push で `pnpm build` → `out/` を Pages に公開する。公開前に同じワークフロー内で
`scripts/public-gate.sh`（公開前ゲート）が走り、不合格ならデプロイは行われない。

プロジェクトページ（`<owner>.github.io/doujin-soneki/` のようなサブパス配信）向けの
`basePath` / `assetPrefix` は、`pages.yml` の build step が env `PAGES_BASE_PATH=/<リポジトリ名>`
として `next.config.mjs` に渡す（ソース側の変更は不要）。ローカル開発・ルート配信では
env 未設定のままルート基準で動く。カスタムドメイン等でルート配信する場合は
`pages.yml` の該当 env を外す。

## 当日そなえ（オフライン対応）

即売会の会場は通信が混み、当日に頒布カウンターを開けないことがある。Service Worker
（`public/sw.js`）でアプリ一式の控えを端末に持たせ、**一度ひらいた端末なら接続が無くても
開ける**ようにしている。記帳データは従来どおり `localStorage`（Service Worker とは無関係）。

### 世代（generation）方式

控えは「ビルド1回＝1世代」で持つ。`pnpm build` は `next build` のあと
`scripts/stamp-sw.mjs` を走らせ、`out/sw.js` に **ビルド印** と **その世代で控える資産の一覧**
を焼き込む。一覧は**必須**（当日ひらくページと、それらが実際に読む実体）と
**任意**（周辺ページ・アイコン等）に分かれる。install は必須分を **all-or-nothing** で
取り込み、1つでも欠けたら世代を作らない。任意分は取れたら控えるだけで、
欠けても世代は成立する（必須集合を小さく保つほど、混雑した回線での成立率が上がる）。

こうする理由は、HTML と、その HTML が読み込む JS の世代がズレると
「画面は出るのに操作が効かない」という無音の故障になるため。世代ごとに自己完結させれば、
控えから開いた画面は必ず整合する。

旧世代の掃除は `activate` が行う。掃除は後片付けなので、失敗しても控えの成立や
制御の引き取りは止めない（消し損ねた世代は次の更新で片づく）。install が続けて
失敗して `activate` まで進めない端末では、次の install が（活きた版が無いときに限り）
先に古い世代を落とす。掃除の機会が来ないまま容量が埋まると、控えを永久に持てなくなるため。

install を終えた世代のキャッシュには以後**一切書かない**（封をする）。あとから一部だけを
新しい応答で差し替えると、その実体が要求するハッシュ付き JS はその世代に無く、
all-or-nothing で防いだはずの版ズレが世代の内側に成立してしまう。更新は
「sw の更新 → install → activate」だけが行う。世代に属さない同一オリジンの取得物は、
別置きの `soneki-rt-<ビルド印>` に置く（こちらは世代の整合に関与しない）。

### 控えが壊れたときの止め方（kill switch）

GitHub Pages は取り消しの効かない配信面で、回復手段は「新しい `sw.js` を配る」だけ。

1. 利用者にすぐ回避してもらうなら、URL に `?nosw` を付けて開いてもらう
   （例 `https://ga-project.github.io/doujin-soneki/tally/?nosw`）。**登録の解除と控えの
   全削除**を行い、その読み込みでは控えを取り直さない。判断はその読み込み限りで、
   端末には残さない — 残すと以後どの訪問でも札が「そなえ不可（要電波）」になり、
   原因が自分の操作であることが画面から分からないまま「当日は電波が要る」と
   誤って段取りを組ませてしまう。直した版を配れば自動で復帰する
   （`updateViaCache: "none"` なので差し替えは HTTP キャッシュに邪魔されず届く）。
   - 撤去は Service Worker 側とページ側の両方に置いてある。前者は壊れた版でも
     fetch ハンドラが生きていれば効き、後者は Service Worker が応答しなくても効く。
   - 介入を止めるだけでは足りない。逃げ道のページ自身が読む資産には `?nosw` が付かず、
     通常経路に落ちて**消したばかりの控えを作り直してしまう**（実測で確認済み）。
     そのため離脱後はこの版の介入自体を止めている。
2. 全端末から取り消すなら、次の2つを**同時に**行って push する。片方だけでは止まらない。
   - `scripts/sw-kill.js` の中身で `public/sw.js` を上書きする
   - `app/config.ts` の `SONAE_ENABLED` を `false` にする

   各端末は次にサイトを開いた時点で、登録の解除と控えの全削除を行い、素のサイトへ戻る。
   （登録時に `updateViaCache: "none"` を指定しているので、この差し替えは HTTP キャッシュに
   邪魔されず届く。）

   `SONAE_ENABLED` を落とすのは、取り消し版が制御下のページを開き直させるため。
   開き直した先がまた登録すると取り消し版が入り直し、解除と再読み込みを繰り返して
   素のサイトへ戻れなくなる（再読み込みの無限ループ）。

3. 直したら `public/sw.js` と `SONAE_ENABLED` を両方とも元に戻して push する。

### 色の扱い（manifest に書けないこと）

ステータスバーの地色は `app/layout.tsx` の `viewport.themeColor` で昼帳・夜帳それぞれの
地紙（`--kami`）に追従させている。一方 manifest の `background_color`（起動スプラッシュ）は
静的な1色しか持てないため、**帳面の地＝生成り** を選んで固定している。夜帳の端末では
起動の一瞬だけ生成りが出るが、これは仕様上の限界を承知のうえでの選択。
なお `app/choba.css` には `[data-theme]` の手動上書きが用意されている。将来テーマの
切替 UI を足すときは、`<meta name="theme-color">` を JS で書き換える処理も要る
（`viewport.themeColor` は OS 設定にしか追従しない）。

### アイコンを作り直す

意匠の正は `scripts/icon.html`。直したら `node scripts/make-icons.mjs` を流して
`public/icon-*.png` と `apple-touch-icon.png` を作り直す（macOS の Chrome と sips を使う）。


## 構成

```
doujin-soneki/
├─ app/
│  ├─ page.tsx              # ランディング一体型シミュレータ（hero 直下に本体）
│  ├─ Simulator.tsx         # 損益分岐シミュレータ（クライアント・localStorage 自動保存）
│  ├─ ProfitChart.tsx       # SVG 損益グラフ（黒字/赤字ゾーン・分岐マーカー・スナップ読み取り）
│  ├─ tally/                # 頒布タリー（+1 / Undo / 搬入数 / オフライン動作）
│  │  └─ useSonae.ts        # 当日そなえ（SW の登録と状態観測）
│  ├─ terms/ ・ privacy/    # 利用規約・プライバシーポリシー
│  ├─ chrome.tsx            # 共通ヘッダー/フッター/ブランドマーク
│  ├─ sonae.tsx             # 当日そなえの登録だけを行う（全ページ・描画なし）
│  ├─ storage.ts            # localStorage スキーマ（バージョン付き）と型安全ロード
│  ├─ config.ts             # 公開値（サイトURL・解析コード・委託先プリセット）
│  ├─ not-found.tsx         # 404 ページ（static export で out/404.html を生成）
│  ├─ layout.tsx            # globals.css / theme.css / product.css を import・SEO/OGP メタ
│  ├─ product.css           # 製品固有レイアウト（製図台 2 カラム / thumb-zone タリー）
│  └─ globals.css           # 共通デザイン基盤（CSS変数トークン+ベーススタイル・light/dark・a11y）
├─ lib/
│  ├─ soneki.ts             # 中核計算ロジック（純関数・損益/分岐/目盛/タリー）
│  └─ offline.ts            # 当日そなえの純ロジック（登録先の解決・状態判定）
├─ public/                  # 静的アセット置き場
│  ├─ sw.js                 # Service Worker（当日そなえ・世代方式の控え）
│  ├─ manifest.webmanifest  # ホーム画面に追加して単独起動するための宣言
│  └─ icon-*.png ほか       # アプリアイコン（scripts/make-icons.mjs で生成）
├─ test/
│  ├─ soneki.test.mjs       # node:test の単体テスト（計算ロジック）
│  └─ offline.test.mjs      # 同上（当日そなえ）
├─ next.config.mjs          # output: "export" + PAGES_BASE_PATH（static export 設定）
├─ tsconfig.json            # このリポジトリ単体で完結（extends なし・strict）
├─ scripts/public-gate.sh   # 公開前ゲート（CI と手元で共通に走る検査）
├─ .github/workflows/       # pages.yml（公開前ゲート → ビルド → Pages 公開）・ci.yml（test/lint/typecheck）
├─ secrets.age              # age 暗号文（静的配信では通常は空の暗号箱・コミット可）
├─ age.recipient            # このプロダクト専用の age 公開鍵
└─ .env.age.example         # env テンプレ（実行時サーバ秘密は原則不要・実値は書かない）
```

## デザイン基盤（共通トークン）＋ 製品の顔（theme 層）

デザインは 2 層構成:

- `app/globals.css` … **共通の構造・コンポーネント・a11y**（プレーン CSS + CSS 変数のみ・
  Tailwind 等のビルド不要・`output: "export"` と両立）。light/dark（`prefers-color-scheme`）・
  レスポンシブ・アクセシビリティ（コントラスト AA / `:focus-visible` リング /
  `prefers-reduced-motion` / タッチ 44px / skip-link）・レイヤード soft shadow・繊細な
  micro-interaction（hover lift / 押下感）・空状態 / ローディング（skeleton・spinner）/
  エラーバナーまで含む。accent は HSL を 1 か所（`--accent-h/s/l`）で定義し、hover/active/tint/
  ring を自動派生する。
- `app/theme.css` … **この製品の個性**。`globals.css` の後に読み込まれ、`:root` トークンを上書き
  する薄い層。色（`--accent-h/s/l`）・温度感（`--neutral-hue`）・形（`--radius`）・タイポ
  （`--font-sans` / `--font-display`）・密度（`--density`）を数トークン変えるだけで別物の顔になる。
  Mood preset（Trust / Warm / Editorial / Fresh）をコメントで同梱。

**製品別デザインは必須**: デフォルト（インディゴ・バイオレット）のまま出荷しないこと。各製品は
最低でも `app/theme.css` の `--accent-*` と `--neutral-hue` を製品の世界観に合わせて変える。
構造クラス（`.btn` / `.card` / `.hero` …）の見た目を個別 CSS で書き換えるのではなく、個性は
トークンで出す（一貫性と a11y を保ったまま化けさせる）。`--accent` を変える場合は light/dark
双方で WCAG AA を満たす L 値にすること（手順は `theme.css` 冒頭コメント参照）。

## アナリティクス（任意・公開直前に有効化）

GoatCounter（cookieless）を使う。`app/config.ts` の `GOATCOUNTER_CODE` に実コードを
設定したときだけ `app/layout.tsx` がタグを出力する。プレースホルダ（`__GC_CODE__`）の
ままではタグ自体を出力しないため、差し替え忘れで壊れたリクエストが飛ぶことはない。
公開コードは秘密ではないのでコミットしてよい。

## 秘密情報（このプロダクト専用の age 鍵）

static export は実行時サーバを持たないため、サーバ秘密は原則不要。
ただし age recipient 分離の枠組みは維持しておく（将来 env が要るときのため・blast radius 最小化／SECURITY.md §2.4）。

- 公開鍵: `age.recipient`（コミット可）
- 復号鍵: リポジトリ外のローカル鍵ストアに置く（**repo 外**・コミット厳禁）
- 正本: `secrets.age`（暗号文・通常は空の `.env.age.example` を暗号化しただけ・コミット可）
