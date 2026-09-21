import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Foodlane — Good food, close to you",
  description: "Discover neighborhood food sellers, see their location, share interest and read reviews.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
