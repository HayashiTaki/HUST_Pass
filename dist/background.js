"use strict";
(() => {
  // src/protocol.ts
  var MAX_ATTEMPTS = 3;
  var isLoginUrl = (url) => {
    try {
      const u = new URL(url);
      return u.origin === "https://pass.hust.edu.cn" && u.pathname === "/cas/login";
    } catch {
      return false;
    }
  };

  // src/activation.ts
  var jobs = /* @__PURE__ */ new Map();
  function cancelActivation(tab) {
    const job = jobs.get(tab);
    if (job) job.cancelled = true;
  }
  function debuggerDetached(tab) {
    const job = jobs.get(tab);
    if (!job || job.detaching) return false;
    job.cancelled = true;
    return true;
  }
  async function activateAutofill(tab, documentId, token, valid) {
    if (jobs.has(tab)) throw new Error("\u6D4F\u89C8\u5668\u81EA\u52A8\u586B\u5145\u6FC0\u6D3B\u4ECD\u5728\u7ED3\u675F\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
    const job = { cancelled: false, detaching: false };
    jobs.set(tab, job);
    const target = { tabId: tab };
    const deadline = Date.now() + 5e3;
    let attached = false;
    const bounded = async (promise) => {
      let timer;
      try {
        return await Promise.race([promise, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("\u6D4F\u89C8\u5668\u81EA\u52A8\u586B\u5145\u6FC0\u6D3B\u8D85\u65F6\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\u540E\u91CD\u8BD5")), Math.max(0, deadline - Date.now()));
        })]);
      } finally {
        clearTimeout(timer);
      }
    };
    const detach = async () => {
      if (!attached) return;
      job.detaching = true;
      attached = false;
      try {
        await chrome.debugger.detach(target);
      } catch {
      }
    };
    const point = async () => {
      if (job.cancelled || Date.now() >= deadline || !await bounded(valid())) throw new Error("\u81EA\u52A8\u586B\u5145\u6FC0\u6D3B\u5DF2\u53D6\u6D88\uFF0C\u8BF7\u68C0\u67E5\u5F53\u524D\u767B\u5F55\u9875");
      const [current] = await bounded(chrome.tabs.query({ active: true, lastFocusedWindow: true }));
      if (current?.id !== tab) throw new Error("\u767B\u5F55\u9875\u5DF2\u5207\u6362\u5230\u540E\u53F0\uFF0C\u5DF2\u505C\u6B62\u81EA\u52A8\u586B\u5145\u6FC0\u6D3B");
      const result = await bounded(chrome.tabs.sendMessage(tab, { type: "page.activationPoint", token }, { documentId }));
      if (!result?.valid || !isLoginUrl(result.url ?? "") || ![result.x, result.y, result.width, result.height].every(Number.isFinite) || result.x < 0 || result.y < 0 || result.x >= result.width || result.y >= result.height) {
        throw new Error("\u9A8C\u8BC1\u7801\u8F93\u5165\u6846\u4E0D\u53EF\u70B9\u51FB\u6216\u5DF2\u88AB\u906E\u6321\uFF0C\u8BF7\u68C0\u67E5\u767B\u5F55\u9875");
      }
      if (job.cancelled || !await bounded(valid())) throw new Error("\u81EA\u52A8\u586B\u5145\u6FC0\u6D3B\u5DF2\u53D6\u6D88");
      return result;
    };
    try {
      await point();
      const attaching = chrome.debugger.attach(target, "1.3").then(async () => {
        attached = true;
        if (job.cancelled) await detach();
      });
      await bounded(attaching);
      const down = await point();
      await bounded(chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mousePressed", x: down.x, y: down.y, button: "left", buttons: 1, clickCount: 1 }));
      const up = await point();
      if (Math.abs(down.x - up.x) > 1 || Math.abs(down.y - up.y) > 1) throw new Error("\u767B\u5F55\u9875\u5E03\u5C40\u5DF2\u6539\u53D8\uFF0C\u5DF2\u53D6\u6D88\u81EA\u52A8\u586B\u5145\u6FC0\u6D3B");
      await bounded(chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseReleased", x: up.x, y: up.y, button: "left", buttons: 0, clickCount: 1 }));
    } catch (error) {
      if (error instanceof Error && /another debugger|Cannot attach|restricted|denied/i.test(error.message)) {
        throw new Error("\u65E0\u6CD5\u6FC0\u6D3B\u6D4F\u89C8\u5668\u81EA\u52A8\u586B\u5145\uFF0C\u8BF7\u5173\u95ED\u6B64\u9875\u5F00\u53D1\u8005\u5DE5\u5177\u5E76\u786E\u8BA4\u6269\u5C55\u8C03\u8BD5\u6743\u9650\u540E\u5237\u65B0");
      }
      throw error;
    } finally {
      job.cancelled = true;
      await detach();
      if (jobs.get(tab) === job) jobs.delete(tab);
    }
  }

  // src/background.ts
  var chain = Promise.resolve();
  function exclusive(fn) {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {
    });
    return next;
  }
  async function load() {
    const { runtimeState } = await chrome.storage.session.get("runtimeState");
    return runtimeState ?? { states: {} };
  }
  async function save(store) {
    await chrome.storage.session.set({ runtimeState: store });
  }
  async function enabled() {
    return (await chrome.storage.local.get("enabled")).enabled !== false;
  }
  var fresh = () => ({ count: 0, phase: "waiting", message: "\u7B49\u5F85\u6D4F\u89C8\u5668\u586B\u597D\u5B66\u53F7\u548C\u5BC6\u7801", updated: Date.now() });
  var creating;
  async function ensureOffscreen() {
    if (await chrome.offscreen.hasDocument()) return;
    creating ??= chrome.offscreen.createDocument({ url: "offscreen.html", reasons: [chrome.offscreen.Reason.WORKERS], justification: "\u5728\u672C\u673A\u8FD0\u884C\u9A8C\u8BC1\u7801 OCR Worker\uFF0C\u4E0D\u5411\u5916\u90E8\u53D1\u9001\u56FE\u7247" }).finally(() => {
      creating = void 0;
    });
    await creating;
  }
  async function handle(message, sender) {
    if (message.target === "offscreen") return void 0;
    const ownPage = sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("popup.html");
    const tab = sender.tab?.id;
    const page = tab !== void 0 && sender.frameId === 0 && isLoginUrl(sender.url ?? "");
    if (!ownPage && !page) throw new Error("\u4E0D\u652F\u6301\u7684\u9875\u9762");
    if (message.type === "ui.status" && ownPage) {
      const current = await chrome.tabs.query({ active: true, currentWindow: true });
      const store = await load();
      let supported = false;
      if (current[0]?.id !== void 0) {
        try {
          supported = (await chrome.tabs.sendMessage(current[0].id, { type: "page.ping" }))?.supported === true;
        } catch {
        }
      }
      return { enabled: await enabled(), supported, state: supported ? store.states[String(current[0].id)] ?? fresh() : null };
    }
    if (message.type === "ui.enable" && ownPage) {
      await chrome.storage.local.set({ enabled: message.enabled === true });
      if (!message.enabled) await exclusive(async () => {
        const store = await load();
        for (const [tab2, state] of Object.entries(store.states)) {
          cancelActivation(Number(tab2));
          if (state.phase !== "done") {
            state.phase = "stopped";
            state.message = "\u5DF2\u6682\u505C\uFF0C\u53EF\u624B\u52A8\u767B\u5F55";
            delete state.token;
          }
        }
        delete store.owner;
        await save(store);
      });
      return { ok: true };
    }
    if (message.type === "ui.retry" && ownPage) {
      if (!await enabled()) throw new Error("\u8BF7\u5148\u542F\u7528\u9A8C\u8BC1\u7801\u52A9\u624B");
      const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (current?.id === void 0) throw new Error("\u8BF7\u5148\u6253\u5F00\u5BC6\u7801\u767B\u5F55\u9875");
      const pong = await chrome.tabs.sendMessage(current.id, { type: "page.ping" });
      if (!pong?.supported) throw new Error("\u8BF7\u5148\u6253\u5F00\u5BC6\u7801\u767B\u5F55\u9875");
      await exclusive(async () => {
        const store = await load();
        if (store.owner && store.owner.tab !== current.id && store.owner.expires > Date.now()) throw new Error("\u53E6\u4E00\u4E2A\u767B\u5F55\u9875\u6B63\u5728\u5904\u7406\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
        delete store.owner;
        const old = store.states[String(current.id)];
        store.states[String(current.id)] = { ...fresh(), documentId: old?.documentId, activationDocumentId: old?.activationDocumentId };
        cancelActivation(current.id);
        await save(store);
      });
      await chrome.tabs.sendMessage(current.id, { type: "page.retry" });
      return { ok: true };
    }
    if (!page || tab === void 0) throw new Error("\u6D88\u606F\u6765\u6E90\u65E0\u6548");
    const key = String(tab), documentId = sender.documentId;
    if (message.type === "autofill.activate") {
      if (!documentId) throw new Error("\u65E0\u6CD5\u786E\u8BA4\u767B\u5F55\u9875\u9762\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5");
      const token = await exclusive(async () => {
        const store = await load(), state = store.states[key];
        if (!await enabled() || !state || state.documentId !== documentId || state.phase !== "waiting") throw new Error("\u81EA\u52A8\u586B\u5145\u4EFB\u52A1\u5DF2\u5931\u6548");
        if (state.activationDocumentId === documentId) throw new Error("\u672C\u9875\u5DF2\u5C1D\u8BD5\u6FC0\u6D3B\u81EA\u52A8\u586B\u5145\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\u540E\u91CD\u8BD5");
        if (store.owner && store.owner.expires > Date.now()) throw new Error("\u53E6\u4E00\u4E2A\u767B\u5F55\u9875\u6B63\u5728\u5904\u7406\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
        const token2 = crypto.randomUUID();
        state.activationDocumentId = documentId;
        state.phase = "activating";
        state.token = token2;
        state.message = "\u6B63\u5728\u786E\u8BA4\u6D4F\u89C8\u5668\u81EA\u52A8\u586B\u5145";
        state.updated = Date.now();
        store.owner = { tab, token: token2, expires: Date.now() + 7e3 };
        await save(store);
        return token2;
      });
      const valid = () => exclusive(async () => {
        const store = await load(), state = store.states[key];
        return await enabled() && state?.documentId === documentId && state.phase === "activating" && state.token === token && store.owner?.tab === tab && store.owner.token === token && store.owner.expires > Date.now();
      });
      try {
        await activateAutofill(tab, documentId, token, valid);
        return await exclusive(async () => {
          const store = await load(), state = store.states[key];
          if (!await enabled() || state?.documentId !== documentId || state.phase !== "activating" || state.token !== token) throw new Error("\u81EA\u52A8\u586B\u5145\u6FC0\u6D3B\u5DF2\u53D6\u6D88");
          state.phase = "waiting";
          state.message = "\u7B49\u5F85\u6D4F\u89C8\u5668\u786E\u8BA4\u8D26\u53F7\u5BC6\u7801";
          delete state.token;
          if (store.owner?.token === token) delete store.owner;
          await save(store);
          return { ok: true };
        });
      } catch (error) {
        await exclusive(async () => {
          const store = await load(), state = store.states[key];
          if (state?.documentId === documentId && state.token === token) {
            state.phase = "stopped";
            state.message = error instanceof Error ? error.message : "\u81EA\u52A8\u586B\u5145\u6FC0\u6D3B\u5931\u8D25\uFF0C\u8BF7\u5237\u65B0\u9875\u9762";
            delete state.token;
            if (store.owner?.token === token) delete store.owner;
            await save(store);
          }
        });
        throw error;
      }
    }
    if (message.type === "ocr") {
      const valid = await exclusive(async () => {
        const store = await load();
        return await enabled() && store.owner?.tab === tab && store.owner.token === message.token && store.states[key]?.documentId === documentId && store.states[key]?.phase === "recognizing";
      });
      if (!valid) throw new Error("\u4EFB\u52A1\u5DF2\u53D6\u6D88");
      if (typeof message.image !== "string" || message.image.length > 14e5 || !/^[A-Za-z0-9+/=]+$/.test(message.image)) throw new Error("\u9A8C\u8BC1\u7801\u6570\u636E\u5F02\u5E38");
      await ensureOffscreen();
      return await chrome.runtime.sendMessage({ target: "offscreen", type: "ocr", image: message.image, token: message.token });
    }
    return exclusive(async () => {
      const store = await load();
      let state = store.states[key] ?? fresh();
      store.states[key] = state;
      if (message.type === "page.init") {
        if (store.owner && (store.owner.tab !== tab || state.documentId !== documentId)) {
          const old = store.states[String(store.owner.tab)];
          if (old && (old.phase === "recognizing" || old.phase === "activating")) {
            old.phase = "stopped";
            old.message = "\u53E6\u4E00\u4E2A\u767B\u5F55\u9875\u5DF2\u52A0\u8F7D\uFF0C\u8BF7\u91CD\u65B0\u5C1D\u8BD5";
            delete old.token;
          }
          cancelActivation(store.owner.tab);
          delete store.owner;
        }
        if (state.phase === "done" || state.documentId !== documentId && state.count === 0) state = store.states[key] = fresh();
        if ((state.phase === "recognizing" || state.phase === "activating") && state.documentId !== documentId) {
          state.phase = "stopped";
          state.message = "\u9875\u9762\u5DF2\u5237\u65B0\uFF0C\u8BF7\u91CD\u65B0\u5C1D\u8BD5";
          delete state.token;
        }
        if (message.error === "other") {
          state.phase = "stopped";
          state.message = "\u7F51\u7AD9\u63D0\u793A\u767B\u5F55\u5F02\u5E38\uFF0C\u8BF7\u68C0\u67E5\u9875\u9762\u63D0\u793A\u540E\u624B\u52A8\u5904\u7406";
        } else if (state.phase === "submitted") {
          if (store.owner?.tab === tab) delete store.owner;
          delete state.token;
          if (message.error === "captcha" && state.count < MAX_ATTEMPTS) {
            state.phase = "waiting";
            state.message = "\u9A8C\u8BC1\u7801\u9519\u8BEF\uFF0C\u51C6\u5907\u91CD\u8BD5";
          } else {
            state.phase = "stopped";
            state.message = message.error === "captcha" ? "\u5DF2\u5C1D\u8BD5 3 \u6B21\uFF0C\u8BF7\u624B\u52A8\u586B\u5199\u6216\u91CD\u65B0\u5C1D\u8BD5" : "\u4E0A\u6B21\u767B\u5F55\u7ED3\u679C\u672A\u786E\u8BA4\uFF0C\u8BF7\u68C0\u67E5\u9875\u9762\u540E\u91CD\u65B0\u5C1D\u8BD5";
          }
        } else if (message.error === "captcha" && state.count === 0) {
          state.phase = "stopped";
          state.message = "\u9875\u9762\u5DF2\u6709\u767B\u5F55\u9519\u8BEF\uFF0C\u8BF7\u786E\u8BA4\u540E\u91CD\u65B0\u5C1D\u8BD5";
        }
        state.documentId = documentId;
        state.updated = Date.now();
        await save(store);
        return { enabled: await enabled(), state };
      }
      if (message.type === "attempt.begin") {
        if (!await enabled()) return { allowed: false, message: "\u9A8C\u8BC1\u7801\u52A9\u624B\u5DF2\u6682\u505C" };
        if (state.phase !== "waiting" || state.count >= MAX_ATTEMPTS) return { allowed: false, message: state.message };
        if (store.owner && store.owner.expires > Date.now()) return { allowed: false, busy: true, message: "\u53E6\u4E00\u4E2A\u767B\u5F55\u9875\u6B63\u5728\u5904\u7406" };
        const token = crypto.randomUUID();
        state = { count: state.count + 1, phase: "recognizing", message: `\u6B63\u5728\u672C\u5730\u8BC6\u522B\uFF0C\u7B2C ${state.count + 1}/3 \u6B21`, token, updated: Date.now(), documentId, activationDocumentId: state.activationDocumentId };
        store.states[key] = state;
        store.owner = { tab, token, expires: Date.now() + 6e4 };
        await save(store);
        return { allowed: true, token };
      }
      if (message.type === "attempt.check") return { valid: await enabled() && state.token === message.token && state.documentId === documentId && state.phase === "recognizing" && !!store.owner && store.owner.token === message.token && store.owner.expires > Date.now() };
      if (message.type === "attempt.submit") {
        if (!await enabled() || state.token !== message.token || state.documentId !== documentId || state.phase !== "recognizing" || !store.owner || store.owner.token !== message.token || store.owner.expires <= Date.now()) return { valid: false };
        state.phase = "submitted";
        state.message = "\u5DF2\u70B9\u51FB\u767B\u5F55\uFF0C\u7B49\u5F85\u7F51\u7AD9\u54CD\u5E94";
        state.updated = Date.now();
        store.owner.expires = Date.now() + 25e3;
        await save(store);
        return { valid: true };
      }
      if (message.type === "attempt.defer") {
        if (state.documentId !== documentId || state.token !== message.token || !["recognizing", "submitted"].includes(state.phase) || store.owner?.tab !== tab || store.owner.token !== message.token) return { ok: false };
        state.count = Math.max(0, state.count - 1);
        state.phase = "waiting";
        state.message = "\u7B49\u5F85\u8D26\u53F7\u5BC6\u7801\u7A33\u5B9A\u540E\u7EE7\u7EED";
        state.updated = Date.now();
        delete state.token;
        delete store.owner;
        await save(store);
        return { ok: true };
      }
      if (message.type === "attempt.reject" && state.token === message.token && state.phase === "recognizing") {
        delete store.owner;
        delete state.token;
        state.phase = state.count < MAX_ATTEMPTS ? "waiting" : "stopped";
        state.message = state.phase === "waiting" ? "\u8BC6\u522B\u4E0D\u786E\u5B9A\uFF0C\u51C6\u5907\u5237\u65B0\u9A8C\u8BC1\u7801" : "\u5DF2\u5C1D\u8BD5 3 \u6B21\uFF0C\u8BF7\u624B\u52A8\u586B\u5199\u6216\u91CD\u65B0\u5C1D\u8BD5";
        await save(store);
        return { retry: state.phase === "waiting" };
      }
      if (message.type === "page.stop" && state.documentId === documentId) {
        if (message.leaving && (state.phase === "submitted" || state.phase === "done")) return { ok: true };
        cancelActivation(tab);
        state.phase = "stopped";
        state.message = String(message.reason ?? "\u5DF2\u505C\u6B62\uFF0C\u8BF7\u624B\u52A8\u767B\u5F55").slice(0, 100);
        delete state.token;
        if (store.owner?.tab === tab) delete store.owner;
        await save(store);
        return { ok: true };
      }
      return { ok: false };
    });
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.target === "offscreen") return false;
    handle(message, sender).then(respond, (error) => respond({ error: error instanceof Error ? error.message : "\u6269\u5C55\u8FD0\u884C\u5F02\u5E38" }));
    return true;
  });
  chrome.tabs.onRemoved.addListener((tab) => {
    cancelActivation(tab);
    void exclusive(async () => {
      const store = await load();
      delete store.states[String(tab)];
      if (store.owner?.tab === tab) delete store.owner;
      await save(store);
    });
  });
  chrome.tabs.onUpdated.addListener((tab, change) => {
    if (change.status === "loading" || change.url) cancelActivation(tab);
    if (!change.url || isLoginUrl(change.url)) return;
    void exclusive(async () => {
      const store = await load(), state = store.states[String(tab)];
      if (state) {
        state.phase = "done";
        state.message = "\u5DF2\u79BB\u5F00\u767B\u5F55\u9875";
        delete state.token;
      }
      if (store.owner?.tab === tab) delete store.owner;
      await save(store);
    });
  });
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId !== void 0) debuggerDetached(source.tabId);
  });
})();
