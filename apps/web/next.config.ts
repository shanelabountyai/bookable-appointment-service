import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The workspace packages ship TypeScript SOURCE, not a build output — there
  // is no compile step for them, which is what keeps `packages/core` directly
  // runnable by vitest and readable by tsc. Next has to transpile them itself.
  transpilePackages: ["@bookable/core", "@bookable/db"],

  // A-013. The manage link's authority IS its URL (D-5), so the URL must not
  // travel. `Referer` carries the full path to anything the page ever links or
  // fetches, and a token in someone else's access log is a live link — this is
  // the one header that stops a bearer-in-the-path leaking by default.
  async headers() {
    return [
      {
        source: "/manage/:token*",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
    ];
  },
};

export default nextConfig;
