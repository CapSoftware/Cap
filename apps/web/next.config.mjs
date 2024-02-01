import million from "million/compiler";

/** @type {import('next').NextConfig} */

import("dotenv").then(({ config }) => config({ path: "../../.env" }));

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
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Access-Control-Allow-Origin",
            value: "https://*.amazonaws.com",
          },
          {
            key: "Access-Control-Allow-Methods",
            value: "GET",
          },
          {
            key: "Access-Control-Allow-Credentials",
            value: "true",
          },
        ],
      },
      {
        source: "/api/desktop/(.*)",
        headers: [
          {
            key: "Access-Control-Allow-Origin",
            value: "http://localhost:3001",
          },
          {
            key: "Access-Control-Allow-Methods",
            value: "GET",
          },
          {
            key: "Access-Control-Allow-Credentials",
            value: "true",
          },
        ],
      },
    ];
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
};

const millionConfig = {
  auto: {
    rsc: true,
    skip: ["Parallax"],
  },
};

export default million.next(nextConfig, millionConfig);
