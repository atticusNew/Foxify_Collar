// Fetch proxy: content scripts run under the page's origin, so calls to the local demo service go
// through here (host_permissions grants the cross-origin fetch regardless of page CSP / CORS).
const BASE = "http://localhost:8788";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "atticus_fetch") return false;
  fetch(`${BASE}${msg.path}`, {
    method: msg.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: msg.body ? JSON.stringify(msg.body) : undefined
  })
    .then(async (r) => sendResponse({ ok: true, status: r.status, json: await r.json() }))
    .catch((e) => sendResponse({ ok: false, status: 0, error: String(e) }));
  return true; // async sendResponse
});
