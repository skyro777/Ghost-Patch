import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // The preview panel serves this app from preview-chat-<session>.space-z.ai
  // through the sandbox gateway, so Next's dev server sees "cross-origin"
  // /_next/* + HMR requests. Listing the pattern here switches dev mode from
  // warn-only to enforced-allowlist and silences the cross-origin warnings.
  allowedDevOrigins: ["*.space-z.ai"],
};

export default nextConfig;
