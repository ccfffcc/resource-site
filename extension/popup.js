const resultsEl = document.querySelector("#results");
const openOptionsButton = document.querySelector("#open-options");
const clearResultsButton = document.querySelector("#clear-results");

openOptionsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

clearResultsButton.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "clear-recent-results" });
  await loadResults();
});

loadResults();

async function loadResults() {
  const response = await chrome.runtime.sendMessage({ type: "get-recent-results" });
  const results = response?.results || [];

  if (!results.length) {
    resultsEl.replaceChildren(createEmptyState());
    return;
  }

  resultsEl.replaceChildren(
    ...results.map((result) => {
      const item = document.createElement("article");
      item.className = `result ${result.ok ? "ok" : "failed"}`;

      const title = document.createElement("strong");
      title.textContent = result.title || result.url || "未命名网页";

      const message = document.createElement("pre");
      message.textContent = result.message;
      message.title = result.message || "";

      const time = document.createElement("time");
      time.textContent = new Date(result.syncedAt).toLocaleString();

      item.append(title, message, time);
      return item;
    })
  );
}

function createEmptyState() {
  const empty = document.createElement("p");
  empty.className = "empty";
  empty.textContent = "暂无同步记录";
  return empty;
}
