import type { Metadata } from "next";
import ActivityHeartbeat from "./activity-heartbeat";
import "./globals.css";

export const metadata: Metadata = {
  title: "SharableAgentCrew · Multi-Agent Teams",
  description: "Configure, publish, and run traceable multi-agent teams.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body><ActivityHeartbeat />{children}</body>
    </html>
  );
}
