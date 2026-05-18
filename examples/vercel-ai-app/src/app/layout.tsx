import type { Metadata } from "next";

export const metadata: Metadata = {
    title: "Halley — Vercel AI SDK Example",
    description: "Minimal Next.js app demonstrating Vercel AI SDK telemetry with Halley",
};

export default function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <html lang="en">
            <body style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: "600px", margin: "0 auto" }}>
                {children}
            </body>
        </html>
    );
}
