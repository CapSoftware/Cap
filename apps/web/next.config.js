/** @type {import('next').NextConfig} */

require("dotenv").config({ path: "../../.env" });

if (
  !process.env.NEXT_PUBLIC_SUPABASE_URL ||
  !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  !process.env.SUPABASE_SERVICE_ROLE_KEY
) {
  throw new Error("Please set Supabase env vars in .env file");
}

if (!process.env.NEXT_PUBLIC_ENVIRONMENT || !process.env.NEXT_PUBLIC_URL) {
  throw new Error("Please set env vars in .env file");
}

const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,
  transpilePackages: ["ui", "utils"],
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  experimental: {
    optimizePackageImports: ["ui", "utils"],
  },
};

module.exports = nextConfig;
