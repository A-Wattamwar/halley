import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Halley",
  description: "Agent observability and regression testing",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="bg-gray-950 text-gray-100 antialiased">
        {children}
      </body>
    </html>
  );
}
