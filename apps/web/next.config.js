/** @type {import('next').NextConfig} */
const nextConfig = {
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
  async headers() {
    return [
      {
        source: "/vendor/valve/video/heroes/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=604800, stale-while-revalidate=86400"
          }
        ]
      }
    ];
  },
  turbopack: {
    resolveAlias: { "@": "./src" },
    resolveExtensions: [".js", ".jsx", ".ts", ".tsx", ".json"]
  }
};
module.exports = nextConfig;
