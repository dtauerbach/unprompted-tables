import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The shared packages are TypeScript source.
  transpilePackages: ["@unprompted-tables/game", "@unprompted-tables/server"],
  outputFileTracingIncludes: { "/skill.md": ["./content/skill.md"] },
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
