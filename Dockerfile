FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer

COPY package*.json ./

RUN npm install --omit=dev \
    && npx puppeteer browsers install chrome --install-deps

COPY index.js ./

RUN chown -R node:node /app

USER node

CMD ["node", "index.js"]
