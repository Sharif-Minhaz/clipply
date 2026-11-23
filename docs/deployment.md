# Deployment

All services below have free tiers that need **no credit card** (Vercel Hobby, MongoDB Atlas M0, Cloudinary Free, Google OAuth). Vercel Hobby is for non-commercial use.

## 1. MongoDB Atlas

1. Create an M0 cluster. Network access: allow `0.0.0.0/0` (Vercel has no fixed egress IPs on Hobby).
2. Create a database user with readWrite on `clipply`. Copy the `mongodb+srv://…` URI → `MONGODB_URI`.
3. Indexes are created by the API on first start.

## 2. Cloudinary

Sign up (Free plan) → Settings → API Keys → `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`. No upload preset is needed (uploads are signed by the API).

## 3. Google OAuth (Google Cloud Console → APIs & Services → Credentials)

- **Desktop app** OAuth client → used by the Electron app (system browser + loopback + PKCE).
- **Web application** OAuth client → its id is the `serverClientId` the Android app requests ID tokens for.
- **Android** OAuth client (package `co.lazycoders.clipply` + your signing SHA-1) → lets Credential Manager issue tokens.

`GOOGLE_CLIENT_IDS` = the desktop and web client ids, comma-separated (the audiences of ID tokens the API accepts).

## 4. Vercel

```sh
cd apps/server
cp .env.example .env        # fill in for local runs: npm run dev -w @clipply/server
npm run build               # writes .vercel/output (Build Output API v3)
npx vercel link             # once
npx vercel env add …        # every variable from .env.example, for Production
npx vercel deploy --prebuilt --prod
```

**Or Git integration** (deploy on push): import the repo in Vercel with **Root Directory = `apps/server`**, keep "Include files outside the root directory" on, and leave Framework / Build / Install settings to `apps/server/vercel.json` (install at the monorepo root, `npm run build` writes `.vercel/output`, which Vercel deploys as-is). Without that file Vercel auto-detects a framework and runs the unbundled TypeScript, which fails with `FUNCTION_INVOCATION_FAILED` on every path. Add every variable from `.env.example` under Settings → Environment Variables, then redeploy.

`JWT_SECRET`: `openssl rand -base64 48`. `CRON_SECRET`: `openssl rand -hex 24` (Vercel sends it to the daily cron at `/v1/internal/gc`, 03:17 UTC; the schedule lives in `apps/server/scripts/build-vercel.mjs`, not in `vercel.json`).

## 5. First-deploy checklist (things only a live account can prove)

- [ ] `GET https://<app>.vercel.app/v1/health` → `{"ok":true}`
- [ ] Sign in from the desktop app; device appears as authorized.
- [ ] Copy an image; confirm a `raw` asset of type `private` appears in Cloudinary, and that its content is not a viewable image.
- [ ] Open the image on a second device (exercises `/storage/download-url`).
- [ ] Delete it; after the daily cron (or calling `/v1/internal/gc` with the cron secret) it disappears from Cloudinary.
- [ ] Vercel → Settings → Cron Jobs lists `/v1/internal/gc`.

## Cost notes

Cloudinary Free: 25 credits/month (≈ 25 GB storage or transfer combined). Atlas M0: 512 MB storage. Vercel Hobby: function invocations and transfer are capped; desktop polling uses the cheap `/sync/head` probe every 60 s at most.
