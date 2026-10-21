# Puppeteer 官方镜像：已包含 Chrome、浏览器运行所需依赖，
# 并提供非 root 用户 pptruser。
FROM ghcr.io/puppeteer/puppeteer:24

WORKDIR /app

ENV NODE_ENV=production

# Puppeteer 官方镜像中的 Chrome 路径。
# 您原来的 index.js 已支持读取 BROWSER_EXECUTABLE_PATH，
# 因此不需要修改 JavaScript。
ENV BROWSER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

COPY package*.json ./

# 不再下载 Chrome；Chrome 已由基础镜像提供。
RUN npm install --omit=dev

COPY index.js ./

# 让 Puppeteer 镜像默认提供的非 root 用户能够读取应用文件。
RUN chown -R pptruser:pptruser /app

USER pptruser

CMD ["node", "index.js"]
