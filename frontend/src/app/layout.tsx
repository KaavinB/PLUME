import type { Metadata } from "next";
import { Geist, IBM_Plex_Mono } from "next/font/google";

import { Shell } from "@/components/shell";
import { Providers } from "@/lib/session";
import "./globals.css";
import "maplibre-gl/dist/maplibre-gl.css";

const geist = Geist({ variable: "--font-geist", subsets: ["latin"] });
const plexMono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500"] });

export const metadata: Metadata = {
  title: "PLUME — methane repair coordination",
  description:
    "PLUME turns documented methane plume observations into investigated, funded and independently verified repair projects with on-chain accountability.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geist.variable} ${plexMono.variable}`}>
      <body>
        <Providers>
          <Shell>{children}</Shell>
        </Providers>
      </body>
    </html>
  );
}
