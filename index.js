const http = require('node:http');
const puppeteer = require('puppeteer');

/*
 * 所有配置均可由部署平台环境变量覆盖。
 * 若环境变量未设置，则使用以下默认值。
 */
const defaults = {
    // 固定访问地址。建议在部署平台通过 TARGET_URLS 设置。
    TARGET_URLS: 'https://example.com',

    // 管理页面新增的补充地址，默认空。
    ADDITIONAL_TARGET_URLS: '',

    // 每轮完成后随机等待的最小、最大分钟数。
    MIN_INTERVAL_MINUTES: '6',
    MAX_INTERVAL_MINUTES: '26',

    // 单页面加载的最大超时时间，单位：毫秒。
    PAGE_TIMEOUT_MS: '60000',

    // DOM 加载完成、网络基本空闲后，额外等待时间，单位：毫秒。
    POST_LOAD_WAIT_MS: '3000',

    // 建议在服务器中使用无头模式。
    HEADLESS: 'true',

    // Chrome Sandbox 默认开启。
    // 仅在浏览器出现 sandbox 报错时才改为 true。
    BROWSER_NO_SANDBOX: 'false',

    // 不指定时由 Puppeteer 自动查找浏览器。
    BROWSER_EXECUTABLE_PATH: '',

    // 管理页面端口。大部分平台会自动提供 PORT。
    PORT: '3000',

    // 唤醒等待时间
    WAKE_WAIT_MS: '180000',

    // 唤醒时最大轮询次数
    WAKE_MAX_POLLS: '10',

    // 建议在部署平台设置一个随机、较长的字符串。
    ADMIN_TOKEN: ''
};

/*
 * 若未提供环境变量，写入默认值。
 * 已由部署平台提供的 TARGET_URLS 不会被覆盖。
 */
for (const [key, defaultValue] of Object.entries(defaults)) {
    if (process.env[key] === undefined || process.env[key] === '') {
        process.env[key] = defaultValue;
    }
}

let config = readConfigFromEnvironment();

let stopping = false;
let activeBrowser = null;

/*
 * 在随机等待期间保存唤醒函数。
 * 管理页面修改配置后，可立即结束等待并按新配置开始下一轮。
 */
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

function uniqueUrls(urls) {
    return [...new Set(urls)];
}

function readConfigFromEnvironment() {
    /*
     * 固定 URL：
     * 来自部署平台的 TARGET_URLS，网页页面不允许修改。
     */
    const baseTargetUrls = parseUrls(process.env.TARGET_URLS);

    /*
     * 补充 URL：
     * 来自管理页面，仅保留于当前 Node.js 进程内存。
     */
    const additionalTargetUrls = parseUrls(
        process.env.ADDITIONAL_TARGET_URLS
    );

    const newConfig = {
        baseTargetUrls,
        additionalTargetUrls,

        /*
         * 实际访问地址：
         * 固定 URL 始终优先，补充 URL 在后，自动去重。
         */
        targetUrls: uniqueUrls([
            ...baseTargetUrls,
            ...additionalTargetUrls
        ]),

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

        wakeWaitMs: getNumber(
            process.env.WAKE_WAIT_MS,
            Number(defaults.WAKE_WAIT_MS)
        ),

        wakeMaxPolls: getNumber(
            process.env.WAKE_MAX_POLLS,
            Number(defaults.WAKE_MAX_POLLS)
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
        throw new Error('最小随机访问间隔必须大于 0。');
    }

    if (
        currentConfig.maxIntervalMinutes <
        currentConfig.minIntervalMinutes
    ) {
        throw new Error(
            '最大随机访问间隔必须大于或等于最小随机访问间隔。'
        );
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

/*
 * 等待下一轮任务，或者等待管理页面更新配置。
 */
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

    page.on('response', (response) => {
        const responseHeaders = response.headers();
        const blitzStatus = responseHeaders['x-blitz-gate'];

        if (blitzStatus) {
            log(
                `页面内部请求：HTTP=${response.status()}；` +
                `Blitz 状态=${blitzStatus}；` +
                `步骤=${responseHeaders['x-blitz-gate-step'] || '无'}；` +
                `URL=${response.url()}`
            );
        }
    });

    try {
        await page.setViewport({
            width: 1000,
            height: 700,
            deviceScaleFactor: 1
        });

        page.setDefaultNavigationTimeout(config.pageTimeoutMs);
        page.setDefaultTimeout(config.pageTimeoutMs);

        log(`开始访问：${url}`);

        /*
         * 首次正常打开页面。
         * 若服务处于休眠状态，预期可能收到 503。
         */
        let response = await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: config.pageTimeoutMs
        });

        let status = response ? response.status() : 0;
        let headers = response ? response.headers() : {};

        log(
            `首次页面响应：HTTP=${status || 'N/A'}；` +
            `Blitz 状态=${headers['x-blitz-gate'] || '无'}；` +
            `URL=${url}`
        );

        /*
         * Blitz Gate 返回 x-blitz-gate: waking 时，
         * 按 retry-after 指定的时间间隔发起轮询请求。
         *
         * 最大等待时长由 WAKE_WAIT_MS 控制；
         * 没有设置时建议默认 120000（2 分钟）。
         */
        const blitzGateStatus = String(
            headers['x-blitz-gate'] || ''
        ).toLowerCase();

        /*
         * asleep：服务尚未启动；
         * waking：服务正在启动；
         * ready：网关提示可稍后重新请求主页。
         */
        const needsBlitzWakeHandling =
            status === 503 &&
            ['asleep', 'waking', 'ready'].includes(blitzGateStatus);

        if (needsBlitzWakeHandling) {
            const wakeWaitMs = Number.isFinite(config.wakeWaitMs)
                ? config.wakeWaitMs
                : 120000;

            const deadline = Date.now() + wakeWaitMs;

            const maxPolls = Math.max(
                1,
                Math.floor(config.wakeMaxPolls)
            );

            let pollCount = 0;

            log(
                `检测到 Blitz Gate 状态=${blitzGateStatus}。将最多等待 ${Math.round(
                    wakeWaitMs / 1000
                )} 秒，并按服务要求轮询。`
            );

            while (
                !stopping &&
                Date.now() < deadline &&
                pollCount < maxPolls
            ) {
                /*
                 * retry-after 单位通常为秒；异常时使用 5 秒。
                 */
                const retryAfterSeconds = Number(headers['retry-after']);

                const configuredPollWaitMs =
                    Number.isFinite(retryAfterSeconds) &&
                    retryAfterSeconds > 0
                        ? retryAfterSeconds * 1000
                        : 5000;

                /*
                 * 避免单次等待超过整体唤醒等待上限。
                 */
                const remainingMs = deadline - Date.now();

                const pollWaitMs = Math.min(
                    configuredPollWaitMs,
                    Math.max(0, remainingMs)
                );

                if (pollWaitMs <= 0) {
                    break;
                }

                log(
                    `服务正在处理，${Math.round(
                        pollWaitMs / 1000
                    )} 秒后进行第 ${pollCount + 1}/${maxPolls} 次状态轮询。`
                );

                await sleep(pollWaitMs);

                if (stopping) {
                    break;
                }

                pollCount += 1;

                /*
                 * 在同一个页面上下文中执行请求：
                 * - 自动携带该页面已经获得的同源 Cookie；
                 * - 根据服务要求添加 X-Blitz-Gate-Poll: 1；
                 * - 不使用人工浏览器中复制的 Cookie。
                 */
                const pollResult = await page.evaluate(async () => {
                    try {
                        const result = await fetch(window.location.href, {
                            method: 'GET',
                            cache: 'no-store',
                            credentials: 'same-origin',
                            headers: {
                                'Cache-Control': 'no-cache',
                                'X-Blitz-Gate-Poll': '1'
                            }
                        });

                        /*
                         * 读取响应内容后释放连接。
                         */
                        await result.text();

                        return {
                            ok: result.ok,
                            status: result.status,
                            url: result.url,
                            headers: {
                                retryAfter:
                                    result.headers.get('retry-after'),
                                blitzGate:
                                    result.headers.get('x-blitz-gate'),
                                blitzGateStep:
                                    result.headers.get('x-blitz-gate-step')
                            }
                        };
                    } catch (error) {
                        return {
                            ok: false,
                            status: 0,
                            error: error.message
                        };
                    }
                });

                status = pollResult.status || 0;

                headers = {
                    'retry-after': pollResult.headers?.retryAfter || '',
                    'x-blitz-gate': pollResult.headers?.blitzGate || '',
                    'x-blitz-gate-step':
                        pollResult.headers?.blitzGateStep || ''
                };

                const currentBlitzGateStatus = String(
                    headers['x-blitz-gate'] || ''
                ).toLowerCase();

                log(
                    `第 ${pollCount}/${maxPolls} 次唤醒轮询响应：` +
                    `HTTP=${status || 'N/A'}；` +
                    `Blitz 状态=${currentBlitzGateStatus || '无'}；` +
                    `步骤=${headers['x-blitz-gate-step'] || '无'}；` +
                    `URL=${pollResult.url || url}`
                );

                /*
                 * 已获得正常的 HTTP 成功响应。
                 */
                if (status >= 200 && status < 400) {
                    log('轮询已获得成功 HTTP 响应。');
                    break;
                }

                /*
                 * ready 表示服务即将可用。
                 * 遵守 retry-after 后，以普通页面导航重新请求主页。
                 */
                if (
                    status === 503 &&
                    currentBlitzGateStatus === 'ready'
                ) {
                    const readyRetryAfterSeconds = Number(
                        headers['retry-after']
                    );

                    const readyWaitMs =
                        Number.isFinite(readyRetryAfterSeconds) &&
                        readyRetryAfterSeconds > 0
                            ? readyRetryAfterSeconds * 1000
                            : 1000;

                    log(
                        `Blitz Gate 已返回 ready，${Math.round(
                            readyWaitMs / 1000
                        )} 秒后重新加载主页。`
                    );

                    await sleep(readyWaitMs);

                    if (stopping) {
                        break;
                    }

                    response = await page.goto(url, {
                        waitUntil: 'domcontentloaded',
                        timeout: config.pageTimeoutMs
                    });

                    status = response ? response.status() : 0;
                    headers = response ? response.headers() : {};

                    const reloadBlitzGateStatus = String(
                        headers['x-blitz-gate'] || ''
                    ).toLowerCase();

                    log(
                        `服务就绪后的主页响应：HTTP=${status || 'N/A'}；` +
                        `Blitz 状态=${reloadBlitzGateStatus || '无'}；` +
                        `URL=${url}`
                    );

                    if (status >= 200 && status < 400) {
                        log('服务已成功唤醒，主页访问成功。');
                        break;
                    }

                    /*
                     * 如果重新加载后仍是 503，则不退出 while；
                     * 下一轮会根据最新响应中的 retry-after 继续轮询。
                     */
                }
            }

            if (status < 200 || status >= 400) {
                log(
                    `唤醒流程结束，但主页尚未成功响应；` +
                    `HTTP=${status || 'N/A'}；` +
                    `Blitz 状态=${headers['x-blitz-gate'] || '无'}；` +
                    `已完成 ${pollCount}/${maxPolls} 次轮询；` +
                    `等待上限为 ${Math.round(wakeWaitMs / 1000)} 秒。`
                );
            }
        }

        /*
         * 页面恢复或首次就正常打开后，额外等待一段时间，
         * 让网站自身 JavaScript 完成初始化。
         */
        if (!stopping && config.postLoadWaitMs > 0) {
            await sleep(config.postLoadWaitMs);
        }

        const title = await page.title().catch(() => '');

        log(
            `访问结束：HTTP=${status || 'N/A'}；` +
            `标题=${title || '无'}；最终 URL=${page.url()}`
        );
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

    log(`固定目标地址数量：${config.baseTargetUrls.length}`);

    log(`补充目标地址数量：${config.additionalTargetUrls.length}`);

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

        const reason = await waitForNextCycle(delayMs);

        if (reason === 'config-updated') {
            log('配置已更新，立即按新配置开始下一轮任务。');
        }
    }

    log('服务已停止。');
}

function isAuthorized(request) {
    const adminToken = process.env.ADMIN_TOKEN;

    /*
     * 未配置 Token 时，禁止访问管理页面。
     * 防止管理界面被公网直接访问。
     */
    if (!adminToken) {
        return false;
    }

    const requestUrl = new URL(
        request.url,
        `http://${request.headers.host || 'localhost'}`
    );

    const tokenFromQuery = requestUrl.searchParams.get('token');
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
    const additionalUrlsText = config.additionalTargetUrls.join('\n');

    /*
     * 若启用了 token，需要将 token 保留在 POST 地址中，
     * 否则提交表单时会失去授权信息。
     */
    const formAction = process.env.ADMIN_TOKEN
        ? `/?token=${encodeURIComponent(process.env.ADMIN_TOKEN)}`
        : '/';

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
            max-width: 780px;
            margin: 40px auto;
            padding: 0 18px;
            color: #1f2937;
            background: #f7f7f8;
            font-family: Arial, "Microsoft YaHei", sans-serif;
        }

        .card {
            padding: 24px;
            background: #ffffff;
            border-radius: 10px;
            box-shadow: 0 1px 8px rgba(0, 0, 0, 0.08);
        }

        h1 {
            margin-top: 0;
            font-size: 24px;
        }

        label {
            display: block;
            margin-top: 18px;
            margin-bottom: 7px;
            font-weight: bold;
        }

        input,
        textarea,
        select,
        button {
            box-sizing: border-box;
            width: 100%;
            padding: 10px;
            border: 1px solid #cbd5e1;
            border-radius: 6px;
            font-size: 14px;
        }

        textarea {
            min-height: 120px;
            resize: vertical;
        }

        textarea[readonly] {
            color: #475569;
            background: #f1f5f9;
            cursor: not-allowed;
        }

        .grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 16px;
        }

        button {
            margin-top: 24px;
            color: #ffffff;
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
            line-height: 1.6;
        }

        code {
            padding: 2px 5px;
            background: #e2e8f0;
            border-radius: 4px;
        }

        @media (max-width: 600px) {
            .grid {
                grid-template-columns: 1fr;
            }
        }
    </style>
</head>
<body>
    <div class="card">
        <h1>随机网页访问配置</h1>

        <p class="hint">
            系统已配置固定访问地址，并会在每轮任务中自动执行访问。
            您可以在下方增加补充访问地址；补充地址会追加到既有访问任务中。
        </p>

        <p class="hint">
            网页中保存的补充 URL 仅保留在当前容器运行内存中。
            容器重启或重新部署后，补充 URL 会清空；
            固定 URL 不受影响。
        </p>

        ${statusMessage}

        <form method="post" action="${formAction}">

            <label for="additionalTargetUrls">
                补充访问 URL
            </label>

            <textarea
                id="additionalTargetUrls"
                name="additionalTargetUrls"
                placeholder="每行一个 URL，或以英文逗号分隔。">${escapeHtml(additionalUrlsText)}</textarea>

            <div class="grid">
                <div>
                    <label for="minIntervalMinutes">
                        最小随机间隔（分钟）
                    </label>

                    <input
                        id="minIntervalMinutes"
                        name="minIntervalMinutes"
                        type="number"
                        min="1"
                        step="1"
                        value="${config.minIntervalMinutes}"
                        required>
                </div>

                <div>
                    <label for="maxIntervalMinutes">
                        最大随机间隔（分钟）
                    </label>

                    <input
                        id="maxIntervalMinutes"
                        name="maxIntervalMinutes"
                        type="number"
                        min="1"
                        step="1"
                        value="${config.maxIntervalMinutes}"
                        required>
                </div>
            </div>

            <div class="grid">
                <div>
                    <label for="pageTimeoutMs">
                        单页面超时（毫秒）
                    </label>

                    <input
                        id="pageTimeoutMs"
                        name="pageTimeoutMs"
                        type="number"
                        min="1000"
                        step="1000"
                        value="${config.pageTimeoutMs}"
                        required>
                </div>

                <div>
                    <label for="postLoadWaitMs">
                        页面额外等待（毫秒）
                    </label>

                    <input
                        id="postLoadWaitMs"
                        name="postLoadWaitMs"
                        type="number"
                        min="0"
                        step="1000"
                        value="${config.postLoadWaitMs}"
                        required>
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

            <button type="submit">保存补充 URL 并立即应用</button>
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

            /*
             * 限制管理页面提交内容，防止异常大请求占用内存。
             */
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
    /*
     * 特别注意：
     * 此处不会修改 TARGET_URLS。
     * 部署环境变量中的固定 URL 始终保持不变。
     */
    const newEnvironmentValues = {
        ADDITIONAL_TARGET_URLS:
            form.get('additionalTargetUrls') || '',

        MIN_INTERVAL_MINUTES:
            form.get('minIntervalMinutes') || '',

        MAX_INTERVAL_MINUTES:
            form.get('maxIntervalMinutes') || '',

        PAGE_TIMEOUT_MS:
            form.get('pageTimeoutMs') || '',

        POST_LOAD_WAIT_MS:
            form.get('postLoadWaitMs') || '',

        HEADLESS:
            form.get('headless') || 'true'
    };

    /*
     * 先备份旧值。
     * 如果新配置校验失败，则完整恢复旧配置。
     */
    const oldValues = {};

    for (const [key, value] of Object.entries(newEnvironmentValues)) {
        oldValues[key] = process.env[key];
        process.env[key] = value;
    }

    try {
        const newConfig = readConfigFromEnvironment();

        config = newConfig;

        log(
            `网页配置已更新；固定 URL：${
                config.baseTargetUrls.join(' | ') || '无'
            }；补充 URL：${
                config.additionalTargetUrls.join(' | ') || '无'
            }`
        );

        /*
         * 若此时服务正处于随机等待，立即唤醒调度器，
         * 使用新 URL 开始下一轮。
         */
        if (wakeUpScheduler) {
            wakeUpScheduler();
        }

        return {
            success: true,
            message:
                '补充 URL 已保存到当前运行进程。固定 URL 未变化，下一轮将立即按新配置执行。'
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
    const port = getNumber(
        process.env.PORT,
        Number(defaults.PORT)
    );

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
            log(
                '警告：未设置 ADMIN_TOKEN，管理页面已被禁止访问。'
            );
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
    console.error(`[${new Date().toISOString()}] 服务启动失败：`, error);
    process.exit(1);
});
