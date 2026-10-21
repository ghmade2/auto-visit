FROM ghcr.io/puppeteer/puppeteer:24

WORKDIR /app

ENV NODE_ENV=production
ENV PUPPETEER_CACHE_DIR=/home/pptruser/.cache/puppeteer

COPY package*.json ./

RUN PUPPETEER_SKIP_DOWNLOAD=true npm install --omit=dev

COPY index.js ./

USER pptruser

CMD ["node", "index.js"]
