const state = {
  resources: [],
  search: "",
  category: "全部",
  tag: "",
  sort: "newest"
};

const els = {
  count: document.querySelector("#resource-count"),
  search: document.querySelector("#search-input"),
  categories: document.querySelector("#category-list"),
  tags: document.querySelector("#tag-list"),
  grid: document.querySelector("#resource-grid"),
  empty: document.querySelector("#empty-state"),
  title: document.querySelector("#view-title"),
  sort: document.querySelector("#sort-select")
};

init();

async function init() {
  try {
    const response = await fetch("data/resources.json", { cache: "no-store" });
    if (!response.ok) throw new Error("资源数据不存在");
    const data = await response.json();
    state.resources = Array.isArray(data.resources) ? data.resources : [];
  } catch (_error) {
    state.resources = [];
  }

  bindEvents();
  renderFilters();
  render();
}

function bindEvents() {
  els.search.addEventListener("input", (event) => {
    state.search = event.target.value.trim().toLowerCase();
    render();
  });

  els.sort.addEventListener("change", (event) => {
    state.sort = event.target.value;
    render();
  });
}

function renderFilters() {
  const categories = ["全部", ...unique(state.resources.map((item) => item.category || "未分类"))];
  els.categories.replaceChildren(
    ...categories.map((category) => button(category, "filter-button", state.category === category, () => {
      state.category = category;
      renderFilters();
      render();
    }))
  );

  const tags = unique(state.resources.flatMap((item) => item.tags || [])).slice(0, 60);
  els.tags.replaceChildren(
    ...tags.map((tag) => button(tag, "tag-button", state.tag === tag, () => {
      state.tag = state.tag === tag ? "" : tag;
      renderFilters();
      render();
    }))
  );
}

function render() {
  const resources = filteredResources();
  els.count.textContent = `${state.resources.length} 个资源`;
  els.title.textContent = state.category === "全部" ? "全部资源" : state.category;
  els.empty.hidden = resources.length > 0;
  els.empty.textContent = state.resources.length
    ? "没有找到匹配的资源。"
    : "还没有同步数据。请先运行 npm run sync 生成资源列表。";
  els.grid.replaceChildren(...resources.map(renderCard));
}

function filteredResources() {
  const query = state.search;
  const resources = state.resources.filter((item) => {
    const matchesCategory = state.category === "全部" || (item.category || "未分类") === state.category;
    const matchesTag = !state.tag || (item.tags || []).includes(state.tag);
    const haystack = [item.title, item.summary, item.domain, item.category, ...(item.tags || [])]
      .join(" ")
      .toLowerCase();
    return matchesCategory && matchesTag && (!query || haystack.includes(query));
  });

  return resources.sort((a, b) => {
    if (state.sort === "title") return (a.title || "").localeCompare(b.title || "", "zh-Hans-CN");
    if (state.sort === "domain") return (a.domain || "").localeCompare(b.domain || "");
    return Number(b.createdAt || 0) - Number(a.createdAt || 0);
  });
}

function renderCard(item) {
  const article = document.createElement("article");
  article.className = "resource-card";

  const cover = document.createElement("div");
  cover.className = "cover";
  if (item.coverUrl) {
    const img = document.createElement("img");
    img.src = item.coverUrl;
    img.alt = "";
    img.loading = "lazy";
    cover.append(img);
  } else {
    const fallback = document.createElement("div");
    fallback.className = "cover-fallback";
    fallback.textContent = item.category || item.domain || "资源";
    cover.append(fallback);
  }

  const body = document.createElement("div");
  body.className = "card-body";

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.append(textEl("span", item.domain || "未知来源"), textEl("span", formatDate(item.createdAt)));

  const category = textEl("span", item.category || "未分类");
  category.className = "category";

  const title = document.createElement("h3");
  const link = document.createElement("a");
  link.href = item.url || "#";
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = item.title || item.url || "未命名资源";
  title.append(link);

  const summary = textEl("p", item.summary || "暂无摘要");
  summary.className = "summary";

  const tags = document.createElement("div");
  tags.className = "tags";
  tags.replaceChildren(...(item.tags || []).map((tag) => {
    const el = textEl("span", tag);
    el.className = "tag";
    return el;
  }));

  body.append(meta, category, title, summary, tags);
  article.append(cover, body);
  return article;
}

function button(label, className, active, onClick) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = active ? `${className} active` : className;
  el.textContent = label;
  el.addEventListener("click", onClick);
  return el;
}

function textEl(tagName, text) {
  const el = document.createElement(tagName);
  el.textContent = text || "";
  return el;
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("zh-CN");
}
