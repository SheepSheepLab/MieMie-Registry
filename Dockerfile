# SPDX-License-Identifier: GPL-3.0-or-later
FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATABASE_PATH=/data/registry.sqlite BACKUP_DIRECTORY=/backups
WORKDIR /app
# Explicit copies exclude private environment, databases and local artifacts.
# This project has no npm runtime dependencies.
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node tools ./tools
COPY --chown=node:node LICENSE THIRD_PARTY_NOTICES.md ./
RUN mkdir /data /backups && chown node:node /data /backups && chmod 700 /data /backups
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "tools/healthcheck.mjs"]
CMD ["node", "src/server.js"]
