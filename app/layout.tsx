import type { Metadata } from "next";
import { Roboto_Mono } from "next/font/google";
import "./globals.css";

const robotoMono = Roboto_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-roboto-mono",
});

export const metadata: Metadata = {
  title: "GMAIL CONTACT EXTRACTOR",
  description: "BRUTALIST AUTOMATED CONTACT EXTRACTION SYSTEM",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${robotoMono.variable} font-mono uppercase bg-white text-black min-h-screen antialiased selection:bg-black selection:text-white`}
      >
        {children}
      </body>
    </html>
  );
}
