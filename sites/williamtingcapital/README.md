# williamtingcapital.com

Static landing page for William Ting Capital. No build step, no framework, no backend: `index.html`, `styles.css`, `images/`, and a `vercel.json` for clean URLs and headers.

What changed from the old Lovable site: every figure (returns, client counts, years), the stats band, the Investor Login page and the "Platform" section, and the contact form are gone. The old `/investor-login` path redirects to `/`.

## Deploy to Vercel

1. In Vercel, **Add New > Project**, import the `Foxify_Collar` repository.
2. Set **Root Directory** to `sites/williamtingcapital`. Framework preset **Other**. Leave build command and output directory empty.
3. Deploy, then **Settings > Domains** and add `williamtingcapital.com` and `www.williamtingcapital.com`.

## Point DNS at Vercel (Porkbun)

In Porkbun DNS for the domain, remove the existing `A` / `CNAME` records that point at Lovable, then add:

| Type  | Host | Answer                 |
| ----- | ---- | ---------------------- |
| A     | `@`  | `76.76.21.21`          |
| CNAME | `www`| `cname.vercel-dns.com` |

Vercel shows the domain as verified once the records propagate and issues the TLS certificate automatically. The Lovable site stays live until the records change.

## Local preview

```
cd sites/williamtingcapital && python3 -m http.server 8993
```
