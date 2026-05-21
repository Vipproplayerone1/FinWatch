import type { Metadata } from "next";
import "./globals.css";
import { NavBar } from "@/components/NavBar";

export const metadata: Metadata = {
  title: "FinWatch — Live",
  description: "Real-time transaction monitoring pipeline (PG → Debezium → Kafka → ClickHouse).",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-bg text-gray-100 antialiased">
        <NavBar />
        {children}
      </body>
    </html>
  );
}
