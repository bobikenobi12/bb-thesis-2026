# Stage 1: Build the Go Agent
FROM --platform=$BUILDPLATFORM golang:1.23-alpine AS builder

ARG TARGETOS
ARG TARGETARCH

WORKDIR /app

# Copy Go module files first to leverage caching
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build the binary
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -o tendril ./cmd/tendril

# Stage 2: Create the Runtime Image
FROM alpine:3.19

ARG TARGETARCH

# Install dependencies
RUN apk add --no-cache \
    git \
    openssh \
    ca-certificates \
    curl \
    unzip

# Install Terraform
ENV TERRAFORM_VERSION=1.7.4
RUN curl -LO https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_${TARGETARCH}.zip && \
    unzip terraform_${TERRAFORM_VERSION}_linux_${TARGETARCH}.zip && \
    mv terraform /usr/local/bin/ && \
    rm terraform_${TERRAFORM_VERSION}_linux_${TARGETARCH}.zip

# Create a non-root user
RUN addgroup -S tendril && adduser -S tendril -G tendril

WORKDIR /home/tendril

# Copy the binary from builder
COPY --from=builder /app/tendril /usr/local/bin/tendril

# Set permissions
RUN chown -R tendril:tendril /home/tendril

# Switch to non-root user
USER tendril

# Environment variables should be injected at runtime
CMD ["tendril"]
