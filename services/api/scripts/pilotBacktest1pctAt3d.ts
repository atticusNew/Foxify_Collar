const RF = 0.05;
function nCDF(x: number) { const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911; const s=x<0?-1:1; x=Math.abs(x)/Math.sqrt(2); const t=1/(1+p*x); return 0.5*(1+s*(1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x))); }
function bsPut(S: number,K: number,T: number,r: number,v: number) { if(T<=0||v<=0||S<=0||K<=0) return Math.max(0,K-S); const d1=(Math.log(S/K)+(r+v*v/2)*T)/(v*Math.sqrt(T)); const d2=d1-v*Math.sqrt(T); return K*Math.exp(-r*T)*nCDF(-d2)-S*nCDF(-d1); }
function rVol(prices: number[],w: number) { if(prices.length<w+1) return 0.5; const r: number[]=[]; for(let i=Math.max(0,prices.length-w-1);i<prices.length-1;i++){if(prices[i]>0&&prices[i+1]>0) r.push(Math.log(prices[i+1]/prices[i]));} if(r.length<5) return 0.5; const m=r.reduce((s,v)=>s+v,0)/r.length; const v=r.reduce((s,v)=>s+(v-m)**2,0)/(r.length-1); return Math.sqrt(v*365); }

async function fetchPrices(start: string,end: string) {
  const all=new Map<string,{price:number;low:number}>();
  let cur=new Date(start).getTime(); const eMs=new Date(end).getTime();
  while(cur<eMs){const ce=Math.min(cur+300*86400000,eMs);
    const url=`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400&start=${new Date(cur).toISOString()}&end=${new Date(ce).toISOString()}`;
    let ret=3; while(ret-->0){try{const res=await fetch(url); if(res.status===429){await new Promise(r=>setTimeout(r,3000));continue;} if(!res.ok) throw new Error(`${res.status}`); const c=await res.json() as number[][]; for(const[ts,lo,,,cl] of c) all.set(new Date(ts*1000).toISOString().slice(0,10),{price:cl,low:lo}); break;}catch(e:any){if(ret<=0) throw e; await new Promise(r=>setTimeout(r,2000));}} cur=ce; await new Promise(r=>setTimeout(r,500));}
  return Array.from(all.entries()).map(([d,v])=>({date:d,...v})).sort((a,b)=>a.date.localeCompare(b.date));
}

async function main() {
  const prices = await fetchPrices("2022-01-01","2026-04-07");
  const pv = prices.map(p=>p.price);
  const NOTIONAL=10000, sl=1;
  const vols = [0.44, 0.65, 0.85];

  console.log("1% SL — TENOR COMPARISON (1d, 2d, 3d) with Take-Profit\n");

  for (const tenor of [1, 2, 3]) {
    console.log(`  === ${tenor}-DAY TENOR ===`);
    for (const vm of vols) {
      let n=0,trigs=0,totalH=0,totalPay=0,totalRecov=0,totalTp=0;
      for(let i=0;i+tenor<prices.length;i++){
        const entry=prices[i].price; if(entry<=0) continue; n++;
        const trigger=entry*(1-sl/100), qty=NOTIONAL/entry;
        const vol=rVol(pv.slice(0,i+1),30)*vm;
        const hedge=bsPut(entry,trigger,tenor/365,RF,vol)*qty;
        totalH+=hedge;
        const window=prices.slice(i,i+tenor+1);
        const minLow=Math.min(...window.map(w=>w.low));
        const triggered=minLow<=trigger;
        if(triggered){
          trigs++;
          totalPay+=NOTIONAL*(sl/100);
          const ep=prices[i+tenor]?.price||entry;
          const recov=Math.max(0,trigger-ep)*qty;
          totalRecov+=recov;
          let td=0; for(let d=0;d<window.length;d++){if(window[d].low<=trigger){td=d;break;}}
          let deep=trigger; for(let d=td;d<Math.min(td+3,window.length);d++){if(window[d].low<deep) deep=window[d].low;}
          totalTp+=Math.max(recov,Math.max(0,trigger-deep)*qty);
        }
      }
      const trigRate=trigs/n;
      const h1k=totalH/n/10, p1k=totalPay/n/10, r1k=totalRecov/n/10, tp1k=totalTp/n/10;
      const beTp=h1k+p1k-tp1k;
      const tpPct=totalPay>0?(totalTp/totalPay*100).toFixed(0):"0";
      const payout=NOTIONAL*(sl/100);
      let lo=0,hi=20; while(hi-lo>0.05){const mid=(lo+hi)/2; if(mid>=beTp) hi=mid; else lo=mid;}
      const minP=Math.ceil(hi*20)/20;
      const weekly=minP*10*(7/tenor);
      const viable=payout>minP*10?"YES":"NO (premium > payout)";

      console.log(`    Vol x${vm}: Trig ${(trigRate*100).toFixed(0)}% | Hedge $${h1k.toFixed(2)}/1k | TP Recov ${tpPct}% | BE+TP $${beTp.toFixed(2)}/1k | MinPrem $${minP.toFixed(2)}/1k | $${(minP*10).toFixed(0)}/10k/period | $${weekly.toFixed(0)}/wk | Viable: ${viable}`);
    }
    console.log();
  }

  // Also run treasury sim at 3d with suggested premium
  console.log("\n  === TREASURY SIM: 1% SL @ 3-day, $2/1k premium, $100k treasury, 10/day ===\n");
  for (const vm of vols) {
    let treasury=100000, minT=treasury, n=0;
    const pending: {day:number;amt:number}[] = [];
    for(let i=0;i+3<prices.length;i++){
      const entry=prices[i].price; if(entry<=0) continue; n++;
      while(pending.length>0&&pending[0].day<=i){treasury+=pending[0].amt;pending.shift();}
      for(let p=0;p<10;p++){
        const trigger=entry*(1-1/100), qty=NOTIONAL/entry;
        const vol=rVol(pv.slice(0,i+1),30)*vm;
        const hedge=bsPut(entry,trigger,3/365,RF,vol)*qty;
        treasury+=20-hedge; // $2/1k * 10 = $20
        const window=prices.slice(i,i+3+1);
        const triggered=Math.min(...window.map(w=>w.low))<=trigger;
        if(triggered){
          treasury-=100; // payout
          let td=0; for(let d=0;d<window.length;d++){if(window[d].low<=trigger){td=d;break;}}
          let deep=trigger; for(let d=td;d<Math.min(td+3,window.length);d++){if(window[d].low<deep) deep=window[d].low;}
          const ep=prices[i+3]?.price||entry;
          const recov=Math.max(Math.max(0,trigger-ep)*qty, Math.max(0,trigger-deep)*qty);
          pending.push({day:i+Math.min(td+2,3), amt:recov});
        }
      }
      if(treasury<minT) minT=treasury;
    }
    while(pending.length>0){treasury+=pending[0].amt;pending.shift();}
    console.log(`    Vol x${vm}: End $${treasury.toFixed(0)} | Min $${minT.toFixed(0)} | Profit $${(treasury-100000).toFixed(0)}`);
  }
}

main().catch(e=>{console.error(e.message);process.exit(1);});
