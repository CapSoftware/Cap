/** @type {import('next').NextConfig} */

import("dotenv").then(({ config }) => config({ path: "../../.env" }));

const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,
  output: "export",
  transpilePackages: ["@cap/ui", "@cap/utils"],
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  experimental: {
    optimizePackageImports: ["@cap/ui", "@cap/utils"],
  },
};

export default nextConfig;
