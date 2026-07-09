import type { Metadata } from "next";
import type { ReactNode } from "react";
import Script from "next/script";
import "./globals.css";
// 製品の "顔"（accent/neutral/radius/density）を globals の後に上書きする。
import "./theme.css";
// 製品固有レイアウト（製図台シミュレータ／頒布タリー）。
import "./product.css";
import { SITE_URL, GOATCOUNTER_CODE } from "./config";

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
  },
  alternates: { canonical: SITE_URL },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>
        {children}
        {/* アクセス解析（cookieless・秘密キー不要）。GOATCOUNTER_CODE は publish 時に実コードへ。 */}
        <Script
          data-goatcounter={`https://${GOATCOUNTER_CODE}.goatcounter.com/count`}
          src="//gc.zgo.at/count.js"
          strategy="afterInteractive"
        />
      </body>
    </html>
  );
}
