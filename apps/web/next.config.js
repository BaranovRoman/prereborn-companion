/** @type {import('next').NextConfig} */
const nextConfig = {
  // WK-80 - traces the real runtime import graph into .next/standalone so
  // production can run from a self-contained artifact instead of the full
  // monorepo node_modules tree. See docs/research/wk-80-build-outside-production.md.
  output: "standalone",
  reactStrictMode: true,
  transpilePackages: ["antd", "@ant-design/icons"],
  sassOptions: { api: "modern-compiler" },
  images: { formats: ["image/avif", "image/webp"] },
  // WK-196 - the overlay page URL carries the streamer's public token; the
  // browser default (strict-origin-when-cross-origin) would send that full
  // URL as Referer on every same-origin request the page makes (API
  // polling, /_next/static, /media), i.e. into server logs. strict-origin
  // sends only https://prereborn.ru.
  async headers() {
    return [
      { source: "/overlay/:path*", headers: [{ key: "Referrer-Policy", value: "strict-origin" }] }
    ];
  },
  async rewrites() {
    const backendUrl = process.env.BACKEND_URL || "http://127.0.0.1:3001";
    return [
      { source: "/api/:path*", destination: `${backendUrl}/api/:path*` },
      { source: "/uploads/:path*", destination: `${backendUrl}/uploads/:path*` }
    ];
  },
  turbopack: {
    resolveAlias: { "@": "./src" },
    resolveExtensions: [".js", ".jsx", ".ts", ".tsx", ".json"]
  }
};
module.exports = nextConfig;
