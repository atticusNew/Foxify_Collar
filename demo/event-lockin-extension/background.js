// Fetch proxy. Content scripts run under the venue page's origin, so calls to the Atticus event
// service go through here: host_permissions grants the cross-origin fetch regardless of the page's
// CSP or CORS. The lock key rides as a header from extension storage; the content script never
// sees it. No venue credential exists anywhere in this extension.

const DEFAULTS = { baseUrl: "https://atticus-event-shadow.onrender.com", lockKey: "" };

const settings = () =>
  new Promise((resolve) => chrome.storage.local.get(DEFAULTS, (v) => resolve({ ...DEFAULTS, ...(v || {}) })));

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "atticus_fetch") return false;
  settings().then(async (s) => {
    const base = String(s.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, "");
    const headers = { accept: "application/json" };
    if (s.lockKey) headers["x-lock-key"] = s.lockKey;
    if (msg.body !== undefined) headers["content-type"] = "application/json";
    try {
      const r = await fetch(`${base}${msg.path}`, {
        method: msg.method || "GET",
        headers,
        body: msg.body !== undefined ? JSON.stringify(msg.body) : undefined,
        cache: "no-store",
      });
      let json = null;
      try {
        json = await r.json();
      } catch {
        json = null;
      }
      sendResponse({ ok: true, status: r.status, json, configured: Boolean(s.lockKey) });
    } catch (e) {
      sendResponse({ ok: false, status: 0, error: String(e), configured: Boolean(s.lockKey) });
    }
  });
  return true; // async sendResponse
});
