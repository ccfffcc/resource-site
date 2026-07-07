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

const form = document.querySelector("#options-form");
const statusEl = document.querySelector("#status");
const testButton = document.querySelector("#test-button");

init();

async function init() {
  const { config } = await chrome.storage.sync.get("config");
  const mergedConfig = mergeConfig(DEFAULT_CONFIG, config || {});
  await chrome.storage.sync.set({ config: mergedConfig });
  fillForm(mergedConfig);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const config = readForm();
  await chrome.storage.sync.set({ config });
  showStatus("设置已保存");
});

testButton.addEventListener("click", async () => {
  testButton.disabled = true;
  showStatus("正在测试同步...");

  try {
    const response = await chrome.runtime.sendMessage({ type: "test-sync-current-tab" });
    if (!response?.ok) throw new Error(response?.error || "测试同步失败");
    showStatus(response.result.message);
  } catch (error) {
    showStatus(error.message, true);
  } finally {
    testButton.disabled = false;
  }
});

function fillForm(config) {
  form.feishuBaseUrl.value = config.feishuBaseUrl;
  form.appId.value = config.appId;
  form.appSecret.value = config.appSecret;
  form.appToken.value = config.appToken;
  form.tableId.value = config.tableId;
  form.translationEnabled.checked = config.translation.enabled;
  form.translationEndpoint.value = config.translation.endpoint;
  form.translationApiKey.value = config.translation.apiKey;
  form.translationModel.value = config.translation.model;
  form.translationMaxContentChars.value = config.translation.maxContentChars;
  form.translationCategories.value = config.translation.categories;
  form.deployEnabled.checked = config.deploy.enabled;
  form.deployOwner.value = config.deploy.owner;
  form.deployRepo.value = config.deploy.repo;
  form.deployWorkflow.value = config.deploy.workflow;
  form.deployRef.value = config.deploy.ref;
  form.deployToken.value = config.deploy.token;
  form.deployCooldownSeconds.value = config.deploy.cooldownSeconds;
  form.fieldTitle.value = config.fields.title;
  form.fieldUrl.value = config.fields.url;
  form.fieldDomain.value = config.fields.domain;
  form.fieldSummary.value = config.fields.summary;
  form.fieldTags.value = config.fields.tags;
  form.fieldCategory.value = config.fields.category;
  form.fieldCoverImage.value = config.fields.coverImage;
  form.fieldCreatedAt.value = config.fields.createdAt;
}

function readForm() {
  return {
    feishuBaseUrl: form.feishuBaseUrl.value.trim(),
    appId: form.appId.value.trim(),
    appSecret: form.appSecret.value.trim(),
    appToken: form.appToken.value.trim(),
    tableId: form.tableId.value.trim(),
    translation: {
      enabled: form.translationEnabled.checked,
      endpoint: form.translationEndpoint.value.trim(),
      apiKey: form.translationApiKey.value.trim(),
      model: form.translationModel.value.trim(),
      maxContentChars: Number(form.translationMaxContentChars.value) || 12000,
      categories: form.translationCategories.value.trim()
    },
    deploy: {
      enabled: form.deployEnabled.checked,
      owner: form.deployOwner.value.trim(),
      repo: form.deployRepo.value.trim(),
      workflow: form.deployWorkflow.value.trim(),
      ref: form.deployRef.value.trim(),
      token: form.deployToken.value.trim(),
      cooldownSeconds: Number(form.deployCooldownSeconds.value) || 120
    },
    fields: {
      title: form.fieldTitle.value.trim(),
      url: form.fieldUrl.value.trim(),
      domain: form.fieldDomain.value.trim(),
      summary: form.fieldSummary.value.trim(),
      tags: form.fieldTags.value.trim(),
      category: form.fieldCategory.value.trim(),
      coverImage: form.fieldCoverImage.value.trim(),
      createdAt: form.fieldCreatedAt.value.trim()
    }
  };
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

function showStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.className = isError ? "error" : "success";
}
