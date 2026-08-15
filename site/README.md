# atticustrade.com landing page

Single self-contained static page (`index.html` + `atlogo.png` + `vercel.json`). No build step,
no dependencies. Messaging: Earn & Protect, one-tap collar protection embedded in trading venues.

## Deploying to Vercel at atticustrade.com

The domain currently points at the OLD site, which deploys from the old `atticus-btc-options`
repo (a site-builder export). Two ways to replace it; option A is cleanest.

### Option A: point the existing Vercel project at this repo (keeps the domain, zero DNS work)

1. Vercel dashboard → the project currently serving atticustrade.com → Settings → Git.
2. Disconnect the old `atticus-btc-options` repo; connect `atticusNew/Foxify_Collar`.
3. Settings → General:
   - Root Directory: `site`
   - Framework Preset: `Other`
   - Build Command: (empty) · Output Directory: (empty / `.`) · Install Command: (empty)
4. Set the Production Branch (Settings → Git) to the branch this folder lives on
   (`cursor/hl-toggle-demo-9151` until merged, then the production branch).
5. Deploy. The domain keeps working because the project (and its domain binding) never changed.

### Option B: new Vercel project, move the domain

1. Vercel → Add New → Project → import `atticusNew/Foxify_Collar`.
2. Same settings as above (Root Directory `site`, no build).
3. After the first deploy: Project → Settings → Domains → add `atticustrade.com` and
   `www.atticustrade.com`. Vercel will prompt to remove them from the old project; confirm.
4. Old project can then be deleted.

### Verify after deploy

- https://atticustrade.com loads the new page (dark, logo in nav, animated toggle).
- https://atticustrade.com/atlogo.png serves the logo (og:image + favicon depend on it).

## Before going live

- Replace the `SET CONTACT` mailto links in `index.html` with your real scheduler/Telegram/email.
- Optional: swap `og:image` for a frame from the demo video once it exists.

## Copy rules baked in

No em dashes. No APY claims, no fake logos or testimonials, no partner-implying language.
Refusal honesty stated as a feature. Risk disclaimer in the footer. Keep it that way.
