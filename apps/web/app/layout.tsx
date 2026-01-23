import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ItGix Platform",
  description: "Enterprise Application Development Platform",
  icons: {
    icon: [
      { url: "/itgix-favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/itgix-favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/itgix-favicon-48x48.png", sizes: "48x48", type: "image/png" },
    ],
    apple: [
      { url: "/itgix-favicon-112x112.png", sizes: "112x112", type: "image/png" },
    ],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
