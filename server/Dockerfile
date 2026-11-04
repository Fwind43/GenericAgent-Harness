# Multi-arch image from the server tarballs built by the `server` CI job:
#   dist/amd64/  and  dist/arm64/  each hold one extracted ga-harness-server package.
FROM debian:bookworm-slim
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git tini \
 && rm -rf /var/lib/apt/lists/*
COPY dist/${TARGETARCH}/ /opt/ga-harness/
ENV GAH_HOME=/data \
    GAH_WEB_HOST=0.0.0.0 \
    GAH_WEB_PORT=8765 \
    GAH_WEB_OPEN_BROWSER=0
VOLUME /data
EXPOSE 8765
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/ga-harness/gah-server"]
