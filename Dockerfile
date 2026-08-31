# Pinned: our pixel diff loads sharp/pngjs/pixelmatch from NODE_PATH (the global install
# below), independent of n8n's own deps. Versions pinned to the exact set proven in
# production (was on 2.4.8) so a rebuild can't shift diff behaviour. If you bump the n8n
# tag, re-verify these load on the new base (Node/libc) and stay ABI/API-compatible.
# 2026-07-16: upgraded 2.4.8 -> 2.30.6 (Alpine-hardened, Node 22 -> 24; migrations
# dry-run + build verified). n8n 2.30.x no longer bundles its own sharp, so the old
# "@img copy into n8n's bundled sharp" step was removed — the global sharp carries its
# own @img bindings and the pixel diff requires that global copy via NODE_PATH.
FROM n8nio/n8n:2.30.6

USER root

# Allow custom UIDs to traverse the /home/node directory
RUN chmod o+rx /home/node

# Image-processing libs for Pixel Diff Check / AI Vision Check / Prepare Failure HTML.
# Alpine base => musl prebuilt binaries. sharp 0.33.5 ships N-API @img bindings (loads on
# Node 24). pixelmatch 7.x is ESM (require returns {default}); the code handles that.
RUN npm install -g --prefix /usr/local pngjs@7.0.0 pixelmatch@7.1.0 sharp@0.33.5 --platform=linux --libc=musl --cpu=x64

# Set NODE_PATH so n8n task runners can find the installed packages
ENV NODE_PATH=/usr/local/lib/node_modules

# Switch back to the node user
USER node

WORKDIR /home/node
