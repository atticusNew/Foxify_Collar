const DEFAULTS = { baseUrl: "https://atticus-event-shadow.onrender.com", lockKey: "", defaultContracts: 20, showHedge: "no" };
const el = (id) => document.getElementById(id);

chrome.storage.local.get(DEFAULTS, (v) => {
  const s = { ...DEFAULTS, ...(v || {}) };
  el("baseUrl").value = s.baseUrl;
  el("lockKey").value = s.lockKey;
  el("defaultContracts").value = String(s.defaultContracts);
  el("showHedge").value = s.showHedge;
});

el("save").addEventListener("click", () => {
  const n = Math.max(1, Math.min(10000, Math.round(Number(el("defaultContracts").value) || DEFAULTS.defaultContracts)));
  chrome.storage.local.set(
    {
      baseUrl: (el("baseUrl").value || DEFAULTS.baseUrl).trim().replace(/\/+$/, ""),
      lockKey: el("lockKey").value.trim(),
      defaultContracts: n,
      showHedge: el("showHedge").value === "yes" ? "yes" : "no",
    },
    () => {
      el("ok").textContent = "Saved. Reload the venue tab.";
      setTimeout(() => (el("ok").textContent = ""), 2500);
    },
  );
});
