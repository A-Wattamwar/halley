/** @type {import('next').NextConfig} */
const nextConfig = {
    output: "standalone",
    // ioredis (used in app/api/runs/[id]/live/route.ts) does NOT need an
    // explicit outputFileTracingIncludes entry: Next.js/webpack bundles it
    // inline into .next/server/app/api/runs/[id]/live/route.js at build time,
    // so @vercel/nft never needs to copy it as a separate node_modules tree.
    // The experimental.outputFileTracingIncludes block that appeared here was
    // moved to top-level per Next.js 14.2 PR #68464, then removed entirely
    // once the Docker smoke test (curl GET /api/runs/<id>/live) confirmed the
    // standalone image serves the SSE route without it.
};

export default nextConfig;
