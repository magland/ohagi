# The ohagi server image: the compiled server, on the base image that holds
# Node and a full TeX Live (Dockerfile.base, published by base.yml). BASE may
# name another, such as one built locally from Dockerfile.base.
#
# ohagi compiles mochiforge's and arewehuman's sources in with its own, so the
# build context is the directory holding the checkouts side by side, not this one:
#
#   docker build -f ohagi/Dockerfile -t ohagi .     (from the parent directory)
#   docker build -f Dockerfile -t ohagi ..          (from inside ohagi)
#
# Dockerfile.dockerignore, beside this file, lets only the sources and the
# manifests through, whatever else the parent directory holds. `ohagi deploy
# fly --from-source` assembles the same trees in a temporary directory and
# builds this file from there.
ARG BASE=ghcr.io/magland/ohagi-tex:trixie

FROM node:24-trixie-slim AS build
WORKDIR /build/ohagi
COPY ohagi/package.json ohagi/package-lock.json ./
RUN npm ci
# The shared modules sit in /build/mochiforge/src and find their packages by
# walking up from there, which reaches /build/node_modules and nothing else.
RUN ln -s /build/ohagi/node_modules /build/node_modules
COPY mochiforge/src /build/mochiforge/src
COPY arewehuman/src /build/arewehuman/src
COPY ohagi/tsconfig.json ./
COPY ohagi/src ./src
COPY ohagi/client ./client
COPY ohagi/scripts/build-client.mjs ./scripts/build-client.mjs
RUN npm run build && npm prune --omit=dev

# The runtime: the base, with TeX Live, latexmk, git, and bubblewrap (it is
# used when the machine allows unprivileged user namespaces, and the server
# says at startup when it does not).
FROM ${BASE}
WORKDIR /app
COPY --from=build /build/ohagi/node_modules ./node_modules
COPY --from=build /build/ohagi/dist ./dist
COPY ohagi/package.json ./
RUN mkdir /shelf && chown node:node /shelf
USER node
VOLUME /shelf
EXPOSE 3000
CMD ["node", "dist/ohagi/src/index.js", "serve", "/shelf", "--host", "0.0.0.0", "--port", "3000"]
