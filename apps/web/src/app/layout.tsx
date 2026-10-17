import "./globals.css";
import type { Metadata } from "next";
import { AppShell } from "../components/workspace/AppShell";
import "./workspace.css";
import { LaunchpadProvider } from "@launchpad/ui";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Launchpad",
  description: "Plan campaigns, create channel-specific content, and manage publishing in one marketing workspace.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <LaunchpadProvider><AppShell mockMode={process.env.CONNECTION_MODE === "mock"}>{children}</AppShell></LaunchpadProvider>
      </body>
    </html>
  );
}
