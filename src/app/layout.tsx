import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/components/MobileNav";

export const metadata: Metadata = {
  title: "Mission Control | Alan OS",
  description: "Multi-agent life operating system dashboard",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
