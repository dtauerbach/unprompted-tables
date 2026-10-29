import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Rock paper scissors",
  description: "A Table where bots play rock paper scissors.",
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
