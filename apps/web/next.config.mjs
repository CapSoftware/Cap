import million from "million/compiler";

/** @type {import('next').NextConfig} */

import("dotenv").then(({ config }) => config({ path: "../../.env" }));

import fs from "fs";
import path from "path";

const packageJson = JSON.parse(
  fs.readFileSync(path.resolve("./package.json"), "utf8")
);
const { version } = packageJson;

const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,
  transpilePackages: ["@cap/ui", "@cap/utils"],
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  experimental: {
    optimizePackageImports: ["@cap/ui", "@cap/utils"],
    serverComponentsExternalPackages: [
      "@react-email/components",
      "@react-email/render",
      "@react-email/tailwind",
    ],
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.amazonaws.com",
        port: "",
        pathname: "**",
      },
    ],
  },
  async rewrites() {
    return [
      {
        source: "/:path*",
        has: [
          {
            type: "host",
            value: "cap.link",
          },
        ],
        destination: "/share/:path*",
      },
    ];
  },
  env: {
    appVersion: version,
  },
};

const millionConfig = {
  auto: {
    rsc: true,
    skip: ["Parallax"],
  },
};

export default million.next(nextConfig, millionConfig);
