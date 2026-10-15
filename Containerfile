# Jacarium build container
# Base image with Node.js 24.18.0 (exact pin, matches .nvmrc) on Debian 13 (has Python 3.13)
# Pinned to an exact version so container builds don't silently drift to newer
# patches; bump deliberately, keeping it in sync with .nvmrc.
# This container is designed for Linux builds (AppImage, deb, rpm)
FROM node:24.18.0-trixie

# Install system dependencies for Electron building and Python
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    build-essential \
    libssl-dev \
    libffi-dev \
    python3-dev \
    # Electron build dependencies for Linux
    rpm \
    fakeroot \
    dpkg \
    # AppImage dependencies
    libfuse2 \
    # Chrome for Selenium (headless browser automation)
    chromium \
    chromium-driver \
    # Additional tools
    git \
    curl \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Verify Python version (should be 3.13.x)
RUN python3 --version

# Set working directory
WORKDIR /build

# Set environment variables
ENV ELECTRON_CACHE=/tmp/electron-cache
ENV npm_config_cache=/tmp/npm-cache

# Create cache directories
RUN mkdir -p /tmp/electron-cache /tmp/npm-cache

# Project label (deploy/prune-images.sh removes superseded images by it and
# nothing else on the machine); last so it costs no cached layer.
LABEL com.jacarium.image=builder com.jacarium.stage=builder

# Entry point will be the build command
CMD ["/bin/bash"]
