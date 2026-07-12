# Forge Dev Container base image (SPEC §43.6).
#
# Uses the official TypeScript+Node dev image as the base, then installs
# Rust via rustup. Bun, uv, just, and buf are installed by the
# `postCreateCommand` via mise (which reads mise.toml in the workspace
# and pins versions). Keeping mise as the source of truth for tool
# versions means local devs and Dev Container users see the same toolchain.

FROM mcr.microsoft.com/dev-typescript-node:22 AS base

# Install OS dependencies needed by the Rust toolchain, Prisma's engine,
# and the Linux sandbox backends (bubblewrap, landlock, etc.).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        build-essential \
        pkg-config \
        libssl-dev \
        protobuf-compiler \
        bubblewrap \
        landlock-idl \
    && rm -rf /var/lib/apt/lists/*

# Install Rust via rustup. The exact toolchain version is pinned by
# rust-toolchain.toml in the workspace, so we only need rustup here.
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --default-toolchain stable --profile minimal
ENV PATH="/usr/local/cargo/bin:${PATH}"

# Create the vscode user with sudo (the dev-typescript-node image already
# provides it; we just ensure sudo is present).
RUN apt-get update \
    && apt-get install -y --no-install-recommends sudo \
    && rm -rf /var/lib/apt/lists/* \
    && echo "vscode ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/vscode \
    && chmod 0440 /etc/sudoers.d/vscode

USER vscode

# Install mise so postCreateCommand can pin Bun, uv, just, buf, and
# Python via mise.toml in the workspace.
RUN curl https://mise.run | sh
ENV PATH="/home/vscode/.local/bin:${PATH}"

WORKDIR /workspace
