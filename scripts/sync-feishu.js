#!/usr/bin/env node

const fs = require("fs/promises");
const path = require("path");

loadDotEnv(".env");

const config = {
  feishuBaseUrl: process.env.FEISHU_BASE_URL || "https://open.feishu.cn",
  appId: process.env.FEISHU_APP_ID || "",
  appSecret: process.env.FEISHU_APP_SECRET || "",
  bitableSource: process.env.BITABLE_SOURCE || "",
  tableId: process.env.TABLE_ID || "",
  outputDir: process.env.OUTPUT_DIR || "website",
  downloadCovers: process.env.DOWNLOAD_COVERS !== "0",
  coverMaxWidth: Number(process.env.COVER_MAX_WIDTH) || 1500,
  coverQuality: Number(process.env.COVER_QUALITY) || 72,
  fields: {
    title: process.env.FIELD_TITLE || "标题",
    url: process.env.FIELD_URL || "URL",
    domain: process.env.FIELD_DOMAIN || "域名",
    summary: process.env.FIELD_SUMMARY || "摘要",
    tags: process.env.FIELD_TAGS || "标签",
    category: process.env.FIELD_CATEGORY || "分类",
    cover: process.env.FIELD_COVER || "封面图",
    createdAt: process.env.FIELD_CREATED_AT || "收藏时间"
  }
};

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (_error) {
    return false;
  }
}

function loadDotEnv(filePath) {
  try {
    const fsSync = require("fs");
    if (!fsSync.existsSync(filePath)) return;
    const content = fsSync.readFileSync(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex === -1) continue;
      const key = trimmed.slice(0, separatorIndex).trim();
      const rawValue = trimmed.slice(separatorIndex + 1).trim();
      const value = rawValue.replace(/^["']|["']$/g, "");
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch (_error) {
    // Env loading is a convenience; explicit environment variables still work.
  }
}

async function main() {
  validateConfig();
  const token = await getTenantAccessToken();
  const appToken = await resolveBitableAppToken(token);
  const tableId = resolveTableId();
  const records = await listRecords(token, appToken, tableId);
  const resources = [];
  for (const record of records) {
    resources.push(await mapRecordToResource(record, token));
  }
  const sortedResources = resources
    .filter((item) => item.url)
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));

  const dataDir = path.join(config.outputDir, "data");
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(
    path.join(dataDir, "resources.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), resources: sortedResources }, null, 2)
  );

  console.log(`Synced ${sortedResources.length} resources to ${path.join(dataDir, "resources.json")}`);
}

function validateConfig() {
  const missing = [];
  if (!config.appId) missing.push("FEISHU_APP_ID");
  if (!config.appSecret) missing.push("FEISHU_APP_SECRET");
  if (!config.bitableSource) missing.push("BITABLE_SOURCE");
  if (!config.tableId && !parseTableIdFromSource(config.bitableSource)) missing.push("TABLE_ID");
  if (missing.length) throw new Error(`Missing env: ${missing.join(", ")}`);
}

async function getTenantAccessToken() {
  const endpoint = `${trimTrailingSlash(config.feishuBaseUrl)}/open-apis/auth/v3/tenant_access_token/internal`;
  const payload = await requestJson(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      app_id: config.appId,
      app_secret: config.appSecret
    })
  });

  if (!payload.tenant_access_token) throw new Error(`No tenant_access_token: ${JSON.stringify(payload)}`);
  return payload.tenant_access_token;
}

async function resolveBitableAppToken(token) {
  const parsed = parseBitableSource(config.bitableSource);
  if (parsed.type === "app_token") return parsed.token;

  const endpoint = `${trimTrailingSlash(config.feishuBaseUrl)}/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(parsed.token)}`;
  const payload = await requestJson(endpoint, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const node = payload.data?.node || payload.data || {};
  if (node.obj_type !== "bitable" || !node.obj_token) {
    throw new Error("Wiki node is not a bitable node.");
  }
  return node.obj_token;
}

function parseBitableSource(source) {
  try {
    const url = new URL(source);
    const baseMatch = url.pathname.match(/\/base\/([^/?#]+)/);
    if (baseMatch?.[1]) return { type: "app_token", token: decodeURIComponent(baseMatch[1]) };
    const wikiMatch = url.pathname.match(/\/wiki\/([^/?#]+)/);
    if (wikiMatch?.[1]) return { type: "wiki_node", token: decodeURIComponent(wikiMatch[1]) };
  } catch (_error) {
    // Token input.
  }

  return /^wik/i.test(source) ? { type: "wiki_node", token: source } : { type: "app_token", token: source };
}

function resolveTableId() {
  return parseTableIdFromSource(config.bitableSource) || config.tableId;
}

function parseTableIdFromSource(source) {
  const tblMatch = source.match(/(?:^|[?&#/])(?:table=|table_id=)?(tbl[a-zA-Z0-9]+)/);
  if (tblMatch?.[1]) return tblMatch[1];

  try {
    const url = new URL(source);
    const params = new URLSearchParams(`${url.search}&${url.hash.replace(/^#/, "")}`);
    return params.get("table") || params.get("table_id") || "";
  } catch (_error) {
    return "";
  }
}

async function listRecords(token, appToken, tableId) {
  const records = [];
  let pageToken = "";
  do {
    const endpoint = new URL(
      `${trimTrailingSlash(config.feishuBaseUrl)}/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records`
    );
    endpoint.searchParams.set("page_size", "500");
    if (pageToken) endpoint.searchParams.set("page_token", pageToken);

    const payload = await requestJson(endpoint.toString(), {
      headers: { Authorization: `Bearer ${token}` }
    });

    records.push(...(payload.data?.items || []));
    pageToken = payload.data?.has_more ? payload.data?.page_token || "" : "";
  } while (pageToken);

  return records;
}

async function mapRecordToResource(record, token) {
  const fields = record.fields || {};
  const coverAttachment = extractAttachment(fields[config.fields.cover]);
  return {
    id: record.record_id,
    title: textValue(fields[config.fields.title]),
    url: urlValue(fields[config.fields.url]),
    domain: textValue(fields[config.fields.domain]),
    summary: textValue(fields[config.fields.summary]),
    tags: arrayValue(fields[config.fields.tags]),
    category: textValue(fields[config.fields.category]) || "未分类",
    coverUrl: await coverUrlValue(coverAttachment, token, record.record_id, textValue(fields[config.fields.title])),
    createdAt: dateValue(fields[config.fields.createdAt])
  };
}

async function coverUrlValue(attachment, token, recordId, title) {
  if (!attachment.token) {
    console.warn(`No cover token for ${recordId} ${title || ""}`.trim());
    return "";
  }
  if (!config.downloadCovers) return "";

  const coverDir = path.join(config.outputDir, "assets", "covers");
  await fs.mkdir(coverDir, { recursive: true });
  const endpoint = `${trimTrailingSlash(config.feishuBaseUrl)}/open-apis/drive/v1/medias/${encodeURIComponent(attachment.token)}/download`;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) {
      await sleep(attempt * 1500);
    }

    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (response.ok) {
      const buffer = Buffer.from(await response.arrayBuffer());
      const coverPath = await writeOptimizedCover(buffer, coverDir, recordId, attachment.extension);
      await sleep(800);
      return coverPath;
    }

    const body = await response.text();
    if (isFeishuRateLimit(body) && attempt < 3) {
      console.warn(`Retry cover for ${recordId} ${title || ""}: ${response.status} rate limited`.trim());
      continue;
    }

    console.warn(`Skip cover for ${recordId} ${title || ""}: ${response.status} ${body}`.trim());
    return "";
  }

  return "";
}

async function writeOptimizedCover(buffer, coverDir, recordId, extension) {
  try {
    const sharp = require("sharp");
    const fileName = `${recordId}.webp`;
    const outputPath = path.join(coverDir, fileName);
    await sharp(buffer)
      .resize({ width: config.coverMaxWidth, withoutEnlargement: true })
      .webp({ quality: config.coverQuality })
      .toFile(outputPath);
    return `assets/covers/${fileName}`;
  } catch (error) {
    const fileName = `${recordId}${extension || ".png"}`;
    const outputPath = path.join(coverDir, fileName);
    await fs.writeFile(outputPath, buffer);
    console.warn(`Cover compression skipped for ${recordId}: ${error.message}`);
    return `assets/covers/${fileName}`;
  }
}

async function requestJson(endpoint, options = {}) {
  const response = await fetch(endpoint, options);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok || payload.code !== 0) {
    throw new Error(`Request failed: ${response.status} ${text}`);
  }
  return payload;
}

function textValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join(", ");
  if (typeof value.text === "string") return value.text;
  if (typeof value.name === "string") return value.name;
  return "";
}

function urlValue(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value.link === "string") return value.link;
  if (typeof value.url === "string") return value.url;
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = urlValue(item);
      if (url) return url;
    }
  }
  return "";
}

function arrayValue(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean);
  if (typeof value === "string") return value.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
  return [textValue(value)].filter(Boolean);
}

function extractAttachment(value) {
  if (!value) return { token: "", extension: ".png" };
  if (Array.isArray(value)) {
    for (const item of value) {
      const attachment = extractAttachment(item);
      if (attachment.token) return attachment;
    }
  }

  if (typeof value === "object") {
    const token = value.file_token || value.token || value.fileToken || value.tmp_url || value.url || "";
    return {
      token,
      extension: normalizeImageExtension(value.name || value.file_name || value.fileName || value.type || "")
    };
  }

  if (typeof value === "string") {
    return {
      token: value,
      extension: normalizeImageExtension(value)
    };
  }

  return { token: "", extension: ".png" };
}

function normalizeImageExtension(value) {
  const match = String(value).toLowerCase().match(/\.(png|jpe?g|webp|gif)(?:$|\?)/);
  if (!match) return ".png";
  return match[0].replace(/\?.*$/, "").replace(".jpeg", ".jpg");
}

function isFeishuRateLimit(body) {
  try {
    return JSON.parse(body).code === 99991400;
  } catch (_error) {
    return body.includes("frequency limit");
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dateValue(value) {
  if (!value) return 0;
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}
