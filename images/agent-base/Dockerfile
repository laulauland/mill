FROM oven/bun:1-debian

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    jq \
    openssh-client \
    python3 \
    python3-pip \
  && rm -rf /var/lib/apt/lists/*

# Mill-blessed agent image placeholder. Release publishing pins concrete agent CLI
# versions; this development image keeps the install surface explicit.
RUN bun add -g spawn-agent @anthropic-ai/claude-code @openai/codex @mariozechner/pi-coding-agent

WORKDIR /workspace
CMD ["bash"]
