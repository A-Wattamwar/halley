# Halley Worker — Docker image.
# Node.js 20 LTS (Alpine). Uses tsx for direct TypeScript execution (no compile step).

FROM node:20-alpine

WORKDIR /app

# Install dependencies first (layer-cached unless package.json changes).
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev=false

# Copy source (src/ and scripts/ are referenced by tsx at runtime).
COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/

CMD ["npm", "run", "start"]
