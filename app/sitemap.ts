// サイトマップ（静的 export 時に out/sitemap.xml として書き出される）。
// URL は SITE_URL（末尾スラッシュ）基準の絶対 URL。各ルートの index.html に対応。
import type { MetadataRoute } from "next";
import { SITE_URL } from "./config";

/** 収録ルート（"" = トップ、以降はサブパス。trailingSlash に合わせ末尾スラッシュ）。 */
const ROUTES = ["", "tally/", "privacy/", "terms/"] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  return ROUTES.map((path) => ({
    url: `${SITE_URL}${path}`,
    changeFrequency: path === "" ? "weekly" : "monthly",
    priority: path === "" ? 1 : 0.6,
  }));
}
