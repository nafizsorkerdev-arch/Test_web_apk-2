// Cloudflare Pages Function: POST /api/build-apk
import JSZip from 'jszip';

interface Env {
  APPS: KVNamespace;
}

interface BuildApkPayload {
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

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const { request } = context;
    const body = (await request.json()) as BuildApkPayload;
    const origin = new URL(request.url).origin;

    const name = (body.name || 'MyApp').trim();
    const cleanName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const vn = body.versionName || '1.0.0';
    const vc = parseInt(String(body.versionCode || '1'), 10) || 1;

    let webAppUrl = body.url?.trim();
    if (!webAppUrl && body.id) {
      webAppUrl = `${origin}/a/${body.id}/`;
    }

    if (!webAppUrl) {
      return new Response(JSON.stringify({ error: 'App URL or ID is required.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Default icon
    const fallbackIcon = `${origin}/icon.svg`;
    const iconUrl = body.iconUrl || (body.id ? `${origin}/a/${body.id}/icon` : fallbackIcon);

    const slug = cleanName.toLowerCase();
    const pkg = body.packageId || `com.nfx.${/^[a-z]/.test(slug) ? slug : 'app' + slug}`;
    const themeColor = body.themeColor || '#0a84ff';
    const backgroundColor = body.backgroundColor || '#000000';

    // Construct PWABuilder CloudAPK Request payload
    const pwaBuilderPayload = {
      packageId: pkg,
      name: name,
      launcherName: name.slice(0, 12),
      webAppUrl: webAppUrl,
      appVersion: vn,
      appVersionCode: vc,
      themeColor: themeColor,
      navColor: themeColor,
      backgroundColor: backgroundColor,
      startUrl: webAppUrl,
      iconUrl: iconUrl,
      maskableIconUrl: iconUrl,
      monochromeIconUrl: iconUrl,
      splashScreenColor: backgroundColor,
      signingMode: 'new',
      signing: {
        file: null,
        alias: 'nfx-release',
        fullName: name,
        organization: 'NFX Studio',
        organizationalUnit: 'Mobile',
        countryCode: 'US',
        keyPassword: 'password123',
        storePassword: 'password123',
      },
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000); // 2 minute timeout

    let pwaRes: Response;
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
      return new Response(
        JSON.stringify({
          success: false,
          error: isTimeout
            ? 'PWABuilder compilation timed out. You can build it manually on pwabuilder.com.'
            : 'Could not connect to PWABuilder Cloud service.',
          fallbackUrl: `https://www.pwabuilder.com/?url=${encodeURIComponent(webAppUrl)}`,
          hostedUrl: webAppUrl,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    clearTimeout(timeout);

    if (!pwaRes.ok) {
      const errText = await pwaRes.text().catch(() => '');
      return new Response(
        JSON.stringify({
          success: false,
          error: `PWABuilder Cloud returned status ${pwaRes.status}: ${errText.slice(0, 150)}`,
          fallbackUrl: `https://www.pwabuilder.com/?url=${encodeURIComponent(webAppUrl)}`,
          hostedUrl: webAppUrl,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const zipArrayBuffer = await pwaRes.arrayBuffer();
    const zip = await JSZip.loadAsync(zipArrayBuffer);

    // Look for .apk inside returned zip
    let apkFile = Object.values(zip.files).find((f) => !f.dir && f.name.toLowerCase().endsWith('.apk'));
    if (!apkFile) {
      apkFile = Object.values(zip.files).find((f) => !f.dir && /app.*signed/i.test(f.name));
    }

    if (!apkFile) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'No APK was found inside the cloud build bundle.',
          fallbackUrl: `https://www.pwabuilder.com/?url=${encodeURIComponent(webAppUrl)}`,
          hostedUrl: webAppUrl,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
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

    return new Response(
      JSON.stringify({
        success: true,
        apkBase64,
        apkFileName: `${cleanName}_v${vn}.apk`,
        apkSize: sizeString,
        hostedUrl: webAppUrl,
        signingKeyBase64,
        signingKeyFileName: `${cleanName}_signing_keys.zip`,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Build APK error';
    return new Response(JSON.stringify({ success: false, error: msg }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
