"use strict";
(() => {
  // src/autofill.ts
  function credentialState(username, password) {
    if (!username || !password) return "missing";
    const usernamePresent = username.value.trim().length > 0;
    const passwordPresent = password.value.length > 0;
    if (usernamePresent && passwordPresent) return "ready";
    const autofilled = (element) => {
      for (const selector of [":autofill", ":-webkit-autofill"]) {
        try {
          if (element.matches(selector)) return true;
        } catch {
        }
      }
      return false;
    };
    return (usernamePresent || autofilled(username)) && (passwordPresent || autofilled(password)) ? "preview" : "missing";
  }

  // src/protocol.ts
  var isLoginUrl = (url) => {
    try {
      const u = new URL(url);
      return u.origin === "https://pass.hust.edu.cn" && u.pathname === "/cas/login";
    } catch {
      return false;
    }
  };
  function errorKind(text) {
    const value = text.trim();
    if (!value) return null;
    if (/密码|账号|帐号|用户|学号|锁定|password|account|username|locked/i.test(value)) return "other";
    return /验证码.{0,12}(错误|不正确|失效|过期)|(?:captcha|verification code).{0,25}(invalid|incorrect|expired|wrong)|(?:invalid|incorrect|expired|wrong).{0,15}(?:captcha|verification code)/i.test(value) ? "captcha" : "other";
  }

  // src/content.ts
  if (isLoginUrl(location.href) && window === window.top) void main();
  async function main() {
    let enabled = true, stopped = false, busy = false, submitted = false;
    let epoch = 0, stableSince = 0, readyKey = "", ownBlob = "", ownCode = "";
    let errorRevision = 0, submittedRevision = 0;
    let activating = false, activationAttempted = false, activationGeneration = 0, activationToken = "";
    let credentialRevision = 0;
    const credentials = () => credentialState(input("un"), input("pd"));
    let abort;
    let submitTimer;
    const send = async (message) => {
      const result = await chrome.runtime.sendMessage(message);
      if (result?.error) throw new Error(result.error);
      return result;
    };
    const input = (id) => document.getElementById(id);
    const image = () => document.getElementById("codeImage");
    const button = () => document.getElementById("index_login_btn");
    function visible(element) {
      if (!element || !element.getClientRects().length) return false;
      const css = getComputedStyle(element);
      return css.visibility !== "hidden" && css.display !== "none";
    }
    const errorText = () => [
      document.getElementById("errormsghide")?.textContent ?? "",
      visible(document.getElementById("errormsg")) ? document.getElementById("errormsg")?.textContent ?? "" : ""
    ].join(" ").trim();
    function status(message) {
      let node = document.getElementById("hust-pass-status");
      if (!node && button()) {
        node = document.createElement("div");
        node.id = "hust-pass-status";
        node.setAttribute("role", "status");
        node.style.cssText = "font:12px/1.5 system-ui,sans-serif;color:#595752;margin:8px 0;overflow-wrap:anywhere";
        button().insertAdjacentElement("afterend", node);
      }
      if (node && node.textContent !== message) node.textContent = message;
    }
    function invalidate() {
      epoch++;
      abort?.abort();
      abort = void 0;
      stableSince = 0;
      readyKey = "";
    }
    function stop(reason, leaving = false) {
      stopped = true;
      invalidate();
      if (submitTimer) clearTimeout(submitTimer);
      if (!leaving) status(reason);
      void send({ type: "page.stop", reason, leaving }).catch(() => {
      });
    }
    function pageReady() {
      return enabled && !stopped && !submitted && document.visibilityState === "visible" && visible(input("pd")) && visible(input("un")) && visible(input("code")) && visible(image()) && visible(button()) && !button()?.disabled && !input("pd")?.disabled && !input("un")?.disabled && !input("code")?.disabled && !input("code")?.readOnly;
    }
    function sampleCredentials() {
      const state = credentials();
      const key = state === "missing" ? "" : state === "preview" ? "autofill-preview" : `${input("un").value.trim().length}:${input("pd").value.length}`;
      if (key !== readyKey) {
        credentialRevision++;
        readyKey = key;
        stableSince = key ? Date.now() : 0;
      } else if (key && !stableSince) stableSince = Date.now();
      return state;
    }
    function credentialsStable() {
      return sampleCredentials() === "ready" && stableSince > 0 && Date.now() - stableSince >= 310;
    }
    async function confirmAutofill() {
      if (activationAttempted) {
        stop("\u6D4F\u89C8\u5668\u5C1A\u672A\u63D0\u4F9B\u81EA\u52A8\u586B\u5145\u503C\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\u540E\u91CD\u8BD5");
        return;
      }
      activating = true;
      activationAttempted = true;
      activationGeneration = epoch;
      activationToken = "";
      const generation = epoch, revision = credentialRevision;
      status("\u6B63\u5728\u786E\u8BA4\u6D4F\u89C8\u5668\u81EA\u52A8\u586B\u5145\u2026");
      try {
        await send({ type: "autofill.activate" });
        const deadline = Date.now() + 5e3;
        while (generation === epoch && pageReady() && credentials() !== "ready" && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (generation !== epoch || stopped) return;
        if (!pageReady()) {
          stop("\u767B\u5F55\u9875\u72B6\u6001\u5DF2\u6539\u53D8\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5");
          return;
        }
        if (credentials() !== "ready") {
          if (credentialRevision !== revision) {
            status("\u7B49\u5F85\u8D26\u53F7\u5BC6\u7801\u586B\u5199\u5B8C\u6210\u5E76\u7A33\u5B9A\u540E\u7EE7\u7EED");
            return;
          }
          stop("\u6D4F\u89C8\u5668\u5C1A\u672A\u63D0\u4F9B\u81EA\u52A8\u586B\u5145\u503C\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\u540E\u91CD\u8BD5");
          return;
        }
        status("\u8D26\u53F7\u5BC6\u7801\u5DF2\u5C31\u7EEA\uFF0C\u51C6\u5907\u8BC6\u522B\u9A8C\u8BC1\u7801\u2026");
      } catch (error) {
        if (generation === epoch) stop(error instanceof Error ? error.message : "\u6D4F\u89C8\u5668\u81EA\u52A8\u586B\u5145\u6FC0\u6D3B\u5931\u8D25\uFF0C\u8BF7\u5237\u65B0\u9875\u9762");
      } finally {
        activating = false;
        stableSince = 0;
        readyKey = "";
      }
    }
    function unchanged(generation, img) {
      return generation === epoch && pageReady() && image() === img && img.src === ownBlob && (!input("code")?.value || input("code")?.value === ownCode);
    }
    async function run() {
      busy = true;
      const generation = epoch, img = image(), revision = credentialRevision;
      let token;
      const deferIfEdited = async () => {
        if (generation !== epoch || stopped || submitted) return true;
        const stable = credentialsStable();
        if (credentialRevision === revision && stable) return false;
        const result = await send({ type: "attempt.defer", token });
        if (generation === epoch && !stopped && !submitted) {
          if (result.ok) status("\u7B49\u5F85\u8D26\u53F7\u5BC6\u7801\u7A33\u5B9A\u540E\u7EE7\u7EED");
          else stop("\u9A8C\u8BC1\u7801\u4EFB\u52A1\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u5C1D\u8BD5");
        }
        return true;
      };
      try {
        const start = await send({ type: "attempt.begin" });
        if (!start.allowed) {
          if (!start.busy) stopped = true;
          status(start.message);
          return;
        }
        token = start.token;
        if (generation !== epoch || !pageReady()) {
          stop("\u9875\u9762\u72B6\u6001\u5DF2\u6539\u53D8\uFF0C\u8BF7\u91CD\u65B0\u5C1D\u8BD5");
          return;
        }
        if (await deferIfEdited()) return;
        status("\u6B63\u5728\u672C\u5730\u8BC6\u522B\u9A8C\u8BC1\u7801\u2026");
        abort = new AbortController();
        const timer = setTimeout(() => abort?.abort(), 1e4);
        let bytes;
        try {
          const response = await fetch(`/cas/code?hust_pass=${crypto.randomUUID()}`, { credentials: "same-origin", cache: "no-store", signal: abort.signal });
          if (!response.ok) throw new Error("\u9A8C\u8BC1\u7801\u52A0\u8F7D\u5931\u8D25\uFF0C\u8BF7\u624B\u52A8\u5237\u65B0");
          bytes = new Uint8Array(await response.arrayBuffer());
        } finally {
          clearTimeout(timer);
        }
        if (generation !== epoch || !pageReady()) return;
        if (!["GIF87a", "GIF89a"].includes(new TextDecoder().decode(bytes.slice(0, 6))) || bytes.length > 1e6) throw new Error("\u9A8C\u8BC1\u7801\u683C\u5F0F\u5DF2\u6539\u53D8\uFF0C\u8BF7\u624B\u52A8\u586B\u5199");
        const previous = ownBlob;
        ownBlob = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "image/gif" }));
        img.src = ownBlob;
        if (previous) URL.revokeObjectURL(previous);
        if (await deferIfEdited()) return;
        const base64 = btoa(Array.from(bytes, (c) => String.fromCharCode(c)).join(""));
        let timeout;
        const result = await Promise.race([
          send({ type: "ocr", token, image: base64 }),
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error("\u8BC6\u522B\u8D85\u65F6\uFF0C\u8BF7\u91CD\u65B0\u5C1D\u8BD5")), 3e4);
          })
        ]).finally(() => clearTimeout(timeout));
        if (!unchanged(generation, img) || result.token !== token) return;
        if (await deferIfEdited()) return;
        const check = await send({ type: "attempt.check", token });
        if (!check.valid || !unchanged(generation, img)) {
          stop("\u9A8C\u8BC1\u7801\u4EFB\u52A1\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u5C1D\u8BD5");
          return;
        }
        if (!result.code || !/^\d{4}$/.test(result.code)) {
          const rejected = await send({ type: "attempt.reject", token });
          if (!rejected.retry) stop("\u5DF2\u5C1D\u8BD5 3 \u6B21\uFF0C\u8BF7\u624B\u52A8\u586B\u5199\u6216\u91CD\u65B0\u5C1D\u8BD5");
          else {
            status("\u8BC6\u522B\u4E0D\u786E\u5B9A\uFF0C\u6B63\u5728\u51C6\u5907\u91CD\u8BD5\u2026");
            stableSince = Date.now();
          }
          return;
        }
        if (await deferIfEdited()) return;
        if (errorKind(errorText()) === "other") {
          stop("\u7F51\u7AD9\u63D0\u793A\u767B\u5F55\u5F02\u5E38\uFF0C\u8BF7\u68C0\u67E5\u9875\u9762\u63D0\u793A");
          return;
        }
        const permission = await send({ type: "attempt.submit", token });
        if (!permission.valid || !unchanged(generation, img)) {
          stop("\u9875\u9762\u72B6\u6001\u5DF2\u6539\u53D8\uFF0C\u8BF7\u91CD\u65B0\u5C1D\u8BD5");
          return;
        }
        if (await deferIfEdited()) return;
        ownCode = result.code;
        input("code").value = ownCode;
        input("code").dispatchEvent(new Event("input", { bubbles: true }));
        input("code").dispatchEvent(new Event("change", { bubbles: true }));
        submitted = true;
        submittedRevision = errorRevision;
        status("\u9A8C\u8BC1\u7801\u5DF2\u586B\u5199\uFF0C\u6B63\u5728\u767B\u5F55\u2026");
        button().click();
        submitTimer = setTimeout(() => stop("\u767B\u5F55\u54CD\u5E94\u8D85\u65F6\uFF0C\u8BF7\u68C0\u67E5\u9875\u9762\u540E\u624B\u52A8\u5904\u7406"), 2e4);
      } catch (error) {
        if (generation === epoch) stop(error instanceof Error && error.name !== "AbortError" ? error.message : "\u9A8C\u8BC1\u7801\u8BF7\u6C42\u8D85\u65F6\uFF0C\u8BF7\u624B\u52A8\u5237\u65B0");
      } finally {
        busy = false;
      }
    }
    chrome.runtime.onMessage.addListener((message, _sender, respond) => {
      if (message.type === "page.activationPoint") {
        const field = input("code");
        if (!activating || activationGeneration !== epoch || !pageReady() || !field || field.value || activationToken && activationToken !== message.token) {
          respond({ valid: false });
          return false;
        }
        activationToken = message.token;
        const rect = field.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
        respond({
          valid: rect.width > 0 && rect.height > 0 && document.elementFromPoint(x, y) === field,
          url: location.href,
          x,
          y,
          width: innerWidth,
          height: innerHeight
        });
        return false;
      }
      if (message.type === "page.ping") {
        respond({ supported: true });
        return false;
      }
      if (message.type === "page.retry") {
        invalidate();
        stopped = false;
        submitted = false;
        if (submitTimer) clearTimeout(submitTimer);
        if (input("code")?.value === ownCode) input("code").value = "";
        ownCode = "";
        status("\u7B49\u5F85\u6D4F\u89C8\u5668\u586B\u597D\u5B66\u53F7\u548C\u5BC6\u7801");
        respond({ ok: true });
      }
      return false;
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.enabled) {
        enabled = changes.enabled.newValue !== false;
        if (!enabled) stop("\u9A8C\u8BC1\u7801\u52A9\u624B\u5DF2\u6682\u505C\uFF0C\u53EF\u624B\u52A8\u767B\u5F55");
        else status("\u9A8C\u8BC1\u7801\u52A9\u624B\u5DF2\u542F\u7528\uFF0C\u70B9\u51FB\u6269\u5C55\u4E2D\u7684\u201C\u91CD\u65B0\u5C1D\u8BD5\u201D\u5F00\u59CB");
      }
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible" && (busy || activating) && !submitted) stop("\u9875\u9762\u5DF2\u5207\u6362\u5230\u540E\u53F0\uFF0C\u8BF7\u91CD\u65B0\u5C1D\u8BD5");
      stableSince = 0;
    });
    window.addEventListener("pagehide", () => {
      stop("\u5DF2\u79BB\u5F00\u767B\u5F55\u9875", true);
      if (ownBlob) URL.revokeObjectURL(ownBlob);
    });
    document.addEventListener("input", (e) => {
      if (!e.isTrusted) return;
      const id = e.target?.id;
      if (id === "code") {
        ownCode = "";
        stop("\u5DF2\u5207\u6362\u4E3A\u624B\u52A8\u586B\u5199");
      }
      if (id === "un" || id === "pd") {
        credentialRevision++;
        stableSince = 0;
      }
    }, true);
    document.addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      const target = e.target;
      if (target.closest("#index_login_btn")) stop("\u5DF2\u7531\u4F60\u624B\u52A8\u63D0\u4EA4\u767B\u5F55");
      else if (target.closest("#codeImage,.code-box")) stop("\u9A8C\u8BC1\u7801\u5DF2\u624B\u52A8\u5237\u65B0\uFF0C\u8BF7\u624B\u52A8\u586B\u5199\u6216\u91CD\u65B0\u5C1D\u8BD5");
      else if (target.closest(".switch-login")) stop("\u767B\u5F55\u65B9\u5F0F\u5DF2\u5207\u6362\uFF0C\u8BF7\u91CD\u65B0\u5C1D\u8BD5");
    }, true);
    document.addEventListener("keydown", (e) => {
      if (e.isTrusted && e.key === "Enter" && ["un", "pd", "code"].includes(e.target?.id)) stop("\u5DF2\u7531\u4F60\u624B\u52A8\u63D0\u4EA4\u767B\u5F55");
    }, true);
    if (document.readyState === "loading") await new Promise((resolve) => document.addEventListener("DOMContentLoaded", () => resolve(), { once: true }));
    try {
      const init = await send({ type: "page.init", error: errorKind(errorText()) });
      enabled = init.enabled;
      stopped = init.state.phase === "stopped";
      activationAttempted = !!init.state.activationDocumentId && init.state.activationDocumentId === init.state.documentId;
      status(enabled ? init.state.message : "\u9A8C\u8BC1\u7801\u52A9\u624B\u5DF2\u6682\u505C\uFF0C\u53EF\u624B\u52A8\u767B\u5F55");
    } catch {
      stop("\u6269\u5C55\u8FDE\u63A5\u5931\u8D25\uFF0C\u8BF7\u5237\u65B0\u9875\u9762");
      return;
    }
    const observer = new MutationObserver((records) => {
      if (records.some((r) => (r.target instanceof Element ? r.target : r.target.parentElement)?.closest("#errormsg,#errormsghide"))) errorRevision++;
      if (busy && !submitted && records.some((r) => r.target === image() && r.attributeName === "src") && image()?.src !== ownBlob) stop("\u9A8C\u8BC1\u7801\u5DF2\u6539\u53D8\uFF0C\u8BF7\u91CD\u65B0\u5C1D\u8BD5");
    });
    observer.observe(document.documentElement, { attributes: true, subtree: true, childList: true, characterData: true, attributeFilter: ["src", "style", "class"] });
    setInterval(() => {
      if (!enabled || stopped) return;
      if (visible(document.getElementById("phoneCode"))) {
        stop("\u9700\u8981\u989D\u5916\u8BA4\u8BC1\uFF0C\u8BF7\u6309\u9875\u9762\u63D0\u793A\u5B8C\u6210");
        return;
      }
      const error = errorKind(errorText());
      if (error === "other") {
        stop("\u7F51\u7AD9\u63D0\u793A\u767B\u5F55\u5F02\u5E38\uFF0C\u8BF7\u68C0\u67E5\u9875\u9762\u63D0\u793A\u540E\u624B\u52A8\u5904\u7406");
        return;
      }
      if (submitted) {
        if (error === "captcha" && errorRevision > submittedRevision) {
          submitted = false;
          if (submitTimer) clearTimeout(submitTimer);
          busy = true;
          void send({ type: "page.init", error }).then((init) => {
            stopped = init.state.phase === "stopped";
            if (input("code")?.value === ownCode) input("code").value = "";
            ownCode = "";
            status(init.state.message);
          }).catch(() => stop("\u6269\u5C55\u8FDE\u63A5\u5931\u8D25\uFF0C\u8BF7\u5237\u65B0\u9875\u9762")).finally(() => {
            busy = false;
          });
        } else if (visible(document.getElementById("phoneCode"))) stop("\u9700\u8981\u989D\u5916\u8BA4\u8BC1\uFF0C\u8BF7\u6309\u9875\u9762\u63D0\u793A\u5B8C\u6210");
        return;
      }
      if (activating) {
        if (!pageReady()) stop("\u767B\u5F55\u9875\u72B6\u6001\u5DF2\u6539\u53D8\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5");
        return;
      }
      const state = sampleCredentials();
      if (busy) {
        if (!pageReady()) stop("\u767B\u5F55\u9875\u9762\u72B6\u6001\u5DF2\u6539\u53D8\uFF0C\u8BF7\u91CD\u65B0\u5C1D\u8BD5");
        return;
      }
      if (!pageReady() || state === "missing") {
        stableSince = 0;
        return;
      }
      if (input("code").value && input("code").value !== ownCode) {
        stop("\u5DF2\u6709\u624B\u52A8\u9A8C\u8BC1\u7801\uFF0C\u8BF7\u624B\u52A8\u767B\u5F55");
        return;
      }
      if (!image().complete || !image().naturalWidth) return;
      if (Date.now() - stableSince >= 310) {
        if (state === "preview") void confirmAutofill();
        else void run();
      }
    }, 100);
  }
})();
