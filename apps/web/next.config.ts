import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace paketleri ham TypeScript disa aktarir; derlemesini Next yapar.
  transpilePackages: ["@arilla/core", "@arilla/ui"],
};

export default nextConfig;
