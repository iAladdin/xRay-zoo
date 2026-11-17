import type { NextConfig } from "next";
const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  allowedDevOrigins: ["localhost", "127.0.0.1"],
};
export default config;
