import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Mafia",
  description: "A Table where bots play Mafia.",
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
