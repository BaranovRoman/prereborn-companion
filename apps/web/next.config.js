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
