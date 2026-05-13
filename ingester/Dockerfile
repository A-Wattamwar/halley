# Halley ingester — multi-stage Dockerfile.
#
# Stage 1 (builder): compile the release binary on rust:1.83-slim.
#   Toolchain matches rust-toolchain.toml (channel = "1.83").
#   We copy Cargo.toml + Cargo.lock first so dependency layers are cached
#   independently of source changes.
#
# Stage 2 (runtime): copy only the binary into debian:bookworm-slim.
#   No Rust toolchain, no build cache, no source — minimal attack surface.
#   curl is installed for the Docker healthcheck (see DECISIONS.md D15).
#   The binary runs as a non-root user (uid 10001).

# ---- Stage 1: build --------------------------------------------------------
FROM rust:1.83-slim AS builder

WORKDIR /build

# Cache dependency compilation separately from source compilation.
# Copy manifests first; if only src/ changes, this layer is reused.
COPY Cargo.toml Cargo.lock ./

# Create a stub main so `cargo build --release` can compile deps without
# the real source. The stub is overwritten in the next COPY step.
RUN mkdir -p src && echo 'fn main() {}' > src/main.rs \
    && cargo build --release \
    && rm -f target/release/deps/halley_ingester*

# Now copy the real source and build the final binary.
COPY src ./src
RUN cargo build --release

# ---- Stage 2: runtime ------------------------------------------------------
FROM debian:bookworm-slim AS runtime

# Install curl for the healthcheck. Clean up apt lists to keep the layer small.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# Non-root user. uid/gid 10001 is arbitrary but outside the system range.
RUN groupadd --gid 10001 halley \
    && useradd --uid 10001 --gid halley --no-create-home halley

WORKDIR /app

COPY --from=builder /build/target/release/halley-ingester /app/halley-ingester

# Ensure the binary is executable (should be, but be explicit).
RUN chmod +x /app/halley-ingester

USER halley

EXPOSE 4318

CMD ["/app/halley-ingester"]
