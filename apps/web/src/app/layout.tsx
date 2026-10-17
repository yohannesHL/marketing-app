import "./globals.css";
import "@xyflow/react/dist/style.css";
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { LaunchpadProvider } from "@launchpad/ui";

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
        <LaunchpadProvider>{children}</LaunchpadProvider>
      </body>
    </html>
  );
}
