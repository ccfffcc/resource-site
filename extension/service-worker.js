const DEFAULT_CONFIG = {
  feishuBaseUrl: "https://open.feishu.cn",
  appId: "",
  appSecret: "",
  appToken: "",
  tableId: "",
  translation: {
    enabled: true,
    endpoint: "https://api.openai.com/v1/chat/completions",
    apiKey: "",
    model: "gpt-4o-mini",
    maxContentChars: 12000,
    categories: "动效, 图标, 插画, 字体, 配色, 设计工具, 设计灵感, UI/UX, 前端开发, 后端开发, 开发工具, AI工具, 提示词, 写作, 办公效率, 产品运营, 营销增长, 数据分析, 学习资料, 文章, 资源导航, 其他"
  },
  deploy: {
    enabled: false,
    owner: "",
    repo: "resource-site",
    workflow: "deploy-resources-site.yml",
    ref: "master",
    token: "",
    cooldownSeconds: 120
  },
  fields: {
    title: "标题",
    url: "URL",
    domain: "域名",
    summary: "摘要",
    tags: "标签",
    category: "分类",
    coverImage: "封面图",
    createdAt: "收藏时间"
  }
};

const TOKEN_CACHE_KEY = "tenantAccessTokenCache";
const RECENT_SYNC_KEY = "recentSyncResults";
const LAST_DEPLOY_TRIGGER_KEY = "lastDeployTriggerAt";
const MAX_RECENT_RESULTS = 20;

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.sync.get("config");
  if (!existing.config) {
    await chrome.storage.sync.set({ config: DEFAULT_CONFIG });
  }
});

chrome.bookmarks.onCreated.addListener((bookmarkId, bookmark) => {
  if (!bookmark.url) return;

  syncBookmark(bookmarkId, bookmark).catch((error) => {
    recordResult({
      ok: false,
      title: bookmark.title,
      url: bookmark.url,
      message: normalizeError(error),
      syncedAt: new Date().toISOString()
    });
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "test-sync-current-tab") {
    testSyncCurrentTab()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: normalizeError(error) }));
    return true;
  }

  if (message?.type === "get-recent-results") {
    chrome.storage.local
      .get(RECENT_SYNC_KEY)
      .then((data) => sendResponse({ ok: true, results: data[RECENT_SYNC_KEY] || [] }))
      .catch((error) => sendResponse({ ok: false, error: normalizeError(error) }));
    return true;
  }

  if (message?.type === "clear-recent-results") {
    chrome.storage.local
      .set({ [RECENT_SYNC_KEY]: [] })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: normalizeError(error) }));
    return true;
  }

  return false;
});

async function syncBookmark(bookmarkId, bookmark) {
  const config = await getConfig();
  validateConfig(config);

  const pageInfo = await enrichBookmarkInfo(bookmark);
  await attachCoverScreenshot(config, pageInfo);
  const aiInfo = await generateAiContentInfo(config, pageInfo);
  const info = {
    ...aiInfo,
    url: pageInfo.url,
    domain: pageInfo.domain,
    coverImage: pageInfo.coverImage,
    coverImageAttachment: pageInfo.coverImageAttachment,
    bookmarkId,
    createdAt: bookmark.dateAdded || Date.now()
  };
  const record = buildBitableRecord(config, info);

  const createResult = await upsertBitableRecordWithFallback(config, record, info.url, () =>
    buildSafeBitableRecord(config, info),
    () => buildMinimalBitableRecord(config, info)
  );

  const result = {
    ok: true,
    title: info.title,
    url: info.url,
    message: buildSyncSuccessMessage(createResult),
    syncedAt: new Date().toISOString()
  };

  const deployMessage = await triggerSiteDeployIfEnabled(config, result);
  if (deployMessage) {
    result.message = `${result.message}；${deployMessage}`;
  }

  await recordResult(result);
  return result;
}

async function testSyncCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || tab.url.startsWith("chrome://")) {
    throw new Error("当前标签页没有可同步的网址");
  }

  return syncBookmark("manual-test", {
    title: tab.title || tab.url,
    url: tab.url,
    dateAdded: Date.now()
  });
}

async function getConfig() {
  const data = await chrome.storage.sync.get("config");
  return mergeConfig(DEFAULT_CONFIG, data.config || {});
}

function mergeConfig(defaultConfig, savedConfig) {
  return migrateConfig({
    ...defaultConfig,
    ...savedConfig,
    translation: {
      ...defaultConfig.translation,
      ...(savedConfig.translation || {})
    },
    deploy: {
      ...defaultConfig.deploy,
      ...(savedConfig.deploy || {})
    },
    fields: {
      ...defaultConfig.fields,
      ...(savedConfig.fields || {})
    }
  });
}

async function generateAiContentInfo(config, pageInfo) {
  if (!shouldTranslate(config, pageInfo)) {
    return {
      ...pageInfo,
      ...generateContentInfo(pageInfo)
    };
  }

  try {
    const localized = await summarizePageInChinese(config.translation, pageInfo);
    const fallbackInfo = generateContentInfo({
      ...pageInfo,
      title: localized.title || pageInfo.title,
      summary: localized.summary || buildSummary(pageInfo)
    });
    const tags = normalizeTags(localized.tags);
    return {
      ...pageInfo,
      title: localized.title || pageInfo.title,
      summary: localized.summary || buildSummary(pageInfo),
      tags: tags.length ? tags : fallbackInfo.tags,
      category: normalizeCategory(localized.category, config.translation.categories) || fallbackInfo.category
    };
  } catch (error) {
    await recordResult({
      ok: false,
      title: pageInfo.title,
      url: pageInfo.url,
      message: `中文化失败，已使用原文继续同步：${normalizeError(error)}`,
      syncedAt: new Date().toISOString()
    });
    return {
      ...pageInfo,
      ...generateContentInfo(pageInfo)
    };
  }
}

function shouldTranslate(config, pageInfo) {
  return Boolean(
    config.translation?.enabled &&
      config.translation?.endpoint?.trim() &&
      config.translation?.apiKey?.trim() &&
      config.translation?.model?.trim() &&
      (pageInfo.title || pageInfo.description || pageInfo.contentText)
  );
}

function migrateConfig(config) {
  const migrated = {
    ...config,
    fields: {
      ...config.fields
    }
  };

  if (migrated.fields.url === "链接") {
    migrated.fields.url = "URL";
  }

  return migrated;
}

function validateConfig(config) {
  const required = ["feishuBaseUrl", "appId", "appSecret", "appToken"];
  const missing = required.filter((key) => !config[key]?.trim());
  if (missing.length) {
    throw new Error(`缺少配置：${missing.join(", ")}`);
  }

  if (!resolveTableId(config)) {
    throw new Error("缺少配置：tableId");
  }
}

async function enrichBookmarkInfo(bookmark) {
  const baseInfo = {
    title: bookmark.title || bookmark.url,
    url: bookmark.url,
    description: "",
    domain: getDomain(bookmark.url),
    coverImage: "",
    contentText: ""
  };

  const matchingTab = await findMatchingTab(bookmark.url);
  if (!matchingTab?.id) return baseInfo;

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: matchingTab.id },
      func: () => {
        const getMeta = (...selectors) => {
          for (const selector of selectors) {
            const value = document.querySelector(selector)?.content?.trim();
            if (value) return value;
          }
          return "";
        };

        const metaDescription =
          getMeta('meta[property="og:description"]', 'meta[name="description"]') || "";
        const ogTitle = getMeta('meta[property="og:title"]', 'meta[name="twitter:title"]');
        const ogImage = getMeta(
          'meta[property="og:image"]',
          'meta[name="twitter:image"]',
          'meta[property="twitter:image"]'
        );
        const contentRoot =
          document.querySelector("article") ||
          document.querySelector("main") ||
          document.body;
        const contentText = extractReadableText(contentRoot);

        return {
          title: ogTitle || document.title,
          description: metaDescription,
          coverImage: ogImage ? new URL(ogImage, location.href).href : "",
          contentText
        };

        function extractReadableText(root) {
          if (!root) return "";
          const clone = root.cloneNode(true);
          clone
            .querySelectorAll(
              "script,style,noscript,svg,canvas,iframe,nav,footer,header,aside,form,button,input,select,textarea"
            )
            .forEach((node) => node.remove());
          return clone.innerText
            .replace(/\s+/g, " ")
            .replace(/([\u3002\uff01\uff1f.!?])\s+/g, "$1\n")
            .trim()
            .slice(0, 20000);
        }
      }
    });

    return {
      ...baseInfo,
      title: result?.result?.title || baseInfo.title,
      description: result?.result?.description || "",
      coverImage: result?.result?.coverImage || "",
      contentText: result?.result?.contentText || ""
    };
  } catch (_error) {
    return baseInfo;
  }
}

async function findMatchingTab(url) {
  const tabs = await chrome.tabs.query({});
  return tabs.find((tab) => tab.url === url);
}

function buildBitableRecord(config, info) {
  const fields = {};
  addField(fields, config.fields.title, info.title);
  addField(fields, config.fields.url, toLinkValue(info.url, info.url));
  addField(fields, config.fields.domain, info.domain);
  addField(fields, config.fields.summary, info.summary);
  addField(fields, config.fields.tags, info.tags);
  addField(fields, config.fields.category, info.category);
  addField(fields, config.fields.coverImage, info.coverImageAttachment);
  addField(fields, config.fields.createdAt, info.createdAt);
  return { fields };
}

function buildSafeBitableRecord(config, info) {
  const fields = {};
  addField(fields, config.fields.title, info.title);
  addField(fields, config.fields.url, toLinkValue(info.url, info.url));
  addField(fields, config.fields.domain, info.domain);
  addField(fields, config.fields.summary, info.summary);
  addField(fields, config.fields.createdAt, info.createdAt);
  return { fields };
}

function buildMinimalBitableRecord(config, info) {
  const fields = {};
  addField(fields, config.fields.url, toLinkValue(info.url, info.url));
  return { fields };
}

function addField(fields, fieldName, value) {
  if (!fieldName || value === undefined || value === null || value === "") return;
  if (Array.isArray(value) && value.length === 0) return;
  fields[fieldName] = value;
}

function toLinkValue(url, text) {
  if (!url) return "";
  return {
    text: text || url,
    link: url
  };
}

async function attachCoverScreenshot(config, info) {
  if (!config.fields.coverImage) return;

  try {
    const screenshot = await captureBookmarkScreenshot(info.url);
    if (!screenshot) return;

    const target = await getBitableTarget(config);
    const fileName = buildScreenshotFileName(info);
    const fileToken = await uploadBitableAttachment(config, target, screenshot.blob, fileName);
    info.coverImageAttachment = [
      {
        file_token: fileToken
      }
    ];
  } catch (error) {
    await recordResult({
      ok: false,
      title: info.title,
      url: info.url,
      message: `封面图截图/上传失败，已继续同步其他字段：${normalizeError(error)}`,
      syncedAt: new Date().toISOString()
    });
  }
}

async function captureBookmarkScreenshot(url) {
  const matchingTab = await findMatchingTab(url);
  if (!matchingTab?.windowId || !matchingTab.active) {
    return null;
  }

  const dataUrl = await chrome.tabs.captureVisibleTab(matchingTab.windowId, {
    format: "png"
  });
  const blob = await dataUrlToBlob(dataUrl);
  return {
    blob,
    dataUrl
  };
}

async function dataUrlToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  return response.blob();
}

function buildScreenshotFileName(info) {
  const domain = (info.domain || "bookmark").replace(/[^a-zA-Z0-9.-]/g, "_").slice(0, 60);
  return `${domain}-${Date.now()}.png`;
}

async function uploadBitableAttachment(config, target, blob, fileName) {
  try {
    return await uploadDriveMedia(config, target, blob, fileName, "bitable_file");
  } catch (error) {
    return uploadDriveMedia(config, target, blob, fileName, "bitable_image", error);
  }
}

async function uploadDriveMedia(config, target, blob, fileName, parentType, originalError) {
  const endpoint = `${trimTrailingSlash(config.feishuBaseUrl)}/open-apis/drive/v1/medias/upload_all`;
  const formData = new FormData();
  formData.append("file_name", fileName);
  formData.append("parent_type", parentType);
  formData.append("parent_node", target.appToken);
  formData.append("size", String(blob.size));
  formData.append("file", blob, fileName);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${target.token}`
    },
    body: formData
  });

  const { payload, rawText } = await parseResponseBody(response);
  if (!response.ok || payload.code !== 0 || !payload.data?.file_token) {
    const message = `上传封面图失败：${formatFeishuError(response, payload, rawText)}`;
    if (originalError) {
      throw new Error(`${message}；首次尝试错误：${normalizeError(originalError)}`);
    }
    throw new Error(message);
  }

  return payload.data.file_token;
}

async function summarizePageInChinese(translationConfig, pageInfo) {
  const maxContentChars = Number(translationConfig.maxContentChars) || 12000;
  const contentText = (pageInfo.contentText || pageInfo.description || "").slice(0, maxContentChars);
  const categories = parseCategoryList(translationConfig.categories);
  const response = await fetch(translationConfig.endpoint.trim(), {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${translationConfig.apiKey.trim()}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: translationConfig.model.trim(),
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "你是网页收藏整理助手。请阅读网页内容，生成适合个人资源库的中文标题、摘要、标签和分类。分类要准确，标签要细。保留产品名、品牌名、专有名词。只输出 JSON。"
        },
        {
          role: "user",
          content: JSON.stringify({
            title: pageInfo.title || "",
            description: pageInfo.description || "",
            url: pageInfo.url || "",
            domain: pageInfo.domain || "",
            content: contentText,
            category_candidates: categories,
            output_schema: {
              title: "中文标题，40字以内",
              summary: "基于正文生成的中文摘要，80字以内",
              tags: "数组，2-6 个中文短标签，可以包含具体主题，如动效、图标、Figma、写作、PPT、Notion、CSS、React、灵感、素材等",
              category: "字符串，优先从 category_candidates 中选择最贴切的 1 个；如果都不合适，可返回更准确的新分类，6字以内"
            }
          })
        }
      ],
      response_format: {
        type: "json_object"
      }
    })
  });

  const { payload, rawText } = await parseResponseBody(response);
  if (!response.ok) {
    throw new Error(`翻译接口失败：${formatGenericHttpError(response, payload, rawText)}`);
  }

  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("翻译接口没有返回内容");
  }

  const result = parseJsonText(content);
  return {
    title: typeof result.title === "string" ? result.title.trim() : "",
    summary: typeof result.summary === "string" ? result.summary.trim() : "",
    tags: Array.isArray(result.tags) ? result.tags : [],
    category: typeof result.category === "string" ? result.category.trim() : ""
  };
}

function generateContentInfo(info) {
  const text = `${info.title || ""} ${info.description || ""} ${info.domain || ""}`.toLowerCase();
  const tags = [];

  const rules = [
    ["AI", ["ai", "人工智能", "openai", "chatgpt", "llm", "大模型"]],
    ["开发工具", ["github", "code", "api", "developer", "javascript", "python", "编程"]],
    ["设计工具", ["design", "figma", "ui", "ux", "设计"]],
    ["动效", ["animation", "motion", "动效", "动画"]],
    ["图标", ["icon", "icons", "图标"]],
    ["写作", ["writing", "copywriting", "newsletter", "写作"]],
    ["办公效率", ["tool", "workflow", "automation", "productivity", "效率", "自动化"]],
    ["文章", ["blog", "newsletter", "article", "post", "博客", "文章"]]
  ];

  for (const [tag, keywords] of rules) {
    if (keywords.some((keyword) => text.includes(keyword.toLowerCase()))) {
      tags.push(tag);
    }
  }

  const uniqueTags = [...new Set(tags)].slice(0, 5);
  const category = uniqueTags[0] || "未分类";

  return {
    summary: info.summary || buildSummary(info),
    tags: uniqueTags,
    category
  };
}

function normalizeTags(tags) {
  return [
    ...new Set(
      tags
        .filter((tag) => typeof tag === "string")
        .map((tag) => tag.trim().replace(/^#/, ""))
        .filter((tag) => tag && tag.length <= 12)
    )
  ].slice(0, 6);
}

function normalizeCategory(category, categoriesText = "") {
  if (typeof category !== "string") return "";
  const normalized = category.trim().replace(/^#/, "");
  if (!normalized || normalized.length > 12) return "";
  const categories = parseCategoryList(categoriesText);
  const matchedCategory = categories.find((item) => item === normalized);
  return matchedCategory || normalized;
}

function parseCategoryList(categoriesText = "") {
  return [
    ...new Set(
      categoriesText
        .split(/[,，\n]/)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ];
}

function buildSummary(info) {
  const source = info.description || info.title || info.url;
  return source.length > 240 ? `${source.slice(0, 237)}...` : source;
}

async function upsertBitableRecordWithFallback(config, record, url, buildFallbackRecord, buildMinimalRecord) {
  const target = await getBitableTarget(config);
  const existingRecordId = await findExistingRecordIdByUrl(target, config.fields.url, url);

  try {
    const action = await upsertBitableRecord(target, existingRecordId, record);
    return { fallbackUsed: false, action };
  } catch (error) {
    if (isPermissionError(error)) {
      throw error;
    }

    const fallbackRecord = buildFallbackRecord();
    try {
      const action = await upsertBitableRecord(target, existingRecordId, fallbackRecord);
      await recordResult({
        ok: false,
        title: record.fields?.[config.fields.title],
        url: record.fields?.[config.fields.url]?.link || "",
        message: `完整字段写入失败，已降级写入核心字段。原错误：${normalizeError(error)}`,
        syncedAt: new Date().toISOString()
      });
      return { fallbackUsed: true, action };
    } catch (fallbackError) {
      if (isPermissionError(fallbackError)) {
        throw fallbackError;
      }

      const minimalRecord = buildMinimalRecord();
      try {
        const action = await upsertBitableRecord(target, existingRecordId, minimalRecord);
        await recordResult({
          ok: false,
          title: record.fields?.[config.fields.title],
          url: record.fields?.[config.fields.url]?.link || "",
          message: `完整字段和核心字段写入失败，已仅写入 URL。原错误：${normalizeError(fallbackError)}`,
          syncedAt: new Date().toISOString()
        });
        return { fallbackUsed: true, action };
      } catch (minimalError) {
        throw new Error(
          [
            "完整字段、核心字段和最小 URL 字段都写入失败。",
            `完整字段错误：${normalizeError(error)}`,
            `核心字段错误：${normalizeError(fallbackError)}`,
            `最小字段错误：${normalizeError(minimalError)}`
          ].join(" ")
        );
      }
    }
  }
}

async function createBitableRecord(config, record) {
  const target = await getBitableTarget(config);
  return postBitableRecord(target.endpoint, target.token, record);
}

async function upsertBitableRecord(target, existingRecordId, record) {
  if (existingRecordId) {
    await putBitableRecord(target, existingRecordId, record);
    return "updated";
  }

  await postBitableRecord(target.endpoint, target.token, record);
  return "created";
}

function buildSyncSuccessMessage(result) {
  const actionText = result.action === "updated" ? "已更新飞书多维表格原记录" : "已同步到飞书多维表格";
  return result.fallbackUsed ? `${actionText}（部分字段格式需调整）` : actionText;
}

async function triggerSiteDeployIfEnabled(config, syncResult) {
  if (!config.deploy?.enabled) return "";

  try {
    const skippedReason = await shouldSkipDeployTrigger(config.deploy);
    if (skippedReason) return skippedReason;

    await dispatchGithubWorkflow(config.deploy);
    await chrome.storage.local.set({ [LAST_DEPLOY_TRIGGER_KEY]: Date.now() });
    return "已触发网站刷新";
  } catch (error) {
    await recordResult({
      ok: false,
      title: syncResult.title,
      url: syncResult.url,
      message: `飞书已同步，但触发网站刷新失败：${normalizeError(error)}`,
      syncedAt: new Date().toISOString()
    });
    return "网站刷新触发失败，可等定时任务刷新";
  }
}

async function shouldSkipDeployTrigger(deployConfig) {
  const cooldownMs = Math.max(Number(deployConfig.cooldownSeconds) || 120, 30) * 1000;
  const data = await chrome.storage.local.get(LAST_DEPLOY_TRIGGER_KEY);
  const lastTriggeredAt = Number(data[LAST_DEPLOY_TRIGGER_KEY]) || 0;
  if (Date.now() - lastTriggeredAt < cooldownMs) {
    return "网站刷新已在排队中";
  }
  return "";
}

async function dispatchGithubWorkflow(deployConfig) {
  const owner = deployConfig.owner?.trim();
  const repo = deployConfig.repo?.trim();
  const workflow = deployConfig.workflow?.trim();
  const ref = deployConfig.ref?.trim();
  const token = deployConfig.token?.trim();

  if (!owner || !repo || !workflow || !ref || !token) {
    throw new Error("缺少 GitHub 自动刷新配置");
  }

  const endpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    body: JSON.stringify({ ref })
  });

  if (response.status !== 204) {
    const body = await response.text();
    throw new Error(`GitHub Actions 触发失败：http=${response.status}; body=${body || "empty"}`);
  }
}

async function getBitableTarget(config) {
  const token = await getTenantAccessToken(config);
  const appToken = await resolveBitableAppToken(config, token);
  const tableId = resolveTableId(config);
  const endpoint = `${trimTrailingSlash(config.feishuBaseUrl)}/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`;

  return {
    token,
    appToken,
    tableId,
    endpoint
  };
}

async function postBitableRecord(endpoint, token, record) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify(record)
  });

  const { payload, rawText } = await parseResponseBody(response);
  if (!response.ok || payload.code !== 0) {
    throw new Error(`写入多维表格失败：${formatFeishuError(response, payload, rawText)}`);
  }

  return payload.data;
}

async function putBitableRecord(target, recordId, record) {
  const endpoint = `${target.endpoint}/${encodeURIComponent(recordId)}`;
  const response = await fetch(endpoint, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${target.token}`,
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify(record)
  });

  const { payload, rawText } = await parseResponseBody(response);
  if (!response.ok || payload.code !== 0) {
    throw new Error(`更新多维表格失败：${formatFeishuError(response, payload, rawText)}`);
  }

  return payload.data;
}

async function findExistingRecordIdByUrl(target, urlFieldName, url) {
  if (!urlFieldName || !url) return "";

  let pageToken = "";
  for (let page = 0; page < 20; page += 1) {
    const endpoint = new URL(target.endpoint);
    endpoint.searchParams.set("page_size", "500");
    if (pageToken) endpoint.searchParams.set("page_token", pageToken);

    const response = await fetch(endpoint.toString(), {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${target.token}`
      }
    });

    const { payload, rawText } = await parseResponseBody(response);
    if (!response.ok || payload.code !== 0) {
      throw new Error(`查询已有记录失败：${formatFeishuError(response, payload, rawText)}`);
    }

    const items = payload.data?.items || [];
    const matched = items.find((item) => normalizeUrl(extractUrlFromField(item.fields?.[urlFieldName])) === normalizeUrl(url));
    if (matched?.record_id) {
      return matched.record_id;
    }

    if (!payload.data?.has_more || !payload.data?.page_token) {
      return "";
    }
    pageToken = payload.data.page_token;
  }

  return "";
}

function extractUrlFromField(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value.link === "string") return value.link;
  if (typeof value.url === "string") return value.url;
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = extractUrlFromField(item);
      if (url) return url;
    }
  }
  return "";
}

async function resolveBitableAppToken(config, tenantAccessToken) {
  const source = config.appToken.trim();
  const parsedSource = parseBitableSource(source);

  if (parsedSource.type === "app_token") {
    return parsedSource.token;
  }

  const node = await getWikiNodeInfo(config, tenantAccessToken, parsedSource.token);
  if (node.obj_type !== "bitable" || !node.obj_token) {
    throw new Error("知识库节点不是多维表格，或未返回 obj_token");
  }

  return node.obj_token;
}

function parseBitableSource(source) {
  if (!source) {
    throw new Error("缺少多维表格来源");
  }

  try {
    const url = new URL(source);
    const baseMatch = url.pathname.match(/\/base\/([^/?#]+)/);
    if (baseMatch?.[1]) {
      return {
        type: "app_token",
        token: decodeURIComponent(baseMatch[1])
      };
    }

    const wikiMatch = url.pathname.match(/\/wiki\/([^/?#]+)/);
    if (wikiMatch?.[1]) {
      return {
        type: "wiki_node",
        token: decodeURIComponent(wikiMatch[1])
      };
    }
  } catch (_error) {
    // Not a URL; continue with token heuristics below.
  }

  if (/^wik/i.test(source)) {
    return {
      type: "wiki_node",
      token: source
    };
  }

  return {
    type: "app_token",
    token: source
  };
}

function parseTableIdFromSource(source) {
  const tblMatch = source.match(/(?:^|[?&#/])(?:table=|table_id=)?(tbl[a-zA-Z0-9]+)/);
  if (tblMatch?.[1]) {
    return tblMatch[1];
  }

  try {
    const url = new URL(source);
    const searchAndHash = `${url.search}&${url.hash.replace(/^#/, "")}`;
    const params = new URLSearchParams(searchAndHash);
    return params.get("table") || params.get("table_id") || "";
  } catch (_error) {
    return "";
  }
}

function resolveTableId(config) {
  const sourceTableId = parseTableIdFromSource(config.appToken);
  const manualTableId = config.tableId.trim();
  const tableId = sourceTableId || manualTableId;

  if (/^vew/i.test(tableId)) {
    throw new Error("Table ID 填成了视图 ID。请使用 tbl... 开头的表 ID，不要使用 vew... 开头的 view ID。");
  }

  if (tableId && !/^tbl/i.test(tableId)) {
    throw new Error(`Table ID 看起来不正确：${tableId}。飞书多维表格的 tableId 通常以 tbl 开头。`);
  }

  return tableId;
}

async function getWikiNodeInfo(config, tenantAccessToken, nodeToken) {
  const endpoint = `${trimTrailingSlash(config.feishuBaseUrl)}/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(nodeToken)}`;
  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${tenantAccessToken}`
    }
  });

  const { payload, rawText } = await parseResponseBody(response);
  if (!response.ok || payload.code !== 0) {
    throw new Error(`获取知识库节点信息失败：${formatFeishuError(response, payload, rawText)}`);
  }

  return payload.data?.node || payload.data || {};
}

async function getTenantAccessToken(config) {
  const cached = await chrome.storage.local.get(TOKEN_CACHE_KEY);
  const cache = cached[TOKEN_CACHE_KEY];
  const now = Date.now();

  if (cache?.token && cache.expiresAt > now + 60_000) {
    return cache.token;
  }

  const endpoint = `${trimTrailingSlash(config.feishuBaseUrl)}/open-apis/auth/v3/tenant_access_token/internal`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      app_id: config.appId,
      app_secret: config.appSecret
    })
  });

  const { payload, rawText } = await parseResponseBody(response);
  if (!response.ok || payload.code !== 0 || !payload.tenant_access_token) {
    throw new Error(`获取 tenant_access_token 失败：${formatFeishuError(response, payload, rawText)}`);
  }

  const expiresAt = now + Math.max((payload.expire || 7200) - 300, 60) * 1000;
  await chrome.storage.local.set({
    [TOKEN_CACHE_KEY]: {
      token: payload.tenant_access_token,
      expiresAt
    }
  });

  return payload.tenant_access_token;
}

async function parseResponseBody(response) {
  const rawText = await response.text();
  if (!rawText) {
    return {
      payload: {},
      rawText: ""
    };
  }

  try {
    return {
      payload: JSON.parse(rawText),
      rawText
    };
  } catch (_error) {
    return {
      payload: {},
      rawText
    };
  }
}

async function recordResult(result) {
  const data = await chrome.storage.local.get(RECENT_SYNC_KEY);
  const results = [result, ...(data[RECENT_SYNC_KEY] || [])].slice(0, MAX_RECENT_RESULTS);
  await chrome.storage.local.set({ [RECENT_SYNC_KEY]: results });
}

function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch (_error) {
    return "";
  }
}

function normalizeUrl(url) {
  try {
    const parsedUrl = new URL(url);
    parsedUrl.hash = "";
    parsedUrl.hostname = parsedUrl.hostname.toLowerCase();
    if (parsedUrl.pathname !== "/" && parsedUrl.pathname.endsWith("/")) {
      parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/, "");
    }
    return parsedUrl.toString();
  } catch (_error) {
    return String(url || "").trim();
  }
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function normalizeError(error) {
  return error?.message || String(error);
}

function isPermissionError(error) {
  const message = normalizeError(error);
  return message.includes("code=99991672") || message.includes("code=91403");
}

function formatFeishuError(response, payload, rawText = "") {
  const parts = [];
  parts.push(`http=${response.status}`);
  if (payload.code !== undefined) parts.push(`code=${payload.code}`);
  if (payload.msg) parts.push(`msg=${payload.msg}`);
  if (payload.code === 91403) {
    parts.push(
      "hint=应用身份没有访问该 base 文档或表格的权限。请在飞书 base 文档右上角分享/协作者里添加该应用或应用机器人，并给可编辑权限；确认应用已发布到当前企业；确认 tableId 是表 ID 而不是 view ID。"
    );
  }
  if (payload.code === 1254041) {
    parts.push(
      "hint=找不到 tableId。请复制打开目标数据表时浏览器地址栏的完整 /base URL，或手动填写 tbl... 开头的表 ID；不要填写 vew... 开头的视图 ID。"
    );
  }
  if (payload.code === 1254045) {
    parts.push(
      "hint=字段名不存在。请确认扩展设置里的字段映射和当前 table 的列名完全一致，包含大小写、空格和中英文；也请确认写入的是正确的 table。"
    );
  }
  if (payload.code === 1254069) {
    parts.push(
      "hint=字段类型不匹配。当前 MVP 只能把封面图写入“链接”字段；如果飞书里“封面图”是附件/图片字段，请在扩展设置里清空封面图字段，或把该列改成链接字段。"
    );
  }
  if (payload.error) parts.push(`error=${stringifyCompact(payload.error)}`);
  if (payload.data) parts.push(`data=${stringifyCompact(payload.data)}`);
  if (rawText && !payload.msg && !payload.error && !payload.data) {
    parts.push(`body=${rawText.slice(0, 1000)}`);
  }
  if (response.statusText) parts.push(`statusText=${response.statusText}`);
  return parts.join("; ");
}

function formatGenericHttpError(response, payload, rawText = "") {
  const parts = [`http=${response.status}`];
  if (payload.error) parts.push(`error=${stringifyCompact(payload.error)}`);
  if (payload.message) parts.push(`message=${payload.message}`);
  if (rawText && !payload.error && !payload.message) parts.push(`body=${rawText.slice(0, 1000)}`);
  if (response.statusText) parts.push(`statusText=${response.statusText}`);
  return parts.join("; ");
}

function parseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return {};
    try {
      return JSON.parse(match[0]);
    } catch (__error) {
      return {};
    }
  }
}

function stringifyCompact(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value);
  }
}
