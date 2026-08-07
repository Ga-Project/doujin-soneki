import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import Script from "next/script";
// デザインシステム「朱墨の帳場」— 本製品専用にゼロから構築したオリジナル体系。
import "./choba.css";
import { SITE_URL, GOATCOUNTER_CODE, GOATCOUNTER_CONFIGURED } from "./config";
import { normalizeBasePath } from "../lib/offline";
import { SonaeRegister } from "./sonae";

// Pages のサブパス配信（/doujin-soneki/）でも manifest・アイコンを取り違えないよう、
// ビルド時 basePath を前置した絶対パスで出す。
const BASE = normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH);

const title = "同人ソンエキ｜同人誌の損益分岐シミュレータ＆頒布カウンター";
const description =
  "印刷所の階段単価と委託手数料をまとめて計算し、損益分岐部数と手取りをグラフで確認できる同人サークル向けの無料ツール。即売会当日の頒布カウンター付き。登録不要、入力データはお使いの端末内にのみ保存されます。";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title,
  description,
  applicationName: "同人ソンエキ",
  keywords: [
    "同人誌",
    "損益分岐",
    "印刷費",
    "頒価",
    "部数",
    "委託",
    "手数料",
    "即売会",
    "頒布",
    "カウンター",
  ],
  openGraph: {
    title,
    description,
    type: "website",
    locale: "ja_JP",
    url: SITE_URL,
    siteName: "同人ソンエキ",
    // 共有時のカード画像。製品のデザインシステム「朱墨の帳場」で作った 1200×630。
    // metadataBase 相対だと Pages のサブパス配信で解決がぶれるため、絶対 URL で固定する。
    images: [
      {
        url: `${SITE_URL}og.png`,
        width: 1200,
        height: 630,
        alt: "同人ソンエキ — 同人誌の損益分岐シミュレータと頒布カウンター",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [`${SITE_URL}og.png`],
  },
  // canonical はページごとに設定する（全ページ固定にするとサブページが
  // 重複扱いでインデックス除外されるため、各 page.tsx の alternates で指定）

  // ホーム画面に追加して単独起動できるようにする（当日そなえ）。
  // 独自のインストールバナーは出さず、ブラウザ自身のインストール UI に任せる。
  manifest: `${BASE}/manifest.webmanifest`,
  icons: {
    icon: [
      // タブの favicon は 16〜32px まで縮む。枠と二字は潰れるので、
      // 枠を外して判を一字にした別意匠を小サイズ用に用意している。
      { url: `${BASE}/icon-32.png`, sizes: "32x32", type: "image/png" },
      { url: `${BASE}/icon-192.png`, sizes: "192x192", type: "image/png" },
      { url: `${BASE}/icon-512.png`, sizes: "512x512", type: "image/png" },
    ],
    // iOS は manifest のアイコンをホーム画面に使わない。これが無いと白紙になる。
    apple: [
      { url: `${BASE}/apple-touch-icon.png`, sizes: "180x180" },
    ],
  },
};

/**
 * ステータスバーの地色。manifest の theme_color は静的なので、夜帳の端末では
 * 「ステータスバーだけ生成り色」という継ぎ目が出る。昼帳・夜帳それぞれの
 * 地紙（--kami）をそのまま流し込んで、帳面と地続きに見せる。
 */
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "hsl(42 45% 96%)" },
    { media: "(prefers-color-scheme: dark)", color: "hsl(220 16% 10%)" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>
        {children}
        {/* 当日そなえ: 全ページで控えを取る（トップだけ見た端末にも要る） */}
        <SonaeRegister />
        {/* アクセス解析（cookieless・秘密キー不要）。config.ts の GOATCOUNTER_CODE に
            実コードを設定したときだけタグを出力する（プレースホルダのままなら出さない） */}
        {GOATCOUNTER_CONFIGURED && (
          <Script
            data-goatcounter={`https://${GOATCOUNTER_CODE}.goatcounter.com/count`}
            src="//gc.zgo.at/count.js"
            strategy="afterInteractive"
          />
        )}
      </body>
    </html>
  );
}
