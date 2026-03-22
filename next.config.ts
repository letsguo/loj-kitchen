import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pg", "@google-cloud/vision", "google-gax"],
};

export default nextConfig;
