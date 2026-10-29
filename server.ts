import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import JSZip from 'jszip';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(express.json({ limit: '50mb' }));

// In-memory KV emulation for local dev & AI Studio dev server
const kvStore = new Map<string, string>();
const reportCounts = new Map<string, number>();

function generateRandomId(length = 10): string {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let res = '';
  for (let i = 0; i < length; i++) {
    res += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return res;
}

const MIME_MAP: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml',
};

function getMime(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return MIME_MAP[ext] || 'application/octet-stream';
}

function base64ToBuffer(base64: string): Buffer {
  return Buffer.from(base64, 'base64');
}

// POST /api/publish
app.post('/api/publish', async (req: Request, res: Response) => {
  try {
    const { name, files, iconBase64, themeColor } = req.body;
    if (!name || !files || !Array.isArray(files)) {
      return res.status(400).json({ error: 'Invalid payload: name and files are required.' });
    }

    if (files.length > 300) {
      return res.status(400).json({ error: 'Too many files. Maximum 300 files per project.' });
    }

    let hasIndex = files.some((f: { path: string }) => f.path.toLowerCase() === 'index.html');
    if (!hasIndex) {
      const altHtml = files.find((f: { path: string }) => /\.html?$/i.test(f.path));
      if (altHtml) {
        files.unshift({
          path: 'index.html',
          base64: altHtml.base64,
        });
        hasIndex = true;
      } else {
        const defaultHtml = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>${name}</title><style>body{font-family:sans-serif;background:#000;color:#fff;padding:24px;text-align:center;}h1{color:#0a84ff;}</style></head><body><h1>${name}</h1><p>Your instant web application is live!</p></body></html>`;
        files.unshift({
          path: 'index.html',
          base64: Buffer.from(defaultHtml, 'utf-8').toString('base64'),
        });
        hasIndex = true;
      }
    }

    const id = generateRandomId(10);
    const filePaths: string[] = [];

    for (const f of files) {
      const cleanPath = f.path.replace(/^\/+/, '');
      filePaths.push(cleanPath);
      kvStore.set(`app:${id}:file:${cleanPath}`, f.base64);
    }

    const meta = {
      id,
      name: String(name).slice(0, 50),
      themeColor: themeColor || '#0a84ff',
      hasCustomIcon: !!iconBase64,
      createdAt: Date.now(),
      files: filePaths,
    };
    kvStore.set(`app:${id}:meta`, JSON.stringify(meta));

    if (iconBase64) {
      kvStore.set(`app:${id}:icon`, iconBase64);
    }

    const origin = `${req.protocol}://${req.get('host')}`;
    const hostedUrl = `${origin}/a/${id}/`;

    return res.status(200).json({ id, url: hostedUrl });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Publish error';
    return res.status(500).json({ error: msg });
  }
});

// POST /api/report
app.post('/api/report', (req: Request, res: Response) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'App ID required.' });
  const count = (reportCounts.get(id) || 0) + 1;
  reportCounts.set(id, count);
  if (count >= 5) {
    kvStore.set(`blocklist:${id}`, 'true');
  }
  return res.json({ success: true, message: 'Report received.' });
});

// POST /api/build-apk (Calls PWABuilder CloudAPK API)
app.post('/api/build-apk', async (req: Request, res: Response) => {
  try {
    const { id, url, name, packageId, versionName, versionCode, themeColor, backgroundColor, iconUrl } = req.body;
    const origin = `${req.protocol}://${req.get('host')}`;

    const appName = (name || 'MyApp').trim();
    const cleanName = appName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const vn = versionName || '1.0.0';
    const vc = parseInt(String(versionCode || '1'), 10) || 1;

    let webAppUrl = url?.trim();
    if (!webAppUrl && id) {
      webAppUrl = `${origin}/a/${id}/`;
    }

    if (!webAppUrl) {
      return res.status(400).json({ error: 'App URL or ID is required.' });
    }

    const fallbackIcon = `${origin}/icon.svg`;
    const finalIconUrl = iconUrl || (id ? `${origin}/a/${id}/icon` : fallbackIcon);

    const slug = cleanName.toLowerCase();
    const pkg = packageId || `com.nfx.${/^[a-z]/.test(slug) ? slug : 'app' + slug}`;
    const themeCol = themeColor || '#0a84ff';
    const bgCol = backgroundColor || '#000000';

    const pwaBuilderPayload = {
      packageId: pkg,
      name: appName,
      launcherName: appName.slice(0, 12),
      webAppUrl,
      appVersion: vn,
      appVersionCode: vc,
      themeColor: themeCol,
      navColor: themeCol,
      backgroundColor: bgCol,
      startUrl: webAppUrl,
      iconUrl: finalIconUrl,
      maskableIconUrl: finalIconUrl,
      monochromeIconUrl: finalIconUrl,
      splashScreenColor: bgCol,
      signingMode: 'new',
      signing: {
        file: null,
        alias: 'nfx-release',
        fullName: appName,
        organization: 'NFX Studio',
        organizationalUnit: 'Mobile',
        countryCode: 'US',
        keyPassword: 'password123',
        storePassword: 'password123',
      },
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000); // 2 minute timeout

    let pwaRes: globalThis.Response;
    try {
      pwaRes = await fetch('https://pwabuilder-cloudapk.azurewebsites.net/generateAppPackage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/zip, application/octet-stream',
        },
        body: JSON.stringify(pwaBuilderPayload),
        signal: controller.signal,
      });
    } catch (fetchErr: unknown) {
      clearTimeout(timeout);
      const isTimeout = fetchErr instanceof Error && fetchErr.name === 'AbortError';
      return res.status(200).json({
        success: false,
        error: isTimeout
          ? 'PWABuilder compilation timed out. You can build it manually on pwabuilder.com.'
          : 'Could not connect to PWABuilder Cloud service.',
        fallbackUrl: `https://www.pwabuilder.com/?url=${encodeURIComponent(webAppUrl)}`,
        hostedUrl: webAppUrl,
      });
    }
    clearTimeout(timeout);

    if (!pwaRes.ok) {
      const errText = await pwaRes.text().catch(() => '');
      return res.status(200).json({
        success: false,
        error: `PWABuilder Cloud returned status ${pwaRes.status}: ${errText.slice(0, 150)}`,
        fallbackUrl: `https://www.pwabuilder.com/?url=${encodeURIComponent(webAppUrl)}`,
        hostedUrl: webAppUrl,
      });
    }

    const zipArrayBuffer = await pwaRes.arrayBuffer();
    const zip = await JSZip.loadAsync(zipArrayBuffer);

    let apkFile = Object.values(zip.files).find((f) => !f.dir && f.name.toLowerCase().endsWith('.apk'));
    if (!apkFile) {
      apkFile = Object.values(zip.files).find((f) => !f.dir && /app.*signed/i.test(f.name));
    }

    if (!apkFile) {
      return res.status(200).json({
        success: false,
        error: 'No APK was found inside the cloud build bundle.',
        fallbackUrl: `https://www.pwabuilder.com/?url=${encodeURIComponent(webAppUrl)}`,
        hostedUrl: webAppUrl,
      });
    }

    const apkBase64 = await apkFile.async('base64');
    const apkByteSize = Math.round((apkBase64.length * 3) / 4);
    const sizeString =
      apkByteSize < 1048576
        ? `${(apkByteSize / 1024).toFixed(1)} KB`
        : `${(apkByteSize / 1048576).toFixed(1)} MB`;

    // Extract signing keys and passwords into separate zip
    const keysZip = new JSZip();
    let hasKeys = false;
    for (const [fName, fObj] of Object.entries(zip.files)) {
      if (
        !fObj.dir &&
        (/\.(keystore|jks|txt|p12)$/i.test(fName) || /signing|password|readme/i.test(fName)) &&
        !fName.toLowerCase().endsWith('.apk')
      ) {
        keysZip.file(fName, await fObj.async('uint8array'));
        hasKeys = true;
      }
    }

    let signingKeyBase64: string | undefined;
    if (hasKeys) {
      signingKeyBase64 = await keysZip.generateAsync({ type: 'base64' });
    }

    return res.status(200).json({
      success: true,
      apkBase64,
      apkFileName: `${cleanName}_v${vn}.apk`,
      apkSize: sizeString,
      hostedUrl: webAppUrl,
      signingKeyBase64,
      signingKeyFileName: `${cleanName}_signing_keys.zip`,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Build APK error';
    return res.status(500).json({ success: false, error: msg });
  }
});

// GET /a/:id/* Serve hosted apps
app.get('/a/:id*', (req: Request, res: Response) => {
  const appId = req.params.id;
  const pathAfterId = req.params[0] ? req.params[0].replace(/^\/+/, '') : '';
  const subPath = pathAfterId || 'index.html';

  if (kvStore.get(`blocklist:${appId}`)) {
    return res.status(403).send('This application has been suspended due to abuse reports.');
  }

  const metaRaw = kvStore.get(`app:${appId}:meta`);
  if (!metaRaw) {
    return res.status(404).send('Application not found or expired');
  }

  const meta = JSON.parse(metaRaw);
  const origin = `${req.protocol}://${req.get('host')}`;

  if (subPath === 'manifest.webmanifest' || subPath === 'manifest.json') {
    const iconUrl = meta.hasCustomIcon ? `${origin}/a/${appId}/icon` : `${origin}/icon.svg`;
    const manifest = {
      name: meta.name,
      short_name: meta.name.slice(0, 12),
      start_url: `/a/${appId}/`,
      scope: `/a/${appId}/`,
      display: 'standalone',
      background_color: '#000000',
      theme_color: meta.themeColor || '#0a84ff',
      orientation: 'portrait',
      icons: [
        {
          src: iconUrl,
          sizes: '512x512',
          type: 'image/png',
          purpose: 'any maskable',
        },
      ],
    };
    res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    return res.json(manifest);
  }

  if (subPath === 'sw.js') {
    const swCode = `// NFX Studio Offline Service Worker for ${meta.name}
const CACHE_NAME = 'nfx-cache-${appId}';
self.addEventListener('install', (e) => {
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(clients.claim());
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((cached) => {
      return (
        cached ||
        fetch(e.request).then((res) => {
          if (res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
          }
          return res;
        }).catch(() => caches.match('/a/${appId}/'))
      );
    })
  );
});`;
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    return res.send(swCode);
  }

  if (subPath === 'icon') {
    const iconBase64 = kvStore.get(`app:${appId}:icon`);
    if (iconBase64) {
      const cleanB64 = iconBase64.replace(/^data:image\/\w+;base64,/, '');
      const buf = base64ToBuffer(cleanB64);
      res.setHeader('Content-Type', 'image/png');
      return res.send(buf);
    }
    return res.redirect(`${origin}/icon.svg`);
  }

  const filePath = subPath === '' || subPath === '/' ? 'index.html' : subPath;
  let fileBase64 = kvStore.get(`app:${appId}:file:${filePath}`);

  if (!fileBase64 && !filePath.includes('.')) {
    fileBase64 = kvStore.get(`app:${appId}:file:index.html`);
  }

  if (!fileBase64) {
    return res.status(404).send('File not found');
  }

  const mime = getMime(filePath);
  if (mime.startsWith('text/html')) {
    let html = Buffer.from(fileBase64, 'base64').toString('utf-8');
    const injectHead = `
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
  <link rel="manifest" href="/a/${appId}/manifest.webmanifest">
  <meta name="theme-color" content="${meta.themeColor || '#0a84ff'}">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="mobile-web-app-capable" content="yes">
  <script>
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/a/${appId}/sw.js');
      });
    }
  </script>
`;
    if (html.includes('</head>')) {
      html = html.replace('</head>', `${injectHead}\n</head>`);
    } else {
      html = `${injectHead}\n${html}`;
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;");
    return res.send(html);
  }

  const buf = base64ToBuffer(fileBase64);
  res.setHeader('Content-Type', mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.send(buf);
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    // Mount Vite dev server middlewares
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // Serve static dist
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`NFX STUDIO Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
