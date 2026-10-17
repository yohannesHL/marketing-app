import "./globals.css";
import "@xyflow/react/dist/style.css";
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { LaunchpadProvider } from "@launchpad/ui";
import { AppShell } from "../components/navigation/AppShell";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Launchpad",
  description: "Marketing app to consolidate ad and campaign creation and management.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <LaunchpadProvider><AppShell>{children}</AppShell></LaunchpadProvider>
      </body>
    </html>
  );
}
