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

プロジェクトページ（`<owner>.github.io/doujin-soneki/` のようなサブパス配信）の場合のみ、
`next.config.mjs` に `basePath: "/doujin-soneki"` / `assetPrefix: "/doujin-soneki/"` を足す
（ユーザー/組織ページやカスタムドメインのルート配信なら不要）。

## 構成

```
doujin-soneki/
├─ app/
│  ├─ page.tsx              # ランディング一体型シミュレータ（hero 直下に本体）
│  ├─ Simulator.tsx         # 損益分岐シミュレータ（クライアント・localStorage 自動保存）
│  ├─ ProfitChart.tsx       # SVG 損益グラフ（黒字/赤字ゾーン・分岐マーカー・スナップ読み取り）
│  ├─ tally/                # 頒布タリー（+1 / Undo / 搬入数 / オフライン動作）
│  ├─ terms/ ・ privacy/    # 利用規約・プライバシーポリシー
│  ├─ chrome.tsx            # 共通ヘッダー/フッター/ブランドマーク
│  ├─ storage.ts            # localStorage スキーマ（バージョン付き）と型安全ロード
│  ├─ config.ts             # 公開値（サイトURL・解析コード・委託先プリセット）
│  ├─ not-found.tsx         # 404 ページ（static export で out/404.html を生成）
│  ├─ layout.tsx            # globals.css / theme.css / product.css を import・SEO/OGP メタ
│  ├─ product.css           # 製品固有レイアウト（製図台 2 カラム / thumb-zone タリー）
│  └─ globals.css           # 共通デザイン基盤（CSS変数トークン+ベーススタイル・light/dark・a11y）
├─ lib/
│  └─ soneki.ts             # 中核計算ロジック（純関数・損益/分岐/目盛/タリー）
├─ public/                  # 静的アセット置き場
├─ test/
│  └─ soneki.test.mjs       # node:test の単体テスト（計算ロジック）
├─ next.config.mjs          # output: "export"（static export 設定）
├─ tsconfig.json            # ../../tsconfig.base.json を extends
├─ scripts/public-gate.sh   # 公開前ゲート（CI と手元で共通に走る検査）
├─ .github/workflows/       # pages.yml（公開前ゲート → ビルド → Pages 公開）
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

`app/layout.tsx` に cookieless のアナリティクススロットをコメントで用意してある。
公開直前に GoatCounter か Cloudflare Web Analytics のどちらか 1 つを有効化する。
公開タグは秘密ではないのでコード直書きで構わない（実トークンはコミットしてよい公開コード）。

## 秘密情報（このプロダクト専用の age 鍵）

static export は実行時サーバを持たないため、サーバ秘密は原則不要。
ただし age recipient 分離の枠組みは維持しておく（将来 env が要るときのため・blast radius 最小化／SECURITY.md §2.4）。

- 公開鍵: `age.recipient`（コミット可）
- 復号鍵: リポジトリ外のローカル鍵ストアに置く（**repo 外**・コミット厳禁）
- 正本: `secrets.age`（暗号文・通常は空の `.env.age.example` を暗号化しただけ・コミット可）
