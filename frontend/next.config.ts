import type { NextConfig } from "next";

// GitHub Pages build (read-only static snapshot): see scripts/build_pages.sh.
const STATIC_SNAPSHOT = process.env.NEXT_PUBLIC_STATIC_SNAPSHOT === "1";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  ...(STATIC_SNAPSHOT
    ? { output: "export" as const, distDir: ".next-pages", basePath: process.env.NEXT_PUBLIC_BASE_PATH || undefined, trailingSlash: true, images: { unoptimized: true } }
    : {}),
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
