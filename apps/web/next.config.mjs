import million from "million/compiler";

/** @type {import('next').NextConfig} */

import("dotenv").then(({ config }) => config({ path: "../../.env" }));

if (
  !process.env.NEXT_PUBLIC_SUPABASE_URL ||
  !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
) {
  throw new Error("Please set Supabase env vars in .env file");
}

if (!process.env.NEXT_PUBLIC_ENVIRONMENT || !process.env.NEXT_PUBLIC_URL) {
  throw new Error("Please set env vars in .env file");
}

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
  },
};

const millionConfig = {
  auto: {
    rsc: true,
  },
};

export default million.next(nextConfig, millionConfig);
