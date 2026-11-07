"use strict";
const toggle = document.querySelector("#toggle");
const status = document.querySelector("#status");
let enabled = false;
let supportedPage = false;
let busy = true;

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error("Extension request failed");
  return response.result;
}

function render() {
  toggle.classList.toggle("is-on", enabled);
  toggle.setAttribute("aria-pressed", String(enabled));
  toggle.setAttribute("aria-busy", String(busy));
  toggle.disabled = busy;
  status.dataset.state = enabled && supportedPage ? "on" : "off";
  status.textContent = !supportedPage ? "当前网页未生效" : enabled ? "当前网页已生效" : "当前网页未启用";
}

async function initialize() {
  const [state, tabs] = await Promise.all([
    request({ type: "status" }),
    chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [])
  ]);
  enabled = state.config.enabled;
  try {
    const page = new URL(tabs[0]?.url || "");
    supportedPage = !tabs[0]?.incognito && ["http:", "https:"].includes(page.protocol)
      && globalThis.SjtuCookiePolicy.inScope(page.hostname);
  } catch { supportedPage = false; }
  busy = false;
  render();
}

toggle.addEventListener("click", async () => {
  if (busy) return;
  const previous = enabled;
  enabled = !enabled;
  busy = true;
  render();
  try {
    const result = await request({ type: "configure", config: { enabled, retentionDays: 30 } });
    busy = false;
    render();
    if (result.failed > 0 && supportedPage) {
      status.dataset.state = "off";
      status.textContent = enabled ? "当前网页状态待确认" : "部分 Cookie 还原失败";
    }
  } catch {
    enabled = previous;
    busy = false;
    render();
    status.dataset.state = "off";
    status.textContent = "切换失败，请重试";
  }
});

void initialize().catch(() => {
  toggle.setAttribute("aria-busy", "false");
  status.textContent = "状态读取失败，请重新打开";
});
