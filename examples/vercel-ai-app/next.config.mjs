/** @type {import('next').NextConfig} */
const nextConfig = {
    // Next.js 14 requires this flag to pick up instrumentation.ts.
    // Next.js 15+ picks it up natively without the flag.
    experimental: {
        instrumentationHook: true,
    },
};

export default nextConfig;
