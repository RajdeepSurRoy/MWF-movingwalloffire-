import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module; keep it out of the server bundle.
  serverExternalPackages: ["better-sqlite3"],
  // Development only: extra hostnames the dev server may be opened at (the attack lab uses 127.0.0.1).
  ...(process.env.LAB_DEV_ORIGINS && { allowedDevOrigins: process.env.LAB_DEV_ORIGINS.split(",") }),
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
