import type { Metadata } from "next";
import { CopilotKit } from "@copilotkit/react-core";
import { Geist, Geist_Mono } from "next/font/google";
import "@copilotkit/react-ui/styles.css";
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
  title: "Kento · Rescue Hive",
  description:
    "Autonomous multi-agent disaster response: Snowflake + dbt data, Redis hot memory, a LlamaIndex commander and tactical field agents.",
};

// The CopilotKit runtime needs a working LLM key, so the provider (and its
// /api/copilotkit calls) only mounts when the Copilot is explicitly enabled.
const COPILOT_ENABLED = process.env.NEXT_PUBLIC_COPILOT_ENABLED === "true";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        {COPILOT_ENABLED ? <CopilotKit runtimeUrl="/api/copilotkit" enableInspector={false} showDevConsole={false}>{children}</CopilotKit> : children}
      </body>
    </html>
  );
}
