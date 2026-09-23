FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8787 DATABASE_PATH=/data/audio.sqlite
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
RUN npm ci --omit=dev --workspace @audio-notifications/server --ignore-scripts && mkdir /data && chown node:node /data
COPY apps/server/src apps/server/src
USER node
EXPOSE 8787
CMD ["node", "apps/server/src/index.js"]
