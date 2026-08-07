// GitHub Pages のプロジェクトページ（owner.github.io/<slug>/）配信では、アセットを
// サブパス基準で出さないと /_next/... をルートから取りに行って 404 になる。
// 公開ビルド時のみ PAGES_BASE_PATH=/<slug> を渡してサブパス基準にする。
// ローカル開発・ルート配信では未設定のままルート基準で動く。
const basePath = process.env.PAGES_BASE_PATH || "";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // static export（out/ に静的書き出し）。サーバランタイム不要。
  output: "export",
  // export では Next の画像最適化サーバが使えないため無効化（最適化は事前に行うか CSS で対応）。
  images: { unoptimized: true },
  // 各ルートを /path/index.html として出力し、サブディレクトリ配信で 404 を避ける。
  trailingSlash: true,
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
  // Service Worker の登録先（basePath 直下の /sw.js）をクライアント側で組み立てるため、
  // ビルド時の basePath を公開値として焼き込む。app router には basePath を実行時に
  // 取り出す API が無く、ページ相対で解決すると /tally/sw.js を見に行って失敗する。
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
};

export default nextConfig;
