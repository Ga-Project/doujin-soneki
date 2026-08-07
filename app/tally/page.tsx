import type { Metadata } from "next";
import { TallyApp } from "./TallyApp";
import { SITE_URL } from "../config";

const title = "即売会頒布カウンター｜同人ソンエキ";
const description =
  "即売会当日の頒布数を大きな＋1ボタンで数えるカウンター。押しまちがいは「ひとつ戻す」で取り消せます。記録は端末に自動保存。一度ひらいた端末なら、電波のない会場でも開けます。";

export const metadata: Metadata = {
  title,
  description,
  openGraph: {
    title,
    description,
    type: "website",
    locale: "ja_JP",
    images: [{ url: `${SITE_URL}og.png`, width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [`${SITE_URL}og.png`],
  },
  alternates: { canonical: `${SITE_URL}tally/` },
};

export default function TallyPage() {
  return <TallyApp />;
}
