import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SuiScope — Move Package Explorer",
  description: "Inspect Sui Move packages, dependencies, ABIs and readable bytecode.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
