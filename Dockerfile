FROM ghcr.io/puppeteer/puppeteer:24

WORKDIR /app

ENV NODE_ENV=production

# 使用 Puppeteer 官方镜像内置浏览器所在的缓存目录。
ENV PUPPETEER_CACHE_DIR=/home/pptruser/.cache/puppeteer

COPY package*.json ./

# 官方 Puppeteer 镜像已带有 Chrome 和运行依赖。
# 不要重新下载浏览器。
RUN PUPPETEER_SKIP_DOWNLOAD=true npm install --omit=dev

COPY index.js ./

# 不执行 chown：当前构建平台不允许修改 COPY 文件的所有者。
# index.js 和 node_modules 对 pptruser 可读即可运行。
USER pptruser

CMD ["node", "index.js"]
