#!/bin/bash
set -e

# Navigate to the directory where the script (and Dockerfile) resides
cd "$(dirname "$0")"

REGISTRY="lowkeyfaint"
IMAGE_NAME="tendril"
TAG="latest"

echo "Building and pushing multi-arch Docker image ${REGISTRY}/${IMAGE_NAME}:${TAG}..."
docker buildx build --platform linux/amd64,linux/arm64 -t ${REGISTRY}/${IMAGE_NAME}:${TAG} --push .

echo "Done!"
