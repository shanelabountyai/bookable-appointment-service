import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The workspace packages ship TypeScript SOURCE, not a build output — there
  // is no compile step for them, which is what keeps `packages/core` directly
  // runnable by vitest and readable by tsc. Next has to transpile them itself.
  transpilePackages: ["@bookable/core", "@bookable/db"],
};

export default nextConfig;
