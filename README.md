# NFX STUDIO — Web-to-APK Studio & Mobile IDE

NFX STUDIO is a mobile-first Progressive Web App (PWA) and development studio designed to transform HTML code, ZIP archives, and live responsive web applications into standalone, installable Android APK packages.

---

## 🚀 Key Features

1. **3 Input Methods ("Create App"):**
   - **Paste HTML:** Enter raw HTML directly, saved as `index.html`.
   - **Upload ZIP:** Client-side extraction via JSZip (supports root folders, validates `index.html`, up to 20 MB).
   - **Website URL:** Wrap any `https://` website directly into an Android app container.
   - **Existing Projects:** Re-open, edit files in the mobile code editor, or build from current project.

2. **Cloudflare Pages Functions + KV Hosting (100% Free):**
   - `POST /api/publish`: Stores project files in Cloudflare KV (`app:<id>:file:<path>`).
   - `GET /a/:id/*`: Serves hosted applications with dynamic `manifest.webmanifest`, offline `sw.js`, and security headers (`X-Content-Type-Options: nosniff`, cookie-partitioned CSP).
   - `POST /api/report`: Abuse reporting endpoint with automatic blocklisting.

3. **Authentic Android APK Compilation via PWABuilder Cloud API:**
   - Server-side proxy `POST /api/build-apk` calls Microsoft & Google's free PWABuilder cloud service (`pwabuilder-cloudapk.azurewebsites.net`).
   - Generates a new release signing key so that the resulting `.apk` is cryptographically signed and installable on Android.
   - Automatically returns the `.apk` file for immediate browser download, plus provides a separate `signing-key.zip` for future app updates.
   - Automatic fallback to manual build on `pwabuilder.com` if cloud connection times out.

4. **Android-First UI & Edge-to-Edge Layout:**
   - Zero top/bottom awkward black gutters with `100dvh` viewport support and snug safe-area padding.
   - 3-action row on built apps: **Download** (.apk), **Install** (PWA), and **Open** (Fullscreen native runner).
   - Real progress sheet with 4 steps: Uploading → Preparing app → Building APK → Ready.
   - Ready popup with bilingual installation guidance (English + Bengali).

---

## 💻 How to Run Locally

### Prerequisites
- Node.js (v18 or higher recommended)
- npm or bun

### 1. Install dependencies
```bash
npm install
```

### 2. Start Local Development Server (Express + Vite)
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser. This runs `server.ts`, providing both the backend API endpoints (`/api/publish`, `/api/build-apk`, `/a/:id/*`) with in-memory KV emulation and the Vite frontend.

### 3. Run with Cloudflare Wrangler (Pages Functions + Local KV)
```bash
npm run build
npx wrangler pages dev dist --kv APPS
```

---

## ☁️ How to Deploy for Free to Cloudflare Pages

1. Push your repository to **GitHub** or **GitLab**.
2. Go to the **Cloudflare Dashboard** -> **Workers & Pages** -> **Create application** -> **Pages**.
3. Connect your Git repository.
4. Set Build Settings:
   - **Framework preset:** `Vite`
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
5. Create a KV Namespace:
   - Go to **Workers & Pages** -> **KV** -> **Create namespace** -> name it `nfx_studio_apps_kv`.
6. Bind KV to your Pages project:
   - In your Pages project settings -> **Functions** -> **KV namespace bindings**.
   - Variable name: `APPS`
   - KV namespace: select `nfx_studio_apps_kv`.
7. Redeploy your project. Your app and Cloudflare Pages Functions are now live!

---

## ⚠️ Known Limits & Best Practices

- **File Size:** Maximum 20 MB total per project (Cloudflare KV limit per value is 25 MB).
- **Android Only:** Designed specifically for Android phones running Chrome or Chromium-based browsers.
- **Website URL Mode:** Sites must support `https://` and allow embedding. Sites enforcing strict frame headers will show a direct external link notice.
- **Android Install Warning:** Since apps are signed with a new release key generated during build, Android Play Protect or Chrome may ask for permission ("Allow installs from this source" or "Install anyway").
