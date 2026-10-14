const DEFAULTS = { baseUrl: "https://atticus-event-shadow.onrender.com", lockKey: "", showHedge: "no", rehearse: "no" };
const el = (id) => document.getElementById(id);

chrome.storage.local.get(DEFAULTS, (v) => {
  const s = { ...DEFAULTS, ...(v || {}) };
  el("baseUrl").value = s.baseUrl;
  el("lockKey").value = s.lockKey;
  el("showHedge").value = s.showHedge;
  el("rehearse").value = s.rehearse;
});

el("save").addEventListener("click", () => {
  chrome.storage.local.set(
    {
      baseUrl: (el("baseUrl").value || DEFAULTS.baseUrl).trim().replace(/\/+$/, ""),
      lockKey: el("lockKey").value.trim(),
      showHedge: el("showHedge").value === "yes" ? "yes" : "no",
      rehearse: el("rehearse").value === "yes" ? "yes" : "no",
    },
    () => {
      el("ok").textContent = "Saved. Reload the venue tab.";
      setTimeout(() => (el("ok").textContent = ""), 2500);
    },
  );
});
