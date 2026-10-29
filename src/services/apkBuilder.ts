import { Project } from '../types';

export interface BuildApkResponse {
  success: boolean;
  apkBase64?: string;
  apkFileName?: string;
  apkSize?: string;
  hostedUrl?: string;
  signingKeyBase64?: string;
  signingKeyFileName?: string;
  error?: string;
  fallbackUrl?: string;
}

/**
 * Publishes project files to the cloud hosting endpoint (/api/publish).
 * Ensures an index.html file is ALWAYS present and parses responses safely.
 */
export async function publishProjectToCloud(
  project: Project,
  themeColor = '#0a84ff',
  iconBase64?: string | null
): Promise<{ id: string; url: string }> {
  const filesPayload: { path: string; base64: string }[] = [];

  let hasIndexHtml = false;
  let firstHtmlContent: string | null = null;

  for (const f of project.files || []) {
    const cleanPath = (f.name || '').replace(/^[\.\/\\]+/, '');
    if (!cleanPath) continue;

    if (cleanPath.toLowerCase() === 'index.html') {
      hasIndexHtml = true;
    }
    if (/\.html?$/i.test(cleanPath) && firstHtmlContent === null) {
      firstHtmlContent = f.content || '';
    }

    if (f.media && f.data) {
      const parts = f.data.split(',');
      if (parts[1]) {
        filesPayload.push({
          path: cleanPath,
          base64: parts[1],
        });
      }
    } else {
      // Convert text content to base64 safely (supporting UTF-8 Unicode)
      const encoded = btoa(unescape(encodeURIComponent(f.content || '')));
      filesPayload.push({
        path: cleanPath,
        base64: encoded,
      });
    }
  }

  // Ensure index.html is ALWAYS present
  if (!hasIndexHtml) {
    if (firstHtmlContent !== null) {
      filesPayload.unshift({
        path: 'index.html',
        base64: btoa(unescape(encodeURIComponent(firstHtmlContent))),
      });
    } else {
      const defaultHtml = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>${project.name}</title><style>body{font-family:sans-serif;background:#000;color:#fff;padding:20px;text-align:center;}h1{color:#0a84ff;}</style></head><body><h1>${project.name}</h1><p>Your instant web application is live!</p></body></html>`;
      filesPayload.unshift({
        path: 'index.html',
        base64: btoa(unescape(encodeURIComponent(defaultHtml))),
      });
    }
  }

  const res = await fetch('/api/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: project.name,
      files: filesPayload,
      iconBase64: iconBase64 || project.img || undefined,
      themeColor,
    }),
  });

  const text = await res.text();
  let data: { id?: string; url?: string; error?: string };

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Server returned invalid response (${res.status}): ${text.slice(0, 120)}`
    );
  }

  if (!res.ok || data.error || !data.id) {
    throw new Error(data.error || `Publish failed with status ${res.status}`);
  }

  return { id: data.id, url: data.url || `/a/${data.id}/` };
}

/**
 * Calls /api/build-apk which proxies PWABuilder CloudAPK service server-side
 * to generate a signed, installable Android APK file.
 * Handles non-JSON responses safely without crashing.
 */
export async function buildApkViaCloud(
  params: {
    id?: string;
    url?: string;
    name: string;
    packageId?: string;
    versionName?: string;
    versionCode?: string | number;
    themeColor?: string;
    backgroundColor?: string;
    iconUrl?: string;
  }
): Promise<BuildApkResponse> {
  try {
    const res = await fetch('/api/build-apk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });

    const text = await res.text();
    let data: BuildApkResponse;

    try {
      data = JSON.parse(text) as BuildApkResponse;
    } catch {
      return {
        success: false,
        error: `Server returned non-JSON response (${res.status}): ${text.slice(0, 120)}`,
        fallbackUrl: `https://www.pwabuilder.com/?url=${encodeURIComponent(params.url || '')}`,
        hostedUrl: params.url,
      };
    }

    return data;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Network error';
    return {
      success: false,
      error: msg,
      fallbackUrl: `https://www.pwabuilder.com/?url=${encodeURIComponent(params.url || '')}`,
      hostedUrl: params.url,
    };
  }
}

/**
 * Downloads a base64 encoded file directly to device with specified MIME type.
 */
export function downloadBase64File(base64: string, filename: string, mimeType = 'application/octet-stream') {
  const byteCharacters = atob(base64);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  const blob = new Blob([byteArray], { type: mimeType });

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
