import type { Metadata } from "next";
import { Geist, Geist_Mono, Instrument_Serif, Karla } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/**
 * The salon's brand faces (public site only — the staff screens keep Geist).
 *
 * Loaded here rather than in the site layout because `next/font` must be
 * called at module scope in a layout that wraps the whole document: the
 * variables have to be on <html> for a nested layout to reference them.
 */
const displaySerif = Instrument_Serif({
  variable: "--font-display",
  weight: "400",
  style: ["normal", "italic"],
  subsets: ["latin"],
});

const bodySans = Karla({
  variable: "--font-body",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Bookable",
  description: "Appointment scheduling",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${displaySerif.variable} ${bodySans.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
