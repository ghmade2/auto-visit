const http = require('node:http');
const puppeteer = require('puppeteer');

/*
 * 所有参数都可以通过部署平台的环境变量设置；
 * 若没有设置，则使用这里的默认值。
 */
const defaults = {
    // 默认目标地址。部署后建议通过 TARGET_URLS 或管理页面替换。
    TARGET_URLS: 'https://example.com',

    // 每轮全部 URL 完成后，随机等待的分钟数。
    MIN_INTERVAL_MINUTES: '6',
    MAX_INTERVAL_MINUTES: '26',

    // 单个页面最大加载时间，单位毫秒。
    PAGE_TIMEOUT_MS: '60000',

    // 页面 DOM 加载后额外等待时间，单位毫秒。
    POST_LOAD_WAIT_MS: '3000',

    // true：无头模式；服务器/容器建议保持 true。
    HEADLESS: 'true',

    // 是否禁用 Chrome Sandbox。默认 false。
    BROWSER_NO_SANDBOX: 'false',

    // 如使用 Puppeteer 官方镜像，通常不需要指定。
    BROWSER_EXECUTABLE_PATH: '',

    // 管理页面监听端口。
    PORT: '3000',

    // 管理页面访问令牌。
    // 强烈建议在部署平台环境变量中设置一个随机值。
    ADMIN_TOKEN: ''
};

for (const [key, defaultValue] of Object.entries(defaults)) {
    if (process.env[key] === undefined || process.env[key] === '') {
        process.env[key] = defaultValue;
    }
}

let config = readConfigFromEnvironment();
let stopping = false;
let activeBrowser = null;
let wakeUpScheduler = null;

function log(message) {
    console.log(`[${new Date().toISOString()}] ${message}`);
}

function getNumber(value, defaultValue) {
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

function readConfigFromEnvironment() {
    const newConfig = {
        targetUrls: parseUrls(process.env.TARGET_URLS),
        minIntervalMinutes: getNumber(
            process.env.MIN_INTERVAL_MINUTES,
            Number(defaults.MIN_INTERVAL_MINUTES)
        ),
        maxIntervalMinutes: getNumber(
            process.env.MAX_INTERVAL_MINUTES,
            Number(defaults.MAX_INTERVAL_MINUTES)
        ),
        pageTimeoutMs: getNumber(
            process.env.PAGE_TIMEOUT_MS,
            Number(defaults.PAGE_TIMEOUT_MS)
        ),
        postLoadWaitMs: getNumber(
            process.env.POST_LOAD_WAIT_MS,
            Number(defaults.POST_LOAD_WAIT_MS)
        ),
        headless: getBoolean(
            process.env.HEADLESS,
            getBoolean(defaults.HEADLESS, true)
        ),
        noSandbox: getBoolean(
            process.env.BROWSER_NO_SANDBOX,
            getBoolean(defaults.BROWSER_NO_SANDBOX, false)
        ),
        executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined
    };

    validateConfig(newConfig);

    return newConfig;
}

function validateConfig(currentConfig) {
    if (currentConfig.targetUrls.length === 0) {
        throw new Error('至少需要配置一个 HTTP 或 HTTPS URL。');
    }

    for (const url of currentConfig.targetUrls) {
        let parsedUrl;

        try {
            parsedUrl = new URL(url);
        } catch {
            throw new Error(`URL 格式错误：${url}`);
        }

        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            throw new Error(`仅支持 HTTP 或 HTTPS URL：${url}`);
        }
    }

    if (currentConfig.minIntervalMinutes <= 0) {
        throw new Error('最小访问间隔必须大于 0。');
    }

    if (
        currentConfig.maxIntervalMinutes <
        currentConfig.minIntervalMinutes
    ) {
        throw new Error('最大访问间隔必须大于或等于最小访问间隔。');
    }

    if (currentConfig.pageTimeoutMs <= 0) {
        throw new Error('页面超时时间必须大于 0。');
    }

    if (currentConfig.postLoadWaitMs < 0) {
        throw new Error('页面额外等待时间不能小于 0。');
    }
}

function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForNextCycle(milliseconds) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            wakeUpScheduler = null;
            resolve('timer');
        }, milliseconds);

        wakeUpScheduler = () => {
            clearTimeout(timer);
            wakeUpScheduler = null;
            resolve('config-updated');
        };
    });
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

function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

async function visitUrl(browser, url) {
    const page = await browser.newPage();

    try {
        await page.setViewport({
            width: 1000,
            height: 700,
            deviceScaleFactor: 1
        });

        page.setDefaultNavigationTimeout(config.pageTimeoutMs);
        page.setDefaultTimeout(config.pageTimeoutMs);

        log(`开始访问：${url}`);

        const response = await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: config.pageTimeoutMs
        });

        try {
            await page.waitForNetworkIdle({
                idleTime: 1000,
                timeout: Math.min(config.pageTimeoutMs, 15000)
            });
        } catch {
            log(`网络未在预期时间内空闲，继续处理：${url}`);
        }

        if (config.postLoadWaitMs > 0) {
            await sleep(config.postLoadWaitMs);
        }

        const title = await page.title();
        const status = response ? response.status() : 'N/A';

        log(`访问完成：HTTP=${status}；标题=${title}；URL=${url}`);
    } catch (error) {
        log(`访问失败：${url}；原因：${error.message}`);
    } finally {
        await page.close().catch(() => {});
    }
}

async function runCycle() {
    log(`开始新一轮任务，共 ${config.targetUrls.length} 个 URL。`);

    const args = [
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-default-apps',
        '--no-first-run',
        '--mute-audio'
    ];

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

async function scheduler() {
    log('浏览器随机访问服务已启动。');
    log(`初始目标地址：${config.targetUrls.join(' | ')}`);
    log(
        `初始随机间隔：${config.minIntervalMinutes} ～ ${config.maxIntervalMinutes} 分钟。`
    );

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

        const reason = await waitForNextCycle(delayMs);

        if (reason === 'config-updated') {
            log('配置已更新，立即按新配置开始下一轮任务。');
        }
    }

    log('服务已停止。');
}

function isAuthorized(request) {
    const adminToken = process.env.ADMIN_TOKEN;

    // 未配置令牌时允许访问，但不建议将服务公开到互联网。
    if (!adminToken) {
        return true;
    }

    const url = new URL(
        request.url,
        `http://${request.headers.host || 'localhost'}`
    );

    const tokenFromQuery = url.searchParams.get('token');
    const tokenFromHeader = request.headers['x-admin-token'];

    return tokenFromQuery === adminToken || tokenFromHeader === adminToken;
}

function sendHtml(response, statusCode, html) {
    response.writeHead(statusCode, {
        'Content-Type': 'text/html; charset=utf-8'
    });

    response.end(html);
}

function renderPage(message = '', isError = false) {
    const urlsText = config.targetUrls.join('\n');

    const statusMessage = message
        ? `<div class="message ${isError ? 'error' : 'success'}">
             ${escapeHtml(message)}
           </div>`
        : '';

    return `<!doctype html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>随机网页访问配置</title>
    <style>
        body {
            max-width: 760px;
            margin: 40px auto;
            padding: 0 18px;
            color: #1f2937;
            background: #f7f7f8;
            font-family: Arial, "Microsoft YaHei", sans-serif;
        }
        .card {
            padding: 24px;
            background: #fff;
            border-radius: 10px;
            box-shadow: 0 1px 8px rgba(0, 0, 0, .08);
        }
        label {
            display: block;
            margin-top: 16px;
            margin-bottom: 6px;
            font-weight: bold;
        }
        input, textarea, select, button {
            box-sizing: border-box;
            width: 100%;
            padding: 10px;
            border: 1px solid #cbd5e1;
            border-radius: 6px;
            font-size: 14px;
        }
        textarea {
            min-height: 150px;
            resize: vertical;
        }
        .grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 16px;
        }
        button {
            margin-top: 24px;
            color: #fff;
            background: #1677ff;
            border: 0;
            cursor: pointer;
            font-weight: bold;
        }
        button:hover {
            background: #0958d9;
        }
        .message {
            padding: 12px;
            margin-bottom: 18px;
            border-radius: 6px;
        }
        .success {
            color: #166534;
            background: #dcfce7;
        }
        .error {
            color: #991b1b;
            background: #fee2e2;
        }
        .hint {
            color: #64748b;
            font-size: 13px;
            line-height: 1.5;
        }
        code {
            padding: 2px 5px;
            background: #e2e8f0;
            border-radius: 4px;
        }
    </style>
</head>
<body>
    <div class="card">
        <h1>随机网页访问配置</h1>

        <p class="hint">
            保存后立即对当前容器生效，并会中断本次等待、按新配置开始下一轮。
            容器重启或重新部署后，配置将恢复为部署环境变量或代码默认值。
        </p>

        ${statusMessage}

        <form method="post" action="/">
            <label for="targetUrls">目标 URL</label>
            <textarea id="targetUrls" name="targetUrls" required
                placeholder="每行一个 URL，或以逗号分隔">${escapeHtml(urlsText)}</textarea>

            <div class="grid">
                <div>
                    <label for="minIntervalMinutes">最小随机间隔（分钟）</label>
                    <input id="minIntervalMinutes" name="minIntervalMinutes"
                        type="number" min="1" step="1"
                        value="${config.minIntervalMinutes}" required>
                </div>

                <div>
                    <label for="maxIntervalMinutes">最大随机间隔（分钟）</label>
                    <input id="maxIntervalMinutes" name="maxIntervalMinutes"
                        type="number" min="1" step="1"
                        value="${config.maxIntervalMinutes}" required>
                </div>
            </div>

            <div class="grid">
                <div>
                    <label for="pageTimeoutMs">单页超时（毫秒）</label>
                    <input id="pageTimeoutMs" name="pageTimeoutMs"
                        type="number" min="1000" step="1000"
                        value="${config.pageTimeoutMs}" required>
                </div>

                <div>
                    <label for="postLoadWaitMs">页面额外等待（毫秒）</label>
                    <input id="postLoadWaitMs" name="postLoadWaitMs"
                        type="number" min="0" step="1000"
                        value="${config.postLoadWaitMs}" required>
                </div>
            </div>

            <label for="headless">浏览器模式</label>
            <select id="headless" name="headless">
                <option value="true" ${config.headless ? 'selected' : ''}>
                    无头模式（推荐）
                </option>
                <option value="false" ${!config.headless ? 'selected' : ''}>
                    有界面模式
                </option>
            </select>

            <button type="submit">保存并立即应用</button>
        </form>
    </div>
</body>
</html>`;
}

function parseRequestBody(request) {
    return new Promise((resolve, reject) => {
        let body = '';

        request.on('data', (chunk) => {
            body += chunk;

            if (body.length > 100 * 1024) {
                reject(new Error('请求内容过大。'));
                request.destroy();
            }
        });

        request.on('end', () => {
            resolve(new URLSearchParams(body));
        });

        request.on('error', reject);
    });
}

function applyConfigFromForm(form) {
    const newEnvironmentValues = {
        TARGET_URLS: form.get('targetUrls') || '',
        MIN_INTERVAL_MINUTES: form.get('minIntervalMinutes') || '',
        MAX_INTERVAL_MINUTES: form.get('maxIntervalMinutes') || '',
        PAGE_TIMEOUT_MS: form.get('pageTimeoutMs') || '',
        POST_LOAD_WAIT_MS: form.get('postLoadWaitMs') || '',
        HEADLESS: form.get('headless') || 'true'
    };

    // 先保留旧值，避免新配置验证失败后破坏现有配置。
    const oldValues = {};

    for (const [key, value] of Object.entries(newEnvironmentValues)) {
        oldValues[key] = process.env[key];
        process.env[key] = value;
    }

    try {
        const newConfig = readConfigFromEnvironment();

        config = newConfig;

        log(`网页管理界面已更新配置：${config.targetUrls.join(' | ')}`);

        if (wakeUpScheduler) {
            wakeUpScheduler();
        }

        return {
            success: true,
            message: '配置已保存到当前运行进程，并将立即开始按新配置执行。'
        };
    } catch (error) {
        for (const [key, oldValue] of Object.entries(oldValues)) {
            process.env[key] = oldValue;
        }

        return {
            success: false,
            message: `配置未保存：${error.message}`
        };
    }
}

async function requestHandler(request, response) {
    if (!isAuthorized(request)) {
        response.writeHead(401, {
            'Content-Type': 'text/plain; charset=utf-8'
        });

        response.end('未授权。请提供有效的 token。');
        return;
    }

    const requestUrl = new URL(
        request.url,
        `http://${request.headers.host || 'localhost'}`
    );

    if (request.method === 'GET' && requestUrl.pathname === '/') {
        sendHtml(response, 200, renderPage());
        return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/') {
        try {
            const form = await parseRequestBody(request);
            const result = applyConfigFromForm(form);

            sendHtml(
                response,
                result.success ? 200 : 400,
                renderPage(result.message, !result.success)
            );
        } catch (error) {
            sendHtml(
                response,
                400,
                renderPage(`请求处理失败：${error.message}`, true)
            );
        }

        return;
    }

    response.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8'
    });

    response.end('Not Found');
}

function startManagementServer() {
    const port = getNumber(process.env.PORT, Number(defaults.PORT));

    const server = http.createServer((request, response) => {
        requestHandler(request, response).catch((error) => {
            log(`管理页面发生异常：${error.stack || error.message}`);

            response.writeHead(500, {
                'Content-Type': 'text/plain; charset=utf-8'
            });

            response.end('服务器内部错误。');
        });
    });

    server.listen(port, '0.0.0.0', () => {
        log(`管理页面已启动，监听端口：${port}`);

        if (process.env.ADMIN_TOKEN) {
            log('管理页面已启用 ADMIN_TOKEN 保护。');
        } else {
            log('警告：未设置 ADMIN_TOKEN。请不要将管理页面公开到互联网。');
        }
    });
}

async function shutdown(signal) {
    if (stopping) {
        return;
    }

    stopping = true;
    log(`收到 ${signal}，正在关闭浏览器并退出。`);

    if (wakeUpScheduler) {
        wakeUpScheduler();
    }

    if (activeBrowser) {
        await activeBrowser.close().catch(() => {});
    }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

startManagementServer();

scheduler().catch((error) => {
    console.error(`[${new Date().toISOString()}] 启动失败：`, error);
    process.exit(1);
});
