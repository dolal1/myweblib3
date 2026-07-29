import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    /**
     * Required by `unauthorized()` and `forbidden()` in src/lib/auth/dal.ts,
     * which render app/unauthorized.tsx (401) and app/forbidden.tsx (403).
     *
     * Both functions are exported from `next/navigation` in 16.2.12 but refuse
     * to run without this flag. The alternative is `redirect("/login")`, which
     * is worse for the case that actually matters here: Server Actions are
     * reachable by direct POST, and answering an unauthenticated POST with a
     * 200 and a login page in the body is a lie about what happened. A 401 is
     * the truth, and it is what a client can act on.
     *
     * The cost is a dependency on an experimental API. If it changes, the blast
     * radius is the two calls in dal.ts.
     */
    authInterrupts: true,
  },
};

export default nextConfig;
