// The address this Table is reached at: TABLE_URL when it's set, which a
// deploy should do, or else the request's Host header. Vercel sets the
// headers itself; anywhere else they're whatever the client sent, and the
// pages that print this address aren't cached.
export function originOf(req: Request): string {
  const fixed = process.env.TABLE_URL;
  if (fixed) return fixed.replace(/\/+$/, "");
  const host = req.headers.get("host") ?? new URL(req.url).host;
  const proto =
    req.headers.get("x-forwarded-proto") ??
    (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https");
  return `${proto}://${host}`;
}
