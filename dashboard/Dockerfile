# Halley Dashboard — multi-stage Dockerfile.
#
# Stage 1 (deps): install production dependencies only.
# Stage 2 (builder): build the Next.js standalone output.
# Stage 3 (runner): minimal runtime with only the standalone server.
#
# Uses node:20-alpine for both build and runtime.
# next.config.mjs has output: "standalone" which produces a self-contained
# server.js that does not need node_modules at runtime.

# ---- Stage 1: deps ---------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- Stage 2: builder ------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- Stage 3: runner --------------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Non-root user (nextjs, uid 1001) per the plan.
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

# Copy standalone output. This includes server.js and the minimal
# node_modules needed at runtime.
COPY --from=builder /app/.next/standalone ./

# Standalone output does NOT include static assets. Copy them manually.
COPY --from=builder /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

CMD ["node", "server.js"]
