import type { Metadata } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

export const metadata: Metadata = {
  title: "GhostPatch — Your 4K, actually 4K on TikTok",
  description:
    "TikTok crushes every upload to ~720p. GhostPatch rewrites your MP4's container — never your pixels — so TikTok's compressor stands down. Upload the patched file and keep true 4K 60fps.",
  keywords: [
    "TikTok",
    "4K upload",
    "no compression",
    "MP4 patch",
    "60fps",
    "GhostPatch",
  ],
  openGraph: {
    title: "GhostPatch — Your 4K, actually 4K on TikTok",
    description:
      "Rewrite your MP4's container — never your pixels — so TikTok's compressor stands down. No re-encoding, frames untouched.",
    siteName: "GhostPatch",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "GhostPatch — Your 4K, actually 4K on TikTok",
    description:
      "Rewrite your MP4's container — never your pixels — so TikTok's compressor stands down.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="font-sans antialiased bg-background text-foreground">
        {children}
        <Toaster theme="dark" position="bottom-right" richColors closeButton />
      </body>
    </html>
  );
}
