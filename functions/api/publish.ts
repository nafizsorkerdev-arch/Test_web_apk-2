// Cloudflare Pages Function: POST /api/publish
interface Env {
  APPS: KVNamespace;
}

interface PublishFile {
  path: string;
  base64: string;
}

interface PublishPayload {
  name: string;
  files: PublishFile[];
  iconBase64?: string;
  themeColor?: string;
}

function generateRandomId(length = 10): string {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let res = '';
  for (let i = 0; i < length; i++) {
    res += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return res;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const { request, env } = context;
    const clientIp = request.headers.get('CF-Connecting-IP') || '127.0.0.1';

    // 1. IP-based rate limiting via KV (max 30 publishes per hour)
    if (env.APPS) {
      const rateKey = `rate:publish:${clientIp}`;
      const currentRate = parseInt((await env.APPS.get(rateKey)) || '0', 10);
      if (currentRate >= 30) {
        return new Response(
          JSON.stringify({ error: 'Rate limit exceeded. Please wait an hour before publishing more apps.' }),
          { status: 429, headers: { 'Content-Type': 'application/json' } }
        );
      }
      await env.APPS.put(rateKey, String(currentRate + 1), { expirationTtl: 3600 });
    }

    const payload = (await request.json()) as PublishPayload;
    if (!payload.name || !payload.files || !Array.isArray(payload.files)) {
      return new Response(JSON.stringify({ error: 'Invalid payload: name and files are required.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (payload.files.length > 300) {
      return new Response(JSON.stringify({ error: 'Too many files. Maximum 300 files per project.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 2. Validate total payload size (Max ~20MB)
    let totalSize = 0;
    for (const f of payload.files) {
      totalSize += (f.base64?.length || 0) * 0.75;
    }
    if (totalSize > 22 * 1024 * 1024) {
      return new Response(JSON.stringify({ error: 'Project exceeds 20MB limit.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 3. Ensure index.html exists (auto-inject if user provided alternate HTML or only assets)
    let hasIndex = payload.files.some((f) => f.path.toLowerCase() === 'index.html');
    if (!hasIndex) {
      const altHtml = payload.files.find((f) => /\.html?$/i.test(f.path));
      if (altHtml) {
        payload.files.unshift({
          path: 'index.html',
          base64: altHtml.base64,
        });
        hasIndex = true;
      } else {
        const defaultHtml = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>${payload.name}</title><style>body{font-family:sans-serif;background:#000;color:#fff;padding:24px;text-align:center;}h1{color:#0a84ff;}</style></head><body><h1>${payload.name}</h1><p>Your web application is live!</p></body></html>`;
        let b64 = '';
        try {
          b64 = btoa(unescape(encodeURIComponent(defaultHtml)));
        } catch {
          b64 = btoa(defaultHtml);
        }
        payload.files.unshift({
          path: 'index.html',
          base64: b64,
        });
        hasIndex = true;
      }
    }

    const id = generateRandomId(10);
    const filePaths: string[] = [];

    // 4. Store each file in KV (if APPS KV is bound)
    if (env.APPS) {
      for (const f of payload.files) {
        const cleanPath = f.path.replace(/^\/+/, '');
        filePaths.push(cleanPath);
        await env.APPS.put(`app:${id}:file:${cleanPath}`, f.base64);
      }

      // Store meta key
      const meta = {
        id,
        name: payload.name.slice(0, 50),
        themeColor: payload.themeColor || '#0a84ff',
        hasCustomIcon: !!payload.iconBase64,
        createdAt: Date.now(),
        files: filePaths,
      };
      await env.APPS.put(`app:${id}:meta`, JSON.stringify(meta));

      if (payload.iconBase64) {
        await env.APPS.put(`app:${id}:icon`, payload.iconBase64);
      }
    }

    const origin = new URL(request.url).origin;
    const hostedUrl = `${origin}/a/${id}/`;

    return new Response(JSON.stringify({ id, url: hostedUrl }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Publish error';
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
