import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The proxy (src/proxy.ts) must see the path as asked: normalised,
  // /_next/data/<id>/seating.json reads as /seating and would get past it
  // on the rooms' host to the Table's own 404 page.
  skipProxyUrlNormalize: true,
  // The shared packages are TypeScript source.
  transpilePackages: [
    "@unprompted-tables/game",
    "@unprompted-tables/server",
    "@unprompted-tables/spectator",
  ],
  outputFileTracingIncludes: {
    "/skill.md": ["./content/skill.md"],
    "/seating/[[...path]]": ["./content/lab/**"],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Content-Security-Policy",
            value:
              "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
