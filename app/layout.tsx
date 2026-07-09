import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
// 製品の "顔"（accent/neutral/radius/font/density）はここで上書きする。
// globals.css の後に読み込むこと（後勝ちで :root トークンを上書きするため）。
import "./theme.css";

// SEO/OGP の枠。各製品が title / description / openGraph を自分の内容に差し替える。
// metadataBase は公開 URL が決まったら設定する（OGP 画像の絶対 URL 解決に使う）。
export const metadata: Metadata = {
  title: "doujin-soneki",
  description: "doujin-soneki",
  openGraph: {
    title: "doujin-soneki",
    description: "doujin-soneki",
    type: "website",
    locale: "ja_JP",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>
        {/*
          analytics（公開直前に1つ有効化・cookieless・秘密キー不要）:
          (1) GoatCounter（GitHub Pages/汎用ホスティングで利用可）
          <script data-goatcounter="https://__GC_CODE__.goatcounter.com/count" async src="//gc.zgo.at/count.js" />
          (2) Cloudflare Web Analytics（Cloudflare 上に載せる場合）
          <script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"__CF_BEACON_TOKEN__"}' />
        */}
        {children}
      </body>
    </html>
  );
}
