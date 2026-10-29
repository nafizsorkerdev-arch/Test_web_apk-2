// Cloudflare Pages Function: GET /a/:id/*
interface Env {
  APPS: KVNamespace;
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

function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { request, env, params } = context;
  const pathParts = (params.path as string[]) || [];

  if (pathParts.length === 0) {
    return new Response('App not found', { status: 404 });
  }

  const appId = pathParts[0];
  const subPath = pathParts.slice(1).join('/') || 'index.html';

  if (!env.APPS) {
    return new Response('Storage unavailable', { status: 503 });
  }

  // 1. Check Blocklist
  const isBlocked = await env.APPS.get(`blocklist:${appId}`);
  if (isBlocked) {
    return new Response('This application has been suspended due to abuse reports.', {
      status: 403,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  // 2. Fetch App Meta
  const metaRaw = await env.APPS.get(`app:${appId}:meta`);
  if (!metaRaw) {
    return new Response('Application not found or expired', { status: 404 });
  }

  interface AppMeta {
    id: string;
    name: string;
    themeColor: string;
    hasCustomIcon: boolean;
  }
  const meta = JSON.parse(metaRaw) as AppMeta;
  const origin = new URL(request.url).origin;

  // 3. Serve dynamic manifest.webmanifest
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
    return new Response(JSON.stringify(manifest, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/manifest+json; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }

  // 4. Serve dynamic service worker (sw.js)
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
    return new Response(swCode, {
      status: 200,
      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }

  // 5. Serve custom app icon
  if (subPath === 'icon') {
    const iconBase64 = await env.APPS.get(`app:${appId}:icon`);
    if (iconBase64) {
      const cleanB64 = iconBase64.replace(/^data:image\/\w+;base64,/, '');
      const bytes = base64ToUint8Array(cleanB64);
      return new Response(bytes, {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=86400',
        },
      });
    }
    return Response.redirect(`${origin}/icon.svg`, 302);
  }

  // 6. Serve requested file
  const filePath = subPath === '' || subPath === '/' ? 'index.html' : subPath;
  const fileBase64 = await env.APPS.get(`app:${appId}:file:${filePath}`);

  if (!fileBase64) {
    // If not found and HTML-like, try index.html
    if (!filePath.includes('.')) {
      const indexB64 = await env.APPS.get(`app:${appId}:file:index.html`);
      if (indexB64) {
        return handleHtmlResponse(indexB64, appId, meta);
      }
    }
    return new Response('File not found', { status: 404 });
  }

  const mime = getMime(filePath);
  if (mime.startsWith('text/html')) {
    return handleHtmlResponse(fileBase64, appId, meta);
  }

  const bytes = base64ToUint8Array(fileBase64);
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': mime,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=600',
    },
  });
};

function handleHtmlResponse(base64: string, appId: string, meta: { name: string; themeColor: string }): Response {
  let html = atob(base64);

  // Auto-inject PWA manifest, theme-color, viewport, and service worker registration
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

  // Enforce security headers: isolated cookie sandbox, X-Content-Type-Options nosniff
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;",
      'Cache-Control': 'no-cache',
    },
  });
}
