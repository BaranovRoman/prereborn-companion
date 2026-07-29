/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["antd", "@ant-design/icons"],
  sassOptions: { api: "modern-compiler" },
  images: { formats: ["image/avif", "image/webp"] },
  async rewrites() {
    const backendUrl = process.env.BACKEND_URL || "http://127.0.0.1:3001";
    return [{ source: "/api/:path*", destination: `${backendUrl}/api/:path*` }];
  },
  turbopack: {
    resolveAlias: { "@": "./src" },
    resolveExtensions: [".js", ".jsx", ".ts", ".tsx", ".json"]
  }
};
module.exports = nextConfig;

