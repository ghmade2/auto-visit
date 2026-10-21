FROM ghcr.io/puppeteer/puppeteer:24

WORKDIR /app

ENV NODE_ENV=production

# 使用 Puppeteer 官方镜像中 pptruser 已安装的浏览器缓存目录。
ENV PUPPETEER_CACHE_DIR=/home/pptruser/.cache/puppeteer

COPY package*.json ./

# 官方基础镜像已具备浏览器及系统依赖。
# 不在此处重复下载 Chrome。
RUN PUPPETEER_SKIP_DOWNLOAD=true npm install --omit=dev

COPY index.js ./

RUN chown -R pptruser:pptruser /app

USER pptruser

CMD ["node", "index.js"]
