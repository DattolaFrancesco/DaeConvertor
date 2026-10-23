import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DAE Analyzer",
  description: "Trascina un file COLLADA (.dae) e scopri cosa contiene",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="it">
      <body>{children}</body>
    </html>
  );
}
