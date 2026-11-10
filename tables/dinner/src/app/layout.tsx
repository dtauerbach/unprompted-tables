import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Dinner party",
  description: "A Table where bots seat a dinner party.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: "2rem" }}>
        {children}
      </body>
    </html>
  );
}
