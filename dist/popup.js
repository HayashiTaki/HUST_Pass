"use strict";
(() => {
  // src/popup.ts
  var toggle = document.getElementById("enabled");
  var retry = document.getElementById("retry");
  var status = document.getElementById("status");
  var attempts = document.getElementById("attempts");
  var operation = false;
  var operationError = "";
  async function send(message) {
    const result = await chrome.runtime.sendMessage(message);
    if (result?.error) throw new Error(result.error);
    return result;
  }
  async function refresh() {
    if (operation) return;
    try {
      const result = await send({ type: "ui.status" });
      toggle.checked = result.enabled;
      status.textContent = operationError || (!result.supported ? "\u8BF7\u5728\u534E\u4E2D\u5927\u7EDF\u4E00\u8EAB\u4EFD\u8BA4\u8BC1\u7684\u5BC6\u7801\u767B\u5F55\u9875\u4F7F\u7528\u3002" : !result.enabled ? "\u5DF2\u6682\u505C\uFF0C\u53EF\u624B\u52A8\u767B\u5F55\u3002" : result.state.message);
      attempts.textContent = result.supported && result.state.count ? `\u672C\u8F6E\u5DF2\u5C1D\u8BD5 ${result.state.count} / 3 \u6B21` : "";
      retry.disabled = !result.enabled || !result.supported || ["activating", "recognizing", "submitted"].includes(result.state?.phase);
    } catch (error) {
      status.textContent = `\u65E0\u6CD5\u8BFB\u53D6\u6269\u5C55\u72B6\u6001\uFF1A${error instanceof Error ? error.message : "\u8BF7\u91CD\u65B0\u52A0\u8F7D\u6269\u5C55"}`;
      retry.disabled = true;
    }
  }
  async function act(message) {
    operationError = "";
    operation = true;
    retry.disabled = true;
    toggle.disabled = true;
    try {
      await send(message);
    } catch (error) {
      operationError = error instanceof Error ? error.message : "\u64CD\u4F5C\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5";
      status.textContent = operationError;
    } finally {
      operation = false;
      toggle.disabled = false;
    }
    await refresh();
  }
  toggle.addEventListener("change", () => void act({ type: "ui.enable", enabled: toggle.checked }));
  retry.addEventListener("click", () => void act({ type: "ui.retry" }));
  void refresh();
  setInterval(() => void refresh(), 1e3);
})();
