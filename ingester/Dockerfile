# Halley ingester — multi-stage Dockerfile.
#
# Stage 1 (builder): compile the release binary on rust:1.85-slim.
#   Toolchain matches rust-toolchain.toml (channel = "1.85").
#   Bumped from 1.83 to 1.85 in Phase 2 Day 1 (DECISIONS.md D28: tonic 0.14
#   requires edition = "2024" which needs Rust 1.85+).
#   We copy Cargo.toml + Cargo.lock first so dependency layers are cached
#   independently of source changes.
#
# Stage 2 (runtime): copy only the binary into debian:bookworm-slim.
#   No Rust toolchain, no build cache, no source — minimal attack surface.
#   curl is installed for the Docker healthcheck (see DECISIONS.md D15).
#   The binary runs as a non-root user (uid 10001).

# ---- Stage 1: build --------------------------------------------------------
FROM rust:1.85-slim AS builder

WORKDIR /build

# NOTE: the build context is the REPO ROOT (docker-compose.yml sets
# context: . + dockerfile: ingester/Dockerfile). This is required because the
# ingester has a path dependency on the sibling `halley-canonical` crate
# (../halley-canonical, see ingester/Cargo.toml + D22/D54). All COPY paths below
# are therefore relative to the repo root, and the ingester crate is built from
# the /build/ingester subdir so that ../halley-canonical resolves as it does on
# the host. The root .dockerignore scopes the context to just these two crates.

# Copy the sibling crate the ingester depends on. Its layout under /build must
# mirror the host (sibling of ingester/) so the `../halley-canonical` path
# dependency resolves unchanged.
#
# We copy only Cargo.toml (not Cargo.lock): halley-canonical is a library crate
# whose lockfile is gitignored (D4) and absent from a clean clone. The build is
# driven entirely by the committed ingester/Cargo.lock, which already resolves
# halley-canonical, so copying the canonical lockfile is both impossible from a
# fresh clone and unnecessary. See DECISIONS.md D56.
COPY halley-canonical/Cargo.toml ./halley-canonical/
COPY halley-canonical/src ./halley-canonical/src

# Cache dependency compilation separately from source compilation.
# Copy the ingester manifests first; if only src/ changes, this layer is reused.
COPY ingester/Cargo.toml ingester/Cargo.lock ./ingester/

# Create a stub main so `cargo build --release` can compile deps without
# the real source. The stub is overwritten in the next COPY step.
WORKDIR /build/ingester
RUN mkdir -p src/bin \
    && echo 'fn main() {}' > src/main.rs \
    && echo 'fn main() {}' > src/bin/smoke_grpc.rs \
    && cargo build --release \
    && rm -f target/release/deps/halley_ingester* target/release/deps/smoke_grpc*

# Now copy the real source and build the final binary.
COPY ingester/src ./src
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

COPY --from=builder /build/ingester/target/release/halley-ingester /app/halley-ingester

# Ensure the binary is executable (should be, but be explicit).
RUN chmod +x /app/halley-ingester

USER halley

EXPOSE 4318
EXPOSE 4317

CMD ["/app/halley-ingester"]
