const DEFAULTS = { baseUrl: "https://atticus-event-shadow.onrender.com", lockKey: "", showHedge: "no", rehearse: "no", showShield: "yes", showSlip: "yes", telemetry: "yes", layout: "simple" };
const el = (id) => document.getElementById(id);

chrome.storage.local.get(DEFAULTS, (v) => {
  const s = { ...DEFAULTS, ...(v || {}) };
  el("baseUrl").value = s.baseUrl;
  el("lockKey").value = s.lockKey;
  el("showHedge").value = s.showHedge;
  el("rehearse").value = s.rehearse;
  el("showShield").value = s.showShield;
  el("showSlip").value = s.showSlip;
  el("telemetry").value = s.telemetry;
  el("layout").value = s.layout === "full" ? "full" : "simple";
});

el("save").addEventListener("click", () => {
  chrome.storage.local.set(
    {
      baseUrl: (el("baseUrl").value || DEFAULTS.baseUrl).trim().replace(/\/+$/, ""),
      lockKey: el("lockKey").value.trim(),
      showHedge: el("showHedge").value === "yes" ? "yes" : "no",
      rehearse: el("rehearse").value === "yes" ? "yes" : "no",
      showShield: el("showShield").value === "no" ? "no" : "yes",
      showSlip: el("showSlip").value === "no" ? "no" : "yes",
      telemetry: el("telemetry").value === "no" ? "no" : "yes",
      layout: el("layout").value === "full" ? "full" : "simple",
    },
    () => {
      el("ok").textContent = "Saved. Reload the venue tab.";
      setTimeout(() => (el("ok").textContent = ""), 2500);
    },
  );
});
