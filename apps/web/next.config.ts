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
  // D-65. The Prisma client is generated to packages/db/generated/client, not
  // node_modules, so it is bundled and cannot find its query engine on Vercel
  // (it searches /var/task/apps/web/packages/db/…, which never exists). Trace
  // the engine into every function; PRISMA_QUERY_ENGINE_LIBRARY, set on the
  // Vercel project, names its absolute path. Local and CI never read this.
  outputFileTracingIncludes: {
    "/**": ["../../packages/db/generated/client/libquery_engine-rhel-openssl-3.0.x.so.node"],
  },

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
