import { load5MinBars, __getBarsCacheSource, __resetBarsCache } from "../backtest/singleSide/monteCarloEngine";
const main = async () => {
  __resetBarsCache();
  console.log("Fetching bars (no tmp file expected on this VM)...");
  const t0 = Date.now();
  const bars = await load5MinBars();
  const elapsed = Date.now() - t0;
  console.log(`Got ${bars.length} bars in ${elapsed}ms`);
  console.log(`Source: ${__getBarsCacheSource()}`);
  if (bars.length > 0) {
    console.log(`First bar: open=${bars[0].open} close=${bars[0].close}`);
    console.log(`Last bar:  open=${bars[bars.length-1].open} close=${bars[bars.length-1].close}`);
  }
};
main().catch((e) => { console.error(e); process.exit(1); });
