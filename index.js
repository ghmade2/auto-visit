const puppeteer = require('puppeteer');
const fs = require('node:fs/promises');
const path = require('node:path');

const config = {
    // 多个 URL 用英文逗号分隔。
    // 例如：https://example.com,https://www.example.org
    targetUrls: parseUrls(process.env.TARGET_URLS),

    // 每轮完成后的随机等待分钟数。
    minIntervalMinutes: getNumber(process.env.MIN_INTERVAL_MINUTES, 6),
    maxIntervalMinutes: getNumber(process.env.MAX_INTERVAL_MINUTES, 26),

    // 单个页面最大加载时长，默认 60 秒。
    pageTimeoutMs: getNumber(process.env.PAGE_TIMEOUT_MS, 60000),

    // DOM 加载完成后额外等待时间，默认 3 秒。
    postLoadWaitMs: getNumber(process.env.POST_LOAD_WAIT_MS, 3000),

    // 是否保存截图：true / false。
    saveScreenshots: getBoolean(process.env.SAVE_SCREENSHOTS, false),

    // 截图目录。
    screenshotDir: process.env.SCREENSHOT_DIR || './screenshots',

    // true 为无头模式：运行真实 Chromium，但不会显示窗口。
    // 服务器通常应保持 true。
    headless: getBoolean(process.env.HEADLESS, true),

    // 如果 Node.js 以 root 用户运行 Linux 容器/服务器，
    // Chromium 可能需要设为 true。
    // 非必要时不要启用，以保留 Chromium 沙箱保护。
    noSandbox: getBoolean(process.env.BROWSER_NO_SANDBOX, false),

    // 若服务器已预装 Chrome/Chromium，可指定其路径。
    // 例如：/usr/bin/google-chrome 或 /usr/bin/chromium
    executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined
};

let stopping = false;
let activeBrowser = null;

function log(message) {
    console.log(`[${new Date().toISOString()}] ${message}`);
}

function getNumber(value, defaultValue) {
    if (value === undefined || value === '') {
        return defaultValue;
    }

    const number = Number(value);
    return Number.isFinite(number) ? number : defaultValue;
}

function getBoolean(value, defaultValue) {
    if (value === undefined || value === '') {
        return defaultValue;
    }

    return ['true', '1', 'yes', 'on'].includes(
        String(value).toLowerCase()
    );
}

function parseUrls(value = '') {
    return value
        .split(/[\n,]+/)
        .map((url) => url.trim())
        .filter(Boolean);
}

function validateConfig() {
    if (config.targetUrls.length === 0) {
        throw new Error(
            '请通过环境变量 TARGET_URLS 配置至少一个 HTTP 或 HTTPS 地址。'
        );
    }

    for (const url of config.targetUrls) {
        let parsedUrl;

        try {
            parsedUrl = new URL(url);
        } catch {
            throw new Error(`URL 格式错误：${url}`);
        }

        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            throw new Error(`仅支持 HTTP/HTTPS 地址：${url}`);
        }
    }

    if (config.minIntervalMinutes <= 0) {
        throw new Error('MIN_INTERVAL_MINUTES 必须大于 0。');
    }

    if (config.maxIntervalMinutes < config.minIntervalMinutes) {
        throw new Error(
            'MAX_INTERVAL_MINUTES 必须大于或等于 MIN_INTERVAL_MINUTES。'
        );
    }
}

function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function randomIntervalMs(minMinutes, maxMinutes) {
    const minMs = minMinutes * 60 * 1000;
    const maxMs = maxMinutes * 60 * 1000;

    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

function formatDuration(milliseconds) {
    const totalSeconds = Math.round(milliseconds / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    return `${minutes} 分 ${seconds} 秒`;
}

function safeFileName(url) {
    const hostname = new URL(url).hostname;

    return hostname.replace(/[^a-zA-Z0-9.-]/g, '_');
}

async function visitUrl(browser, url) {
    const page = await browser.newPage();

    try {
        await page.setViewport({
            width: 1440,
            height: 900,
            deviceScaleFactor: 1
        });

        page.setDefaultNavigationTimeout(config.pageTimeoutMs);
        page.setDefaultTimeout(config.pageTimeoutMs);

        log(`开始访问：${url}`);

        const response = await page.goto(url, {
            // DOM 已加载即可继续，避免 WebSocket/长连接网站长期等待。
            waitUntil: 'domcontentloaded',
            timeout: config.pageTimeoutMs
        });

        // 尝试等待网络基本空闲；超时并不视为页面访问失败。
        try {
            await page.waitForNetworkIdle({
                idleTime: 1000,
                timeout: Math.min(config.pageTimeoutMs, 15000)
            });
        } catch {
            log(`网络未在预期时间内空闲，继续后续操作：${url}`);
        }

        if (config.postLoadWaitMs > 0) {
            await sleep(config.postLoadWaitMs);
        }

        const title = await page.title();
        const status = response ? response.status() : 'N/A';

        log(`访问完成：HTTP=${status}；标题=${title}；URL=${url}`);

        if (config.saveScreenshots) {
            await fs.mkdir(config.screenshotDir, { recursive: true });

            const fileName = [
                Date.now(),
                safeFileName(url),
                '.png'
            ].join('-').replace('-.png', '.png');

            const screenshotPath = path.join(
                config.screenshotDir,
                fileName
            );

            await page.screenshot({
                path: screenshotPath,
                fullPage: true
            });

            log(`截图已保存：${screenshotPath}`);
        }
    } catch (error) {
        // 单个 URL 失败不会阻止本轮其他 URL 的访问。
        log(`访问失败：${url}；原因：${error.message}`);
    } finally {
        await page.close().catch(() => {});
    }
}

async function runCycle() {
    log(`开始新一轮任务，共 ${config.targetUrls.length} 个 URL。`);

    const args = ['--disable-dev-shm-usage'];

    if (config.noSandbox) {
        args.push('--no-sandbox', '--disable-setuid-sandbox');
    }

    activeBrowser = await puppeteer.launch({
        headless: config.headless,
        executablePath: config.executablePath,
        args
    });

    try {
        for (const url of config.targetUrls) {
            if (stopping) {
                break;
            }

            await visitUrl(activeBrowser, url);
        }
    } finally {
        await activeBrowser.close().catch(() => {});
        activeBrowser = null;
    }

    log('本轮任务完成，浏览器已关闭。');
}

async function main() {
    validateConfig();

    log('浏览器随机访问服务已启动。');
    log(`目标地址：${config.targetUrls.join(' | ')}`);
    log(
        `随机间隔：${config.minIntervalMinutes} ～ ${config.maxIntervalMinutes} 分钟。`
    );
    log(`浏览器模式：${config.headless ? '无头 Chromium' : '有界面 Chromium'}。`);

    while (!stopping) {
        try {
            await runCycle();
        } catch (error) {
            log(`本轮任务发生异常：${error.stack || error.message}`);
        }

        if (stopping) {
            break;
        }

        const delayMs = randomIntervalMs(
            config.minIntervalMinutes,
            config.maxIntervalMinutes
        );

        log(`下一轮将在 ${formatDuration(delayMs)} 后开始。`);

        await sleep(delayMs);
    }

    log('服务已停止。');
}

async function shutdown(signal) {
    if (stopping) {
        return;
    }

    stopping = true;
    log(`收到 ${signal}，正在关闭浏览器并退出。`);

    if (activeBrowser) {
        await activeBrowser.close().catch(() => {});
    }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((error) => {
    console.error(`[${new Date().toISOString()}] 启动失败：`, error);
    process.exit(1);
});
