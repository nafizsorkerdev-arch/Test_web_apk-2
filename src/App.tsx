/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import JSZip from 'jszip';
import { usePWA } from './hooks/usePWA';
import { Project, ProjectFile, APKItem, BuildConfig } from './types';
import {
  getAllProjects,
  saveProject,
  deleteProject as deleteProjectDB,
  clearAllProjects,
  clearAllAPKs,
  getAllAPKs,
  saveAPK,
  deleteAPK as deleteAPKDB,
  purgeDemoData,
} from './services/storage';
import {
  publishProjectToCloud,
  buildApkViaCloud,
  downloadBase64File,
} from './services/apkBuilder';

// Palette for project backgrounds
const PAL: [string, string][] = [
  ['#ff9f0a', '#ff6a00'],
  ['#30d158', '#17a34a'],
  ['#bf5af2', '#8944d8'],
  ['#0a84ff', '#0060df'],
  ['#ff375f', '#d6204a'],
  ['#64d2ff', '#2aa8e0'],
];

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmt = (d: Date) => `${MON[d.getMonth()]} ${String(d.getDate()).padStart(2, '0')}, ${d.getFullYear()}`;
const fmtTime = (t: number) => {
  const d = new Date(t);
  let h = d.getHours();
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${MON[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} · ${h}:${String(d.getMinutes()).padStart(2, '0')} ${ap}`;
};
const fmtSize = (n: number) => {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
};
const extOf = (n: string) => (n.includes('.') ? n.split('.').pop()! : '').toLowerCase();

const EXT_COL: Record<string, [string, string]> = {
  html: ['#ff9500', '#ff6a00'],
  htm: ['#ff9500', '#ff6a00'],
  css: ['#0a84ff', '#0060df'],
  js: ['#f5b700', '#e09600'],
  json: ['#34c759', '#1fa745'],
  xml: ['#bf5af2', '#8944d8'],
  txt: ['#8e8e93', '#636366'],
  md: ['#64d2ff', '#2aa8e0'],
  php: ['#5e5ce6', '#4240c4'],
  svg: ['#ff9500', '#ff6a00'],
};
const dotColor = (n: string) => (EXT_COL[extOf(n)] || EXT_COL.txt)[0];

const starterFiles = (name: string): ProjectFile[] => [
  {
    name: 'index.html',
    content: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${name}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div class="card">
    <div class="logo">⚡</div>
    <h1>${name}</h1>
    <p>Your web application is running live inside NFX STUDIO. Edit code in the editor or export to a production Android APK.</p>
    <button id="btn">Interactive Action</button>
  </div>
  <script src="script.js"></script>
</body>
</html>`,
    mod: Date.now(),
  },
  {
    name: 'style.css',
    content: `* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
  background: linear-gradient(145deg, #0a1128, #1c1c3c);
  color: #ffffff;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.card {
  background: rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(24px);
  border: 1px solid rgba(255, 255, 255, 0.15);
  padding: 32px 24px;
  border-radius: 28px;
  text-align: center;
  max-width: 320px;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.4);
}
.logo { font-size: 44px; margin-bottom: 12px; }
h1 { font-size: 26px; font-weight: 700; margin-bottom: 10px; letter-spacing: -0.5px; }
p { font-size: 14px; opacity: 0.85; line-height: 1.5; margin-bottom: 20px; }
button {
  background: #007aff;
  color: #fff;
  border: 0;
  padding: 14px 26px;
  border-radius: 999px;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  transition: transform 0.2s, background 0.2s;
  box-shadow: 0 6px 18px rgba(0, 122, 255, 0.4);
}
button:active { transform: scale(0.96); }`,
    mod: Date.now(),
  },
  {
    name: 'script.js',
    content: `document.getElementById('btn')?.addEventListener('click', () => {
  alert('Greetings from ' + ${JSON.stringify(name)} + '! Your application code is fully functional.');
  console.log('Initialized: ' + ${JSON.stringify(name)});
});`,
    mod: Date.now(),
  },
];

const sizeOfFile = (f: ProjectFile): number => {
  if (f.media) {
    return f.size || Math.round((f.data || '').length * 0.75);
  }
  return new Blob([f.content || '']).size;
};

// Syntax highlighter
const KW = new Set('const let var function return if else for while do switch case break continue new this class extends import export from default async await try catch finally throw typeof instanceof in of null undefined true false void delete static super yield'.split(' '));
const escHtml = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));
const wrapToken = (cls: string, s: string) => `<span class="h-${cls}">${escHtml(s)}</span>`;

function tokenize(src: string, re: RegExp, fn: (m: RegExpExecArray) => string): string {
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out += escHtml(src.slice(last, m.index));
    out += fn(m);
    last = re.lastIndex;
    if (m[0] === '') re.lastIndex++;
  }
  return out + escHtml(src.slice(last));
}

const jsHighlight = (s: string) =>
  tokenize(
    s,
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\[\s\S])*`)|(\b\d+\.?\d*\b)|(\b[A-Za-z_$][\w$]*\b)/g,
    (m) => (m[1] ? wrapToken('c', m[0]) : m[2] ? wrapToken('s', m[0]) : m[3] ? wrapToken('n', m[0]) : KW.has(m[4]) ? wrapToken('k', m[4]) : escHtml(m[0]))
  );

const cssHighlight = (s: string) =>
  tokenize(
    s,
    /(\/\*[\s\S]*?\*\/)|("[^"\n]*"|'[^'\n]*')|(#[0-9a-fA-F]{3,8}\b|-?\b\d+\.?\d*(?:px|em|rem|%|vh|vw|s|ms|deg|fr)?)|([\w-]+(?=\s*:))|(@[\w-]+)/g,
    (m) => (m[1] ? wrapToken('c', m[0]) : m[2] ? wrapToken('s', m[0]) : m[3] ? wrapToken('n', m[0]) : m[4] ? wrapToken('a', m[0]) : wrapToken('k', m[0]))
  );

const tagHighlight = (s: string) =>
  tokenize(s, /(<\/?[\w:-]+)|("[^"]*"|'[^']*')|([\w:-]+(?==))|(\/?>)/g, (m) =>
    m[1] ? wrapToken('t', m[0]) : m[2] ? wrapToken('s', m[0]) : m[3] ? wrapToken('a', m[0]) : wrapToken('t', m[0])
  );

const htmlHighlight = (s: string) =>
  tokenize(s, /(<!--[\s\S]*?-->)|(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\3>)|(<\/?[A-Za-z][^>]*>?)/gi, (m) =>
    m[1]
      ? wrapToken('c', m[0])
      : m[2]
      ? tagHighlight(m[2]) + (m[3].toLowerCase() === 'script' ? jsHighlight(m[4]) : cssHighlight(m[4])) + tagHighlight(m[5])
      : tagHighlight(m[6])
  );

function highlightCode(src: string, ext: string): string {
  if (src.length > 400000) return escHtml(src);
  if (ext === 'html' || ext === 'htm' || ext === 'xml' || ext === 'svg' || ext === 'php') return htmlHighlight(src);
  if (ext === 'css') return cssHighlight(src);
  if (ext === 'js' || ext === 'mjs' || ext === 'json' || ext === 'ts') return jsHighlight(src);
  return escHtml(src);
}

export default function App() {
  const { isInstallable, isInstalled, isIOS, isOnline, installApp } = usePWA();

  // Navigation State
  const [activeTab, setActiveTab] = useState<'home' | 'projects' | 'apk' | 'settings'>('home');
  const [scrolled, setScrolled] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      return (localStorage.getItem('nfx-theme') as 'light' | 'dark') || 'dark';
    } catch {
      return 'dark';
    }
  });

  // Projects & APKs State (Clean slate, stored in IndexedDB)
  const [projects, setProjects] = useState<Project[]>([]);
  const [apks, setApks] = useState<APKItem[]>([]);

  // Active sub-views
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [activeFileIndex, setActiveFileIndex] = useState<number>(0);
  const [isFileEditorOpen, setIsFileEditorOpen] = useState(false);
  const [isBuildOpen, setIsBuildOpen] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);

  // Fullscreen Running App State (for OPEN button)
  const [runningApp, setRunningApp] = useState<{ name: string; html: string; url?: string } | null>(null);

  // Modals & Sheets
  const [showCreateAppDlg, setShowCreateAppDlg] = useState(false);
  const [showCreateFileDlg, setShowCreateFileDlg] = useState(false);
  const [showImportDlg, setShowImportDlg] = useState(false);
  const [showActionSheet, setShowActionSheet] = useState(false);
  const [actionSheetTarget, setActionSheetTarget] = useState<{ type: 'file' | 'project'; index: number } | null>(null);
  const [showIOSInstallGuide, setShowIOSInstallGuide] = useState(false);

  // Ready APK Result Modal State
  const [readyApkModalData, setReadyApkModalData] = useState<{
    name: string;
    version: string;
    size: string;
    apkBase64?: string;
    apkFileName: string;
    signingKeyBase64?: string;
    signingKeyFileName?: string;
    hostedUrl?: string;
    fallbackUrl?: string;
    icon?: string | null;
  } | null>(null);

  // Alert Dialog State
  const [alertConfig, setAlertConfig] = useState<{
    show: boolean;
    title: string;
    msg: string;
    input: string | null;
    okText: string;
    danger: boolean;
    onConfirm: (val: string | null) => void;
  } | null>(null);

  // Toast
  const [toastMsg, setToastMsg] = useState('');
  const [showToast, setShowToast] = useState(false);
  const toastTimerRef = useRef<NodeJS.Timeout | null>(null);

  const showToastNotification = useCallback((msg: string) => {
    setToastMsg(msg);
    setShowToast(true);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setShowToast(false), 2400);
  }, []);

  // Theme synchronization
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    const metaTheme = document.getElementById('theme-color-meta') as HTMLMetaElement | null;
    if (metaTheme) {
      metaTheme.content = theme === 'dark' ? '#000000' : '#f2f2f7';
    }
    try {
      localStorage.setItem('nfx-theme', theme);
    } catch {}
  }, [theme]);

  // Forcefully purge any residual demo/seed data from IndexedDB & localStorage on startup
  useEffect(() => {
    purgeDemoData().then(() => {
      Promise.all([getAllProjects(), getAllAPKs()]).then(([projs, savedApks]) => {
        setProjects(projs);
        setApks(savedApks);
      });
    });
  }, []);

  // Window scroll handler
  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 30);
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Haptic feedback helper
  const triggerHaptic = (ms = 10) => {
    try {
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate(ms);
      }
    } catch {}
  };

  // Helper to render Project Icon
  const renderProjectIcon = (p: Project) => {
    if (p.img) {
      return <img src={p.img} alt={p.name} className="w-full h-full object-cover" />;
    }
    if (p.icon) {
      return <div className="w-full h-full grid place-items-center" dangerouslySetInnerHTML={{ __html: p.icon }} />;
    }
    return <b className="ltr">{(p.name[0] || 'N').toUpperCase()}</b>;
  };

  // --- NEW CREATE APP (3 INPUT TABS) STATE ---
  const [inputTab, setInputTab] = useState<'html' | 'zip' | 'url'>('html');
  const [createAppName, setCreateAppName] = useState('');
  const [pastedHtml, setPastedHtml] = useState(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>My Mobile App</title>
  <style>
    body { font-family: sans-serif; background: #111; color: #fff; padding: 24px; text-align: center; }
    h1 { color: #0a84ff; }
  </style>
</head>
<body>
  <h1>Hello from NFX Studio</h1>
  <p>Your instant Android application is ready!</p>
</body>
</html>`);
  const [uploadedZipFile, setUploadedZipFile] = useState<File | null>(null);
  const [uploadedZipName, setUploadedZipName] = useState('Select ZIP file (max 20 MB)');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [createAppIconData, setCreateAppIconData] = useState<string | null>(null);
  const [createAppShake, setCreateAppShake] = useState(false);

  const iconInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);

  const resetCreateAppForm = () => {
    setCreateAppName('');
    setWebsiteUrl('');
    setUploadedZipFile(null);
    setUploadedZipName('Select ZIP file (max 20 MB)');
    setCreateAppIconData(null);
    setCreateAppShake(false);
  };

  const handleIconUpload = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 160;
        canvas.height = 160;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const s = Math.min(img.width, img.height);
          ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 160, 160);
          setCreateAppIconData(canvas.toDataURL('image/jpeg', 0.88));
        }
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  };

  const handleZipFileSelected = (file: File) => {
    if (file.size > 22 * 1048576) {
      showToastNotification('ZIP exceeds maximum 20 MB limit.');
      return;
    }
    setUploadedZipFile(file);
    const sizeStr =
      file.size / 1048576 >= 1
        ? `${(file.size / 1048576).toFixed(1)} MB`
        : `${Math.max(1, Math.round(file.size / 1024))} KB`;
    setUploadedZipName(`${file.name} · ${sizeStr}`);
    if (!createAppName.trim()) {
      setCreateAppName(file.name.replace(/\.zip$/i, '').slice(0, 40));
    }
  };

  // Unzip in browser with JSZip and validate index.html
  const extractZipFiles = async (file: File): Promise<ProjectFile[] | null> => {
    try {
      const zip = await JSZip.loadAsync(file);
      const entries = Object.values(zip.files).filter(
        (f) => !f.dir && !/(^|\/)(__MACOSX|\.git|node_modules)\//.test(f.name) && !/(^|\/)\.DS_Store$/.test(f.name)
      );

      // Check for single root folder
      if (entries.length > 0) {
        const firstParts = entries.map((f) => f.name.split('/')[0]);
        if (entries.every((f) => f.name.includes('/')) && firstParts.every((s) => s === firstParts[0])) {
          entries.forEach((f) => {
            (f as unknown as { _unwrappedName: string })._unwrappedName = f.name.slice(firstParts[0].length + 1);
          });
        }
      }

      const out: ProjectFile[] = [];
      const textExts = /\.(html?|css|js|mjs|json|txt|md|xml|svg|ts|jsx|tsx|csv|yml|yaml)$/i;
      let hasIndexHtml = false;

      for (const f of entries) {
        const name = (f as unknown as { _unwrappedName?: string })._unwrappedName || f.name;
        if (!name) continue;
        if (name.toLowerCase() === 'index.html') {
          hasIndexHtml = true;
        }

        if (textExts.test(name)) {
          const content = await f.async('string');
          out.push({ name, content, mod: Date.now() });
        } else {
          const base64 = await f.async('base64');
          const ext = extOf(name);
          const mime =
            ext === 'png'
              ? 'image/png'
              : ext === 'jpg' || ext === 'jpeg'
              ? 'image/jpeg'
              : ext === 'svg'
              ? 'image/svg+xml'
              : 'application/octet-stream';
          out.push({
            name,
            content: '',
            media: true,
            data: `data:${mime};base64,${base64}`,
            size: Math.round(base64.length * 0.75),
            mod: Date.now(),
          });
        }
      }

      if (!hasIndexHtml) {
        const altHtml = out.find((f) => /\.html?$/i.test(f.name) && !f.media);
        if (altHtml) {
          out.unshift({
            name: 'index.html',
            content: altHtml.content,
            mod: Date.now(),
          });
          hasIndexHtml = true;
        } else {
          out.unshift({
            name: 'index.html',
            content: '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>App</title><style>body{font-family:sans-serif;background:#000;color:#fff;padding:24px;text-align:center;}h1{color:#0a84ff;}</style></head><body><h1>Web Application</h1><p>Your imported application is ready.</p></body></html>',
            mod: Date.now(),
          });
          hasIndexHtml = true;
        }
      }

      out.sort((a, b) => (a.name === 'index.html' ? -1 : b.name === 'index.html' ? 1 : a.name.localeCompare(b.name)));
      return out;
    } catch (err) {
      console.error('ZIP extraction error:', err);
      showToastNotification('Could not extract that ZIP file.');
      return null;
    }
  };

  // --- PROGRESS SHEET & REAL APK COMPILATION FLOW ---
  const [isProcessingApp, setIsProcessingApp] = useState(false);
  const [processStep, setProcessStep] = useState<1 | 2 | 3 | 4>(1); // 1: Uploading, 2: Preparing, 3: Building APK, 4: Ready
  const [processStatusText, setProcessStatusText] = useState('Uploading project...');
  const [processError, setProcessError] = useState<string | null>(null);
  const [processFailedInfo, setProcessFailedInfo] = useState<{
    error: string;
    hostedUrl?: string;
    fallbackUrl?: string;
    targetProj?: Project;
  } | null>(null);

  // The primary flow when user clicks "Create App" from any input
  const handleExecuteCreateApp = async () => {
    const name = createAppName.trim() || 'My App';
    setProcessError(null);
    setProcessFailedInfo(null);

    let projectFiles: ProjectFile[] = [];
    let externalUrl: string | undefined = undefined;

    if (inputTab === 'html') {
      if (!pastedHtml.trim()) {
        showToastNotification('Please paste your HTML code.');
        return;
      }
      projectFiles = [
        {
          name: 'index.html',
          content: pastedHtml,
          mod: Date.now(),
        },
      ];
    } else if (inputTab === 'zip') {
      if (!uploadedZipFile) {
        showToastNotification('Please choose a ZIP file.');
        return;
      }
      const extracted = await extractZipFiles(uploadedZipFile);
      if (!extracted) return;
      projectFiles = extracted;
    } else if (inputTab === 'url') {
      const trimmedUrl = websiteUrl.trim();
      if (!trimmedUrl) {
        showToastNotification('Please enter a website URL.');
        return;
      }
      if (!/^https:\/\//i.test(trimmedUrl)) {
        showToastNotification('Website URL must start with https://');
        return;
      }
      externalUrl = trimmedUrl;
      projectFiles = [
        {
          name: 'index.html',
          content: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${escHtml(name)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; overflow: hidden; background: #000; font-family: sans-serif; }
    iframe { border: 0; width: 100%; height: 100%; }
  </style>
</head>
<body>
  <iframe src="${escHtml(trimmedUrl)}" allow="fullscreen; geolocation; camera; microphone; autoplay"></iframe>
</body>
</html>`,
          mod: Date.now(),
        },
      ];
    }

    // Save as local project first for user library
    const pal = PAL[projects.length % PAL.length];
    const now = new Date();
    const newProj: Project = {
      id: `p_${Date.now()}`,
      name,
      created: fmt(now),
      updated: fmt(now),
      ts: now.getTime(),
      bg: `linear-gradient(160deg,${pal[0]},${pal[1]})`,
      files: projectFiles,
      img: createAppIconData,
      url: externalUrl,
    };
    await saveProject(newProj);
    setProjects((prev) => [newProj, ...prev]);

    // Close the input modal and open Progress Sheet
    setShowCreateAppDlg(false);
    await startCompilationPipeline(newProj);
  };

  // Compilation Pipeline with real Cloud API
  const startCompilationPipeline = async (targetProj: Project) => {
    setIsProcessingApp(true);
    setProcessError(null);
    setProcessFailedInfo(null);
    triggerHaptic(15);

    try {
      // Step 1: Uploading & Hosting
      setProcessStep(1);
      setProcessStatusText('Uploading & preparing cloud hosting...');

      let hostedUrl = targetProj.hostedUrl;
      let hostedId = targetProj.hostedId;

      // Always publish project files to cloud hosting if project has files
      if (targetProj.files && targetProj.files.length > 0) {
        const pubResult = await publishProjectToCloud(
          targetProj,
          targetProj.build?.spCol || '#0a84ff',
          targetProj.img
        );
        hostedUrl = pubResult.url;
        hostedId = pubResult.id;
        targetProj.hostedUrl = hostedUrl;
        targetProj.hostedId = hostedId;
        await saveProject(targetProj);
      } else if (!hostedUrl && targetProj.url) {
        hostedUrl = targetProj.url;
      }

      // Step 2: Preparing App & Manifest
      setProcessStep(2);
      setProcessStatusText('Configuring Android TWA manifest & icons...');
      await new Promise((r) => setTimeout(r, 600));

      // Step 3: Building Real Signed APK via Cloud
      setProcessStep(3);
      setProcessStatusText('Contacting PWABuilder Cloud to generate signed APK...');

      const cleanName = targetProj.name.replace(/[^a-zA-Z0-9_-]/g, '_');
      const slug = cleanName.toLowerCase();
      const pkg = targetProj.build?.pkg || `com.nfx.${/^[a-z]/.test(slug) ? slug : 'app' + slug}`;
      const vn = targetProj.build?.vn || '1.0.0';
      const vc = targetProj.build?.vc || '1';

      const buildRes = await buildApkViaCloud({
        id: hostedId,
        url: hostedUrl,
        name: targetProj.name,
        packageId: pkg,
        versionName: vn,
        versionCode: vc,
        themeColor: targetProj.build?.spCol || '#0a84ff',
        backgroundColor: '#000000',
        iconUrl: targetProj.img || undefined,
      });

      if (!buildRes.success || !buildRes.apkBase64) {
        const fbUrl = buildRes.fallbackUrl || `https://www.pwabuilder.com/?url=${encodeURIComponent(hostedUrl || '')}`;
        setProcessFailedInfo({
          error: buildRes.error || 'Cloud compiler service could not complete the APK build automatically.',
          hostedUrl: hostedUrl || buildRes.hostedUrl,
          fallbackUrl: fbUrl,
          targetProj,
        });
        throw new Error(buildRes.error || 'Cloud APK compiler encountered an issue.');
      }

      // Step 4: Ready!
      setProcessStep(4);
      setProcessStatusText('APK Compiled Successfully!');
      triggerHaptic(30);

      const now = new Date();
      const dateStr = `${MON[now.getMonth()]} ${now.getDate()}`;
      const newApkItem: APKItem = {
        id: `apk_${Date.now()}`,
        name: targetProj.name,
        bg: targetProj.bg,
        icon: targetProj.img
          ? `<img src="${targetProj.img}" class="w-full h-full object-cover"/>`
          : targetProj.icon || `<b class="ltr">${targetProj.name[0].toUpperCase()}</b>`,
        ver: vn,
        size: buildRes.apkSize || '2.4 MB',
        date: dateStr,
        built: true,
        projectId: targetProj.id,
        pkg,
        apkFileName: buildRes.apkFileName || `${cleanName}_v${vn}.apk`,
        hostedUrl,
        apkBase64: buildRes.apkBase64,
        signingKeyBase64: buildRes.signingKeyBase64,
        signingKeyFileName: buildRes.signingKeyFileName,
        fallbackUrl: buildRes.fallbackUrl,
      };

      await saveAPK(newApkItem);
      setApks((prev) => [newApkItem, ...prev]);

      // Open Ready APK Popup
      setIsProcessingApp(false);
      setReadyApkModalData({
        name: targetProj.name,
        version: vn,
        size: buildRes.apkSize || '2.4 MB',
        apkBase64: buildRes.apkBase64,
        apkFileName: buildRes.apkFileName || `${cleanName}_v${vn}.apk`,
        signingKeyBase64: buildRes.signingKeyBase64,
        signingKeyFileName: buildRes.signingKeyFileName,
        hostedUrl,
        fallbackUrl: buildRes.fallbackUrl,
        icon: targetProj.img,
      });

      // Automatically trigger download of the real signed .apk file!
      downloadBase64File(
        buildRes.apkBase64,
        buildRes.apkFileName || `${cleanName}_v${vn}.apk`,
        'application/vnd.android.package-archive'
      );
    } catch (err: unknown) {
      console.error(err);
      const msg = err instanceof Error ? err.message : 'Build failed';
      setProcessError(msg);
      triggerHaptic(40);
    }
  };

  // File Creation in Project view
  const [newFileName, setNewFileName] = useState('');
  const [newFileExt, setNewFileExt] = useState('html');
  const [newFileShake, setNewFileShake] = useState(false);

  const FILE_TEMPLATES: Record<string, (name: string) => string> = {
    html: (name) => `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <title>${name}</title>\n</head>\n<body>\n  <h1>${name}</h1>\n</body>\n</html>`,
    css: (name) => `/* Stylesheet: ${name} */\nbody {\n  margin: 0;\n  padding: 16px;\n}\n`,
    js: (name) => `// Script: ${name}\nconsole.log('Loaded: ${name}');\n`,
    json: () => `{\n  "version": "1.0.0"\n}\n`,
    xml: () => `<?xml version="1.0" encoding="UTF-8"?>\n<root>\n</root>\n`,
    txt: (name) => `Notes for ${name}\n`,
    '': () => ``,
  };

  const handleCreateFile = async () => {
    if (!activeProject) return;
    let n = newFileName.trim();
    if (!n) {
      setNewFileShake(true);
      setTimeout(() => setNewFileShake(false), 400);
      showToastNotification('Enter a file name');
      return;
    }
    if (newFileExt && !n.toLowerCase().endsWith(`.${newFileExt}`)) {
      n += `.${newFileExt}`;
    }
    if (activeProject.files.some((f) => f.name.toLowerCase() === n.toLowerCase())) {
      showToastNotification('That file already exists');
      return;
    }

    const tplGen = FILE_TEMPLATES[newFileExt] || FILE_TEMPLATES[''];
    const newFile: ProjectFile = {
      name: n,
      content: tplGen(n),
      mod: Date.now(),
    };
    const updatedFiles = [...activeProject.files, newFile];
    const now = new Date();
    const updatedProj: Project = {
      ...activeProject,
      files: updatedFiles,
      updated: fmt(now),
      ts: now.getTime(),
    };

    setActiveProject(updatedProj);
    await saveProject(updatedProj);
    setProjects((prev) => prev.map((p) => (p.id === updatedProj.id ? updatedProj : p)));
    setShowCreateFileDlg(false);
    setNewFileName('');
    showToastNotification(`File ${n} created`);

    setActiveFileIndex(updatedFiles.length - 1);
    setIsFileEditorOpen(true);
    triggerHaptic(12);
  };

  // Import files
  const mediaImportRef = useRef<HTMLInputElement>(null);
  const otherImportRef = useRef<HTMLInputElement>(null);

  const handleImportFiles = async (fileList: FileList, isMedia: boolean) => {
    if (!activeProject) return;
    let count = 0;
    const newFiles: ProjectFile[] = [];

    for (let i = 0; i < fileList.length; i++) {
      const f = fileList[i];
      let uniqueName = f.name;
      let counter = 2;
      const dotIdx = f.name.lastIndexOf('.');
      const base = dotIdx > 0 ? f.name.slice(0, dotIdx) : f.name;
      const ext = dotIdx > 0 ? f.name.slice(dotIdx) : '';

      while (
        activeProject.files.some((x) => x.name.toLowerCase() === uniqueName.toLowerCase()) ||
        newFiles.some((x) => x.name.toLowerCase() === uniqueName.toLowerCase())
      ) {
        uniqueName = `${base} (${counter})${ext}`;
        counter++;
      }

      if (isMedia) {
        const dataUrl = await new Promise<string>((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(r.result as string);
          r.onerror = rej;
          r.readAsDataURL(f);
        });
        newFiles.push({
          name: uniqueName,
          content: '',
          media: true,
          data: dataUrl,
          size: f.size,
          mod: Date.now(),
        });
        count++;
      } else {
        const textContent = await new Promise<string>((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(r.result as string);
          r.onerror = rej;
          r.readAsText(f);
        });
        newFiles.push({
          name: uniqueName,
          content: textContent,
          mod: Date.now(),
        });
        count++;
      }
    }

    if (count > 0) {
      const now = new Date();
      const updatedProj: Project = {
        ...activeProject,
        files: [...activeProject.files, ...newFiles],
        updated: fmt(now),
        ts: now.getTime(),
      };
      setActiveProject(updatedProj);
      await saveProject(updatedProj);
      setProjects((prev) => prev.map((p) => (p.id === updatedProj.id ? updatedProj : p)));
      showToastNotification(`${count} ${count > 1 ? 'files' : 'file'} imported`);
      setShowImportDlg(false);
      triggerHaptic(12);
    }
  };

  // Search
  const [fileSearchQuery, setFileSearchQuery] = useState('');
  const [showFileSearchBar, setShowFileSearchBar] = useState(false);
  const filteredFiles = useMemo(() => {
    if (!activeProject) return [];
    const q = fileSearchQuery.trim().toLowerCase();
    return activeProject.files
      .map((f, i) => ({ file: f, index: i }))
      .filter((item) => !q || item.file.name.toLowerCase().includes(q));
  }, [activeProject, fileSearchQuery]);

  // Code editor
  const [editorValue, setEditorValue] = useState('');
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 });
  const [isEditorDirty, setIsEditorDirty] = useState(false);
  const codeTextareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightPreRef = useRef<HTMLPreElement>(null);
  const gutterPreRef = useRef<HTMLPreElement>(null);
  const autoSaveTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (activeProject && activeProject.files[activeFileIndex]) {
      const f = activeProject.files[activeFileIndex];
      setEditorValue(f.content || '');
      setIsEditorDirty(false);
      setCursorPos({ line: 1, col: 1 });
    }
  }, [activeProject?.id, activeFileIndex]);

  const handleEditorInput = (val: string) => {
    setEditorValue(val);
    setIsEditorDirty(true);
    if (activeProject) {
      activeProject.files[activeFileIndex].content = val;
      activeProject.files[activeFileIndex].mod = Date.now();
    }
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => {
      handleSaveFile(true);
    }, 1200);
  };

  const syncEditorScroll = () => {
    if (!codeTextareaRef.current || !highlightPreRef.current || !gutterPreRef.current) return;
    const x = -codeTextareaRef.current.scrollLeft;
    const y = -codeTextareaRef.current.scrollTop;
    highlightPreRef.current.style.transform = `translate(${x}px, ${y}px)`;
    gutterPreRef.current.style.transform = `translateY(${y}px)`;
  };

  const updateCursorPosition = () => {
    if (!codeTextareaRef.current) return;
    const pos = codeTextareaRef.current.selectionStart;
    const val = codeTextareaRef.current.value.slice(0, pos);
    const lines = val.split('\n');
    setCursorPos({
      line: lines.length,
      col: lines[lines.length - 1].length + 1,
    });
  };

  const handleSaveFile = async (silent = false) => {
    if (!activeProject) return;
    const now = new Date();
    const updated: Project = {
      ...activeProject,
      updated: fmt(now),
      ts: now.getTime(),
    };
    setActiveProject(updated);
    await saveProject(updated);
    setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    setIsEditorDirty(false);
    if (!silent) {
      showToastNotification('Saved');
      triggerHaptic(10);
    }
  };

  const insertSymbol = (text: string) => {
    const ta = codeTextareaRef.current;
    if (!ta) return;
    ta.focus();
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const val = ta.value;
    const nextVal = val.substring(0, start) + text + val.substring(end);
    handleEditorInput(nextVal);
    setTimeout(() => {
      ta.selectionStart = ta.selectionEnd = start + text.length;
      updateCursorPosition();
    }, 10);
  };

  // Preview builder
  const buildProjectPreviewHtml = (homePage?: string, proj?: Project): string => {
    const target = proj || activeProject;
    if (!target) return '';
    const files = target.files;
    const getFile = (n: string) => files.find((f) => f.name === n.replace(/^\.\//, '') && !f.media);
    const entry =
      (homePage && getFile(homePage)) ||
      getFile('index.html') ||
      files.find((f) => /\.html?$/i.test(f.name) && !f.media);

    if (!entry) return '<body style="font-family:sans-serif;padding:20px;color:#888;">No HTML file found.</body>';
    let html = entry.content;

    html = html.replace(/<link[^>]*href=["']([^"']+)["'][^>]*>/gi, (match, url) => {
      const f = getFile(url);
      if (f && /\.css$/i.test(url)) {
        return `<style>\n${f.content}\n</style>`;
      }
      return match;
    });

    html = html.replace(/<script([^>]*?)src=["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (match, before, url, after) => {
      const f = getFile(url);
      if (f) {
        return `<script${before}${after}>\n${f.content.replace(/<\/script/gi, '<\\/script')}\n</script>`;
      }
      return match;
    });

    files
      .filter((f) => f.media && f.data)
      .forEach((f) => {
        html = html.split(`"${f.name}"`).join(`"${f.data}"`).split(`'${f.name}'`).join(`'${f.data}'`);
      });

    return html;
  };

  // Build APK configuration screen
  const [buildMode, setBuildMode] = useState<'app' | 'splash' | 'home'>('app');
  const [bName, setBName] = useState('');
  const [bPkg, setBPkg] = useState('');
  const [bVn, setBVn] = useState('1.0.0');
  const [bVc, setBVc] = useState('1');
  const [bHome, setBHome] = useState('index.html');
  const [bSpOn, setBSpOn] = useState(false);
  const [bSpCol, setBSpCol] = useState('#0a84ff');
  const [bSpDur, setBSpDur] = useState('2');
  const [bIcon, setBIcon] = useState<string | null>(null);
  const [bSpImg, setBSpImg] = useState<string | null>(null);
  const bIconInputRef = useRef<HTMLInputElement>(null);
  const bSpImgInputRef = useRef<HTMLInputElement>(null);

  // Delete an APK item
  const handleDeleteApk = (id: string, name: string) => {
    triggerHaptic(20);
    setAlertConfig({
      show: true,
      title: `Delete ${name}?`,
      msg: 'This APK record will be removed from your library.',
      input: null,
      okText: 'Delete',
      danger: true,
      onConfirm: async (confirmed) => {
        if (confirmed) {
          await deleteAPKDB(id);
          setApks((prev) => prev.filter((a) => a.id !== id));
          showToastNotification('APK record deleted');
        }
      },
    });
  };

  const openBuildStudio = () => {
    if (!activeProject) return;
    const htmls = activeProject.files.filter((f) => !f.media && /\.html?$/i.test(f.name));
    if (htmls.length === 0) {
      showToastNotification('Add an HTML file first');
      return;
    }
    const b = activeProject.build || ({} as Partial<BuildConfig>);
    const slug = activeProject.name.toLowerCase().replace(/[^a-z0-9]/g, '') || 'app';
    setBName(b.name || activeProject.name);
    setBPkg(b.pkg || `com.nfx.${/^[a-z]/.test(slug) ? slug : 'app' + slug}`);
    setBVn(b.vn || '1.0.0');
    setBVc(b.vc || '1');
    setBHome(b.home && htmls.some((h) => h.name === b.home) ? b.home : htmls[0].name);
    setBSpOn(!!b.spOn);
    setBSpCol(b.spCol || '#0a84ff');
    setBSpDur(b.spDur || '2');
    setBIcon(b.icon || activeProject.img || null);
    setBSpImg(b.spImg || null);
    setBuildMode('app');
    setIsBuildOpen(true);
  };

  // Trigger build from current project configuration
  const handleBuildFromCurrentProject = async () => {
    if (!activeProject) return;
    const name = bName.trim() || activeProject.name;
    const buildConfig: BuildConfig = {
      name,
      pkg: bPkg.trim(),
      vn: bVn.trim(),
      vc: String(bVc).trim(),
      home: bHome,
      spOn: bSpOn,
      spCol: bSpCol,
      spDur: bSpDur,
      icon: bIcon,
      spImg: bSpImg,
    };
    activeProject.build = buildConfig;
    await saveProject(activeProject);
    setProjects((prev) => prev.map((p) => (p.id === activeProject.id ? { ...activeProject } : p)));

    setIsBuildOpen(false);
    await startCompilationPipeline(activeProject);
  };

  // Copy URL to clipboard
  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    showToastNotification('Link copied to clipboard!');
    triggerHaptic(12);
  };

  const lineNumbers = useMemo(() => {
    const count = editorValue.split('\n').length;
    return Array.from({ length: count }, (_, i) => i + 1).join('\n');
  }, [editorValue]);

  const currentEditorFile = activeProject?.files[activeFileIndex];

  return (
    <div className="relative min-h-[100dvh] text-[var(--text)] bg-[var(--bg)] font-sans antialiased select-none">
      {/* Top Blurred Header */}
      <header className={`nav ${scrolled || activeTab !== 'home' ? 'solid' : ''}`}>
        <div className="nav-in">
          <div className="nav-title">
            {activeTab === 'home'
              ? 'NFX STUDIO'
              : activeTab === 'projects'
              ? 'Projects'
              : activeTab === 'apk'
              ? 'Built APKs'
              : 'Settings'}
          </div>
          <div className="flex items-center gap-2">
            {isInstallable && (
              <button
                onClick={() => {
                  triggerHaptic(15);
                  installApp();
                }}
                className="flex items-center gap-1.5 h-8 px-3 rounded-full bg-[var(--blue)] text-white text-xs font-semibold shadow-sm transition hover:opacity-90"
              >
                <svg className="ic w-3.5 h-3.5" viewBox="0 0 24 24">
                  <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Install
              </button>
            )}
            {isIOS && !isInstalled && (
              <button
                onClick={() => setShowIOSInstallGuide(true)}
                className="flex items-center gap-1.5 h-8 px-3 rounded-full bg-[var(--fill)] text-[var(--blue)] text-xs font-semibold transition"
              >
                Install App
              </button>
            )}
            <button
              onClick={() => {
                triggerHaptic(10);
                showToastNotification('NFX Studio v3.2 · Cloud APK & PWA');
              }}
              className="profile-btn press"
              aria-label="Profile"
            >
              <svg className="ic w-5 h-5" viewBox="0 0 24 24">
                <circle cx="12" cy="8" r="4" />
                <path d="M20 21v-1a5 5 0 0 0-5-5H9a5 5 0 0 0-5 5v1" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      {/* Offline Status Badge */}
      {!isOnline && (
        <div className="offline-banner">
          <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
          Offline Mode · Saved data is active
        </div>
      )}

      {/* Main Content Area */}
      <main className="app-container">
        {activeTab === 'home' && (
          <div className="page-anim">
            <div className="large-title">NFX STUDIO</div>

            {/* In-app Install banner if mobile user has not installed yet */}
            {!isInstalled && isInstallable && (
              <div className="install-card">
                <div className="w-10 h-10 rounded-xl bg-white shadow-md grid place-items-center flex-none">
                  <img src="/icon.svg" alt="NFX" className="w-7 h-7" />
                </div>
                <div className="install-card-info">
                  <h4>Install NFX STUDIO</h4>
                  <p>Add to your home screen for an edge-to-edge native Android experience.</p>
                </div>
                <button
                  onClick={() => {
                    triggerHaptic(20);
                    installApp();
                  }}
                  className="install-card-btn press"
                >
                  Install
                </button>
              </div>
            )}

            {/* Hero Card */}
            <div className="hero mt-1">
              <h1>Build Your Next Project</h1>
              <button
                onClick={() => {
                  triggerHaptic(15);
                  resetCreateAppForm();
                  setShowCreateAppDlg(true);
                }}
                className="cta press"
              >
                <svg className="ic w-5 h-5" viewBox="0 0 24 24" style={{ strokeWidth: 2.25 }}>
                  <path d="M12 5v14M5 12h14" />
                </svg>
                Create App
              </button>
            </div>

            {/* Recent Projects Rail or Clean Slate Empty State */}
            <div className="sec">
              <h2>Recent Projects</h2>
              {projects.length > 0 && (
                <button
                  onClick={() => {
                    triggerHaptic(10);
                    setActiveTab('projects');
                  }}
                  className="more"
                >
                  See All
                </button>
              )}
            </div>

            {projects.length > 0 ? (
              <div className="rail">
                {projects.slice(0, 6).map((proj) => (
                  <article
                    key={proj.id}
                    onClick={() => {
                      triggerHaptic(15);
                      setActiveProject(proj);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      triggerHaptic(25);
                      setAlertConfig({
                        show: true,
                        title: `Delete ${proj.name}?`,
                        msg: 'This project and all its files will be permanently deleted.',
                        input: null,
                        okText: 'Delete',
                        danger: true,
                        onConfirm: async (confirmed) => {
                          if (confirmed) {
                            await deleteProjectDB(proj.id);
                            setProjects((prev) => prev.filter((p) => p.id !== proj.id));
                            showToastNotification('Project deleted');
                          }
                        },
                      });
                    }}
                    className="pcard"
                  >
                    <div className="ptop" style={{ background: proj.bg }}>
                      <div className="pic">{renderProjectIcon(proj)}</div>
                    </div>
                    <div className="pbody">
                      <h3>{proj.name}</h3>
                      <div className="dates">
                        <div>
                          <small>CREATED</small>
                          <b>{proj.created}</b>
                        </div>
                        <div>
                          <small>LAST UPDATED</small>
                          <b>{proj.updated}</b>
                        </div>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-card">
                <div className="empty-card-icon">
                  <svg className="ic w-7 h-7" viewBox="0 0 24 24">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </div>
                <h3>No Projects Yet</h3>
                <p>Paste HTML code, upload any ZIP file, or enter a website URL to create your first mobile app.</p>
                <button
                  onClick={() => {
                    triggerHaptic(15);
                    resetCreateAppForm();
                    setShowCreateAppDlg(true);
                  }}
                  className="cta press mx-auto"
                >
                  + Create App
                </button>
              </div>
            )}
          </div>
        )}

        {/* Tab: All Projects */}
        {activeTab === 'projects' && (
          <div className="page-anim">
            <div className="sec" style={{ marginTop: 4 }}>
              <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--sub)]">
                All Projects
              </h2>
              <small>{projects.length} {projects.length === 1 ? 'Project' : 'Projects'}</small>
            </div>

            {projects.length > 0 ? (
              <div className="ios-list">
                {projects.map((proj) => (
                  <article
                    key={proj.id}
                    onClick={() => {
                      triggerHaptic(15);
                      setActiveProject(proj);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      triggerHaptic(25);
                      setAlertConfig({
                        show: true,
                        title: `Delete ${proj.name}?`,
                        msg: 'This project and all its files will be permanently deleted.',
                        input: null,
                        okText: 'Delete',
                        danger: true,
                        onConfirm: async (confirmed) => {
                          if (confirmed) {
                            await deleteProjectDB(proj.id);
                            setProjects((prev) => prev.filter((p) => p.id !== proj.id));
                            showToastNotification('Project deleted');
                          }
                        },
                      });
                    }}
                    className="item"
                  >
                    <div className="logo" style={{ background: proj.bg }}>
                      {renderProjectIcon(proj)}
                    </div>
                    <div className="info">
                      <h3>{proj.name}</h3>
                      <div className="meta">Updated {proj.updated} · {proj.files.length} files</div>
                    </div>
                    <svg className="chev w-5 h-5" viewBox="0 0 24 24">
                      <path className="ic" d="M9 5l7 7-7 7" style={{ strokeWidth: 2.25 }} />
                    </svg>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-card">
                <div className="empty-card-icon">
                  <svg className="ic w-7 h-7" viewBox="0 0 24 24">
                    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" />
                  </svg>
                </div>
                <h3>No Projects Found</h3>
                <p>Your studio library is clean and ready. Tap below to begin creating your first app.</p>
                <button
                  onClick={() => {
                    triggerHaptic(15);
                    resetCreateAppForm();
                    setShowCreateAppDlg(true);
                  }}
                  className="primary-btn press max-w-[220px] mx-auto h-11 text-base"
                >
                  + Create App
                </button>
              </div>
            )}
            {projects.length > 0 && (
              <p className="foot text-center mt-3">Hold on any project row to delete.</p>
            )}
          </div>
        )}

        {/* Tab: APK Library */}
        {activeTab === 'apk' && (
          <div className="page-anim">
            <div className="sec" style={{ marginTop: 4 }}>
              <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--sub)]">
                Built APKs
              </h2>
              <small>{apks.length} {apks.length === 1 ? 'APK' : 'APKs'}</small>
            </div>

            {apks.length > 0 ? (
              <div className="flex flex-col">
                {apks.map((apk) => (
                  <div key={apk.id} className="apk-card">
                    <div className="apk-card-header">
                      <div
                        className="logo"
                        style={{ background: apk.bg }}
                        dangerouslySetInnerHTML={{ __html: apk.icon }}
                      />
                      <div className="info">
                        <h3>{apk.name}</h3>
                        <div className="meta">v{apk.ver} · {apk.size} · {apk.date}</div>
                      </div>
                      <button
                        onClick={() => handleDeleteApk(apk.id, apk.name)}
                        className="apk-del-btn"
                        title="Delete APK"
                      >
                        <svg className="ic w-4 h-4" viewBox="0 0 24 24">
                          <path d="M18 6L6 18M6 6l12 12" />
                        </svg>
                      </button>
                    </div>

                    {/* 3-Action Buttons Row: DOWNLOAD, INSTALL, OPEN */}
                    <div className="apk-actions-row">
                      <button
                        onClick={() => {
                          if (apk.apkBase64) {
                            downloadBase64File(
                              apk.apkBase64,
                              apk.apkFileName || `${apk.name}_v${apk.ver}.apk`,
                              'application/vnd.android.package-archive'
                            );
                            showToastNotification('Downloading APK...');
                          } else {
                            // Re-call cloud compiler
                            const p = projects.find((x) => x.id === apk.projectId);
                            if (p) startCompilationPipeline(p);
                            else showToastNotification('Project files not found.');
                          }
                        }}
                        className="apk-act-btn download press"
                        title="Download real Android .apk file"
                      >
                        <svg className="ic w-3.5 h-3.5" viewBox="0 0 24 24">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                          <polyline points="7 10 12 15 17 10" />
                          <line x1="12" y1="15" x2="12" y2="3" />
                        </svg>
                        <span>Download</span>
                      </button>

                      <button
                        onClick={() => {
                          triggerHaptic(15);
                          if (isInstallable) {
                            installApp();
                          } else if (apk.hostedUrl) {
                            window.open(apk.hostedUrl, '_blank');
                          } else {
                            showToastNotification('Tap browser menu (⋮) -> "Add to Home Screen"');
                          }
                        }}
                        className="apk-act-btn install press"
                        title="Install app to Home Screen"
                      >
                        <svg className="ic w-3.5 h-3.5" viewBox="0 0 24 24">
                          <rect x="5" y="2" width="14" height="20" rx="2" />
                          <line x1="12" y1="18" x2="12.01" y2="18" />
                        </svg>
                        <span>Install</span>
                      </button>

                      <button
                        onClick={() => {
                          triggerHaptic(15);
                          const p = projects.find((x) => x.id === apk.projectId);
                          const html = p ? buildProjectPreviewHtml(p.build?.home || 'index.html', p) : '';
                          setRunningApp({
                            name: apk.name,
                            html,
                            url: apk.hostedUrl,
                          });
                        }}
                        className="apk-act-btn open press"
                        title="Open and run app fullscreen"
                      >
                        <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
                          <path d="M8 5v14l11-7z" />
                        </svg>
                        <span>Open</span>
                      </button>
                    </div>

                    {/* Hosted Link Bar */}
                    {apk.hostedUrl && (
                      <div className="mt-2.5 pt-2 border-t border-[var(--line)] flex items-center justify-between text-xs text-[var(--sub)]">
                        <span className="truncate max-w-[200px]">{apk.hostedUrl}</span>
                        <button
                          onClick={() => copyToClipboard(apk.hostedUrl!)}
                          className="text-[var(--blue)] font-semibold flex items-center gap-1"
                        >
                          Copy Link
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-card">
                <div className="empty-card-icon">
                  <svg className="ic w-7 h-7" viewBox="0 0 24 24">
                    <path d="M21 8l-9-5-9 5v8l9 5 9-5z" />
                    <path d="M3.3 7.5L12 12.5l8.7-5M12 22V12.5" />
                  </svg>
                </div>
                <h3>No APKs Built Yet</h3>
                <p>Generate authentic Android APK packages with 1-click Download, Install, and Open.</p>
                <button
                  onClick={() => {
                    triggerHaptic(15);
                    resetCreateAppForm();
                    setShowCreateAppDlg(true);
                  }}
                  className="primary-btn press max-w-[220px] mx-auto h-11 text-base"
                >
                  + Create App
                </button>
              </div>
            )}
            {apks.length > 0 && (
              <p className="foot">
                Tap <strong>Download</strong> for the signed .apk, <strong>Install</strong> for PWA, or <strong>Open</strong> to run fullscreen.
              </p>
            )}
          </div>
        )}

        {/* Tab: Settings */}
        {activeTab === 'settings' && (
          <div className="page-anim">
            <div className="ios-list">
              <div className="row">
                <i style={{ background: '#5856d6' }}>
                  <svg className="ic w-4 h-4" viewBox="0 0 24 24" style={{ strokeWidth: 2 }}>
                    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z" />
                  </svg>
                </i>
                <span>Dark Mode</span>
                <button
                  onClick={() => {
                    triggerHaptic(15);
                    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
                  }}
                  className={`sw ${theme === 'dark' ? 'on' : ''}`}
                  role="switch"
                  aria-checked={theme === 'dark'}
                  aria-label="Dark Mode"
                />
              </div>

              {/* Install PWA Option */}
              <div
                onClick={() => {
                  triggerHaptic(15);
                  if (isInstallable) {
                    installApp();
                  } else if (isIOS) {
                    setShowIOSInstallGuide(true);
                  } else if (isInstalled) {
                    showToastNotification('NFX Studio is running in standalone mode!');
                  } else {
                    showToastNotification('Tap browser menu (⋮) -> "Add to Home Screen"');
                  }
                }}
                className="row cursor-pointer"
              >
                <i style={{ background: '#007aff' }}>
                  <svg className="ic w-4 h-4" viewBox="0 0 24 24">
                    <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                </i>
                <div className="flex-1">
                  <div className="text-[17px] tracking-[-0.4px]">Install PWA to Mobile</div>
                  <div className="text-xs text-[var(--sub)]">
                    {isInstalled
                      ? 'Running as standalone app'
                      : isInstallable
                      ? 'Ready to install directly'
                      : isIOS
                      ? 'Tap for iOS Safari instructions'
                      : 'Browser installable'}
                  </div>
                </div>
                <svg className="chev w-5 h-5" viewBox="0 0 24 24">
                  <path className="ic" d="M9 5l7 7-7 7" style={{ strokeWidth: 2.25 }} />
                </svg>
              </div>

              {/* Storage Indicator */}
              <div className="row">
                <i style={{ background: isOnline ? '#34c759' : '#ff9f0a' }}>
                  <svg className="ic w-4 h-4" viewBox="0 0 24 24">
                    <path d="M5 12.55a11 11 0 0 1 14.08 0" />
                    <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
                    <line x1="12" y1="20" x2="12.01" y2="20" />
                  </svg>
                </i>
                <span>IndexedDB Storage</span>
                <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-[var(--fill)] text-[var(--blue)]">
                  Active (No 5MB limit)
                </span>
              </div>
            </div>

            <div className="ios-list mt-5">
              <div className="row">
                <i style={{ background: '#30d158' }}>
                  <svg className="ic w-4 h-4" viewBox="0 0 24 24">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                    <polyline points="22 4 12 14.01 9 11.01" />
                  </svg>
                </i>
                <span>NFX STUDIO Version</span>
                <span className="text-sm text-[var(--sub)]">v3.2.0 (PWABuilder Cloud)</span>
              </div>

              {projects.length > 0 && (
                <div
                  onClick={() => {
                    triggerHaptic(15);
                    setAlertConfig({
                      show: true,
                      title: 'Clear All Data?',
                      msg: 'This will delete all stored projects and built APK records.',
                      input: null,
                      okText: 'Clear All',
                      danger: true,
                      onConfirm: async (ok) => {
                        if (ok) {
                          await clearAllProjects();
                          await clearAllAPKs();
                          setProjects([]);
                          setApks([]);
                          showToastNotification('All projects and APKs cleared');
                        }
                      },
                    });
                  }}
                  className="row cursor-pointer"
                >
                  <i style={{ background: '#ff453a' }}>
                    <svg className="ic w-4 h-4" viewBox="0 0 24 24">
                      <path d="M3 6h18" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </i>
                  <span className="text-[var(--red)]">Clear All Local Data</span>
                </div>
              )}
            </div>

            <p className="foot text-center mt-3">NFX STUDIO · Client-side Virtual Mobile IDE & PWA</p>
          </div>
        )}
      </main>

      {/* Bottom iOS Tabbar */}
      <nav className="tabbar">
        <div>
          <button
            onClick={() => {
              triggerHaptic(10);
              setActiveTab('home');
            }}
            className={`press ${activeTab === 'home' ? 'on' : ''}`}
          >
            <svg className="ic w-6 h-6" viewBox="0 0 24 24">
              <path
                className="f"
                d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"
              />
            </svg>
            Home
          </button>
          <button
            onClick={() => {
              triggerHaptic(10);
              setActiveTab('projects');
            }}
            className={`press ${activeTab === 'projects' ? 'on' : ''}`}
          >
            <svg className="ic w-6 h-6" viewBox="0 0 24 24">
              <path
                className="f"
                d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"
              />
            </svg>
            Projects
          </button>
          <button
            onClick={() => {
              triggerHaptic(10);
              setActiveTab('apk');
            }}
            className={`press ${activeTab === 'apk' ? 'on' : ''}`}
          >
            <svg className="ic w-6 h-6" viewBox="0 0 24 24">
              <path className="f" d="M21 8l-9-5-9 5v8l9 5 9-5z" />
              <path d="M3.3 7.5L12 12.5l8.7-5M12 22V12.5" />
            </svg>
            APK
          </button>
          <button
            onClick={() => {
              triggerHaptic(10);
              setActiveTab('settings');
            }}
            className={`press ${activeTab === 'settings' ? 'on' : ''}`}
          >
            <svg className="ic w-6 h-6" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
            </svg>
            Settings
          </button>
        </div>
      </nav>

      {/* --- NEW "CREATE APP" ENTRY SCREEN (3 INPUT TABS) --- */}
      <div
        className={`scrim ${showCreateAppDlg ? 'on' : ''}`}
        onClick={() => setShowCreateAppDlg(false)}
      />
      <div className="wrap">
        <div className={`dlg ${showCreateAppDlg ? 'on' : ''}`}>
          <h3>Create App</h3>
          <p className="sub">Paste HTML, upload a ZIP, or enter a website URL.</p>

          {/* 3 Input Tabs */}
          <div className="modal-tabs">
            <button
              type="button"
              onClick={() => {
                triggerHaptic(8);
                setInputTab('html');
              }}
              className={`modal-tab-btn ${inputTab === 'html' ? 'on' : ''}`}
            >
              Paste HTML
            </button>
            <button
              type="button"
              onClick={() => {
                triggerHaptic(8);
                setInputTab('zip');
              }}
              className={`modal-tab-btn ${inputTab === 'zip' ? 'on' : ''}`}
            >
              Upload ZIP
            </button>
            <button
              type="button"
              onClick={() => {
                triggerHaptic(8);
                setInputTab('url');
              }}
              className={`modal-tab-btn ${inputTab === 'url' ? 'on' : ''}`}
            >
              Website URL
            </button>
          </div>

          {/* App Icon Picker */}
          <button
            onClick={() => iconInputRef.current?.click()}
            className={`picker press ${createAppIconData ? 'has' : ''}`}
            aria-label="Choose icon"
          >
            {createAppIconData ? (
              <img src={createAppIconData} alt="Chosen icon" />
            ) : (
              <span className="ph">
                <svg className="ic w-7 h-7" viewBox="0 0 24 24">
                  <rect x="3" y="4" width="18" height="16" rx="3" />
                  <circle cx="9" cy="10" r="1.8" />
                  <path d="M21 16l-5-5-8 8" />
                </svg>
                App Icon
              </span>
            )}
          </button>
          <div className="cap">App Icon (optional)</div>

          {/* App Name */}
          <div className={`grp ${createAppShake ? 'shake' : ''}`}>
            <input
              type="text"
              placeholder="Application Name"
              value={createAppName}
              onChange={(e) => setCreateAppName(e.target.value)}
              maxLength={40}
              autoComplete="off"
              autoCapitalize="words"
            />
          </div>

          {/* Tab 1: Paste HTML */}
          {inputTab === 'html' && (
            <div className="grp">
              <textarea
                rows={5}
                className="w-full p-3 font-mono text-xs bg-transparent border-0 outline-none text-[var(--text)] resize-none"
                placeholder="Paste your HTML code here..."
                value={pastedHtml}
                onChange={(e) => setPastedHtml(e.target.value)}
                spellCheck="false"
              />
            </div>
          )}

          {/* Tab 2: Upload ZIP */}
          {inputTab === 'zip' && (
            <div className="grp">
              <button
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest('.x')) {
                    setUploadedZipFile(null);
                    setUploadedZipName('Select ZIP file (max 20 MB)');
                    return;
                  }
                  zipInputRef.current?.click();
                }}
                type="button"
                className={`zrow ${uploadedZipFile ? 'has' : ''}`}
              >
                <i>
                  <svg className="ic w-4 h-4" viewBox="0 0 24 24">
                    <path d="M21 8v13H3V8M1 3h22v5H1zM10 12h4" />
                  </svg>
                </i>
                <span>
                  <b>ZIP File</b>
                  <small>{uploadedZipName}</small>
                </span>
                <em className="x">
                  <svg className="ic w-3.5 h-3.5" viewBox="0 0 24 24" style={{ strokeWidth: 2.5 }}>
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </em>
                {!uploadedZipFile && (
                  <svg className="chev w-4 h-4" viewBox="0 0 24 24">
                    <path className="ic" d="M9 5l7 7-7 7" />
                  </svg>
                )}
              </button>
            </div>
          )}

          {/* Tab 3: Website URL */}
          {inputTab === 'url' && (
            <div>
              <div className="grp">
                <input
                  type="url"
                  inputMode="url"
                  placeholder="https://yourwebsite.com"
                  value={websiteUrl}
                  onChange={(e) => setWebsiteUrl(e.target.value)}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck="false"
                  autoComplete="off"
                />
              </div>
              <p className="text-[11px] text-[var(--sub)] leading-tight mb-2 text-left">
                ⚠️ Notice: The website must be https:// and allow being opened normally in Chrome without frame blocks.
              </p>
            </div>
          )}

          {/* Reuse existing projects */}
          {projects.length > 0 && (
            <div className="mt-2 mb-3 pt-2 border-t border-[var(--line)]">
              <button
                type="button"
                onClick={() => {
                  setShowCreateAppDlg(false);
                  setActiveProject(projects[0]);
                  openBuildStudio();
                }}
                className="w-full text-xs text-[var(--blue)] font-semibold py-1"
              >
                Or build from an existing project ({projects.length} available) →
              </button>
            </div>
          )}

          <button
            onClick={handleExecuteCreateApp}
            className="primary-btn press mt-2"
          >
            Create App
          </button>
          <button
            onClick={() => setShowCreateAppDlg(false)}
            type="button"
            className="plain-btn"
          >
            Cancel
          </button>

          <input
            type="file"
            ref={iconInputRef}
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleIconUpload(f);
              e.target.value = '';
            }}
          />
          <input
            type="file"
            ref={zipInputRef}
            accept=".zip,application/zip,application/x-zip-compressed"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleZipFileSelected(f);
              e.target.value = '';
            }}
          />
        </div>
      </div>

      {/* --- PROGRESS SHEET (Uploading → Preparing → Building APK → Ready) --- */}
      <div
        className={`scrim ${isProcessingApp ? 'on' : ''}`}
        style={{ zIndex: 85 }}
      />
      <div className="wrap" style={{ zIndex: 86, pointerEvents: isProcessingApp ? 'auto' : 'none' }}>
        <div className={`dlg ${isProcessingApp ? 'on' : ''}`} style={{ width: 'min(100%, 340px)' }}>
          <h3>{processError ? 'Build Issue' : 'Creating Your App'}</h3>
          <p className="sub text-xs">
            {processError ? 'An error occurred during build:' : processStatusText}
          </p>

          {!processError ? (
            <div>
              {/* 4 Steps Indicator */}
              <div className="prog-steps">
                <div className={`prog-step ${processStep >= 1 ? (processStep > 1 ? 'done' : 'active') : ''}`}>
                  <div className="prog-step-dot" />
                  <span>Upload</span>
                </div>
                <div className={`prog-step ${processStep >= 2 ? (processStep > 2 ? 'done' : 'active') : ''}`}>
                  <div className="prog-step-dot" />
                  <span>Prepare</span>
                </div>
                <div className={`prog-step ${processStep >= 3 ? (processStep > 3 ? 'done' : 'active') : ''}`}>
                  <div className="prog-step-dot" />
                  <span>Build APK</span>
                </div>
                <div className={`prog-step ${processStep >= 4 ? 'done' : ''}`}>
                  <div className="prog-step-dot" />
                  <span>Ready</span>
                </div>
              </div>

              <div className="prg mt-4 mb-2">
                <i style={{ width: `${(processStep / 4) * 100}%` }} />
              </div>
              <p className="text-[11px] text-[var(--sub)] text-center">
                Please wait while Cloud compiles your signed Android package...
              </p>
            </div>
          ) : (
            <div>
              <div className="p-3 my-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-xs text-left leading-relaxed">
                {processError}
              </div>

              {processFailedInfo?.fallbackUrl && (
                <div className="mb-3 space-y-2">
                  <p className="text-[11px] text-[var(--sub)] text-left">
                    Cloud compile encountered an issue. You can still generate your signed APK instantly via official PWABuilder:
                  </p>
                  <a
                    href={processFailedInfo.fallbackUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="primary-btn press w-full h-10 text-xs font-semibold flex items-center justify-center gap-2 no-underline text-white shadow-sm"
                  >
                    <span>⚡ Open PWABuilder (1-Click APK)</span>
                  </a>
                  {processFailedInfo.hostedUrl && (
                    <button
                      onClick={() => copyToClipboard(processFailedInfo.hostedUrl!)}
                      className="plain-btn w-full h-9 text-xs flex items-center justify-center gap-1.5"
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                      <span>Copy Hosted Web App URL</span>
                    </button>
                  )}
                </div>
              )}

              <div className="flex gap-2">
                <button
                  onClick={() => {
                    const target = processFailedInfo?.targetProj || (projects.length > 0 ? projects[0] : null);
                    if (target) {
                      startCompilationPipeline(target);
                    }
                  }}
                  className="primary-btn press flex-1 h-10 text-sm"
                >
                  Retry
                </button>
                <button
                  onClick={() => setIsProcessingApp(false)}
                  className="plain-btn flex-1 h-10 text-sm"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* --- READY APK POPUP MODAL (with Big Download Button & Notice) --- */}
      {readyApkModalData && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setReadyApkModalData(null)}
        >
          <div
            className="w-full max-w-sm rounded-3xl bg-[var(--card)] p-6 shadow-2xl text-center max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            {/* App Icon */}
            <div className="w-16 h-16 mx-auto mb-2 rounded-2xl bg-[var(--blue)] shadow-md overflow-hidden grid place-items-center">
              {readyApkModalData.icon ? (
                <img src={readyApkModalData.icon} alt="" className="w-full h-full object-cover" />
              ) : (
                <b className="text-white text-2xl">{readyApkModalData.name[0]?.toUpperCase()}</b>
              )}
            </div>

            <h3 className="text-xl font-bold tracking-tight">{readyApkModalData.name}</h3>
            <p className="text-xs text-[var(--sub)] mt-0.5">
              v{readyApkModalData.version} · {readyApkModalData.size} · Android Package
            </p>

            {/* Bilingual Note (Bengali + English) */}
            <div className="notice-box">
              <b>Important Installation Note / জরুরি তথ্য:</b>
              <p>
                Before installing, Android may ask you to allow installs from this source (Chrome &gt; Allow). If Google Play Protect shows a warning, choose <strong>"Install anyway"</strong>.
              </p>
              <p className="bn">
                ইনস্টল করার আগে অ্যান্ড্রয়েড Chrome থেকে অজানা অ্যাপ ইনস্টল করার অনুমতি চাইতে পারে (Allow from this source)। Play Protect সতর্কবার্তা দিলে <strong>"Install anyway"</strong> নির্বাচন করুন।
              </p>
            </div>

            <div className="flex flex-col gap-2 mt-4">
              {/* Big Download APK Button */}
              {readyApkModalData.apkBase64 && (
                <button
                  onClick={() => {
                    downloadBase64File(
                      readyApkModalData.apkBase64!,
                      readyApkModalData.apkFileName,
                      'application/vnd.android.package-archive'
                    );
                    showToastNotification(`Downloaded ${readyApkModalData.apkFileName}`);
                  }}
                  className="w-full h-12 rounded-xl bg-[var(--blue)] text-white text-base font-bold flex items-center justify-center gap-2 press shadow-md"
                >
                  <svg className="ic w-5 h-5" viewBox="0 0 24 24">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Download .APK File
                </button>
              )}

              {/* Copy Hosted URL Button */}
              {readyApkModalData.hostedUrl && (
                <button
                  onClick={() => copyToClipboard(readyApkModalData.hostedUrl!)}
                  className="w-full h-10 rounded-xl bg-[var(--fill)] text-[var(--text)] text-xs font-semibold flex items-center justify-center gap-2 press"
                >
                  <svg className="ic w-4 h-4" viewBox="0 0 24 24">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                  Copy Live App URL
                </button>
              )}

              {/* Optional Download Signing Keys */}
              {readyApkModalData.signingKeyBase64 && (
                <button
                  onClick={() => {
                    downloadBase64File(
                      readyApkModalData.signingKeyBase64!,
                      readyApkModalData.signingKeyFileName || 'signing_keys.zip',
                      'application/zip'
                    );
                    showToastNotification('Signing keys downloaded.');
                  }}
                  className="w-full h-8 text-[11px] text-[var(--sub)] font-medium underline"
                >
                  Download Signing Keys & Passwords (keep to update app later)
                </button>
              )}

              <button
                onClick={() => setReadyApkModalData(null)}
                className="w-full h-10 rounded-xl text-[var(--sub)] text-sm font-medium mt-1"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- PROJECT DETAIL VIEW --- */}
      <div className={`pg ${activeProject ? 'on' : ''}`} style={{ zIndex: 50 }}>
        <header className="ebar">
          <div className="ebar-in">
            <button
              onClick={() => {
                triggerHaptic(10);
                setActiveProject(null);
              }}
              className="ebtn"
            >
              <svg className="ic w-3.5 h-5" viewBox="0 0 14 22" style={{ strokeWidth: 2.4 }}>
                <path d="M11 3L3 11l8 8" />
              </svg>
              Projects
            </button>
            <div className="etitle">{activeProject?.name}</div>
            <span style={{ width: 84 }} />
          </div>
        </header>

        {activeProject && (
          <div className="pscroll">
            <h1 className="ptitle mt-3">{activeProject.name}</h1>
            <div className="psub">
              Created {activeProject.created} · Updated {activeProject.updated}
            </div>

            {/* External URL Banner if Website project */}
            {activeProject.url && (
              <div className="mb-3 px-3 py-2 rounded-xl bg-[var(--fill)] text-xs text-[var(--sub)] flex items-center justify-between">
                <span>External Webview: {activeProject.url}</span>
                <a
                  href={activeProject.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--blue)] font-semibold"
                >
                  Open Live ↗
                </a>
              </div>
            )}

            {/* Action Tiles */}
            <div className="tiles">
              <button
                onClick={() => {
                  triggerHaptic(15);
                  setIsPreviewOpen(true);
                }}
                className="tile g press"
              >
                <i>
                  <svg width="20" height="20" viewBox="0 0 24 24">
                    <path d="M7 4l13 8-13 8z" fill="#fff" />
                  </svg>
                </i>
                <span>
                  <b>Preview</b>
                  <small>Run in browser</small>
                </span>
              </button>
              <button
                onClick={() => {
                  triggerHaptic(15);
                  openBuildStudio();
                }}
                className="tile o press"
              >
                <i>
                  <svg className="ic w-5 h-5 text-white" viewBox="0 0 24 24">
                    <path d="M21 8l-9-5-9 5v8l9 5 9-5z" />
                    <path d="M3.3 7.5L12 12.5l8.7-5M12 22V12.5" />
                  </svg>
                </i>
                <span>
                  <b>Create App</b>
                  <small>Configure & Build APK</small>
                </span>
              </button>
            </div>

            {/* Files Header */}
            <div className="fhead">
              <h2>Files</h2>
              <button
                onClick={() => {
                  triggerHaptic(10);
                  setShowFileSearchBar((prev) => !prev);
                  if (showFileSearchBar) setFileSearchQuery('');
                }}
                className="tbtn press"
                aria-label="Search"
              >
                <svg className="ic w-5 h-5" viewBox="0 0 24 24">
                  <circle cx="11" cy="11" r="7" />
                  <path d="M21 21l-4.3-4.3" />
                </svg>
              </button>
              <button
                onClick={() => {
                  triggerHaptic(12);
                  setNewFileName('');
                  setNewFileExt('html');
                  setShowCreateFileDlg(true);
                }}
                className="tbtn press"
                aria-label="New file"
              >
                <svg className="ic w-6 h-6" viewBox="0 0 24 24" style={{ strokeWidth: 2 }}>
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
              <button
                onClick={() => {
                  triggerHaptic(12);
                  setShowImportDlg(true);
                }}
                className="imp press"
              >
                <svg className="ic w-4 h-4" viewBox="0 0 24 24" style={{ strokeWidth: 2.2 }}>
                  <path d="M12 15V4M7 9l5-5 5 5" />
                  <path d="M5 15v3a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-3" />
                </svg>
                Import
              </button>
            </div>

            {/* File Search Bar */}
            <div className={`sbar ${showFileSearchBar ? 'on' : ''}`}>
              <label>
                <svg className="ic w-4 h-4" viewBox="0 0 24 24">
                  <circle cx="11" cy="11" r="7" />
                  <path d="M21 21l-4.3-4.3" />
                </svg>
                <input
                  type="text"
                  placeholder="Search files"
                  value={fileSearchQuery}
                  onChange={(e) => setFileSearchQuery(e.target.value)}
                />
              </label>
              <button
                onClick={() => {
                  setShowFileSearchBar(false);
                  setFileSearchQuery('');
                }}
              >
                Cancel
              </button>
            </div>

            {/* File list with Swipe-to-Delete and Long-Press */}
            <div className="ios-list">
              {filteredFiles.length > 0 ? (
                filteredFiles.map(({ file, index }) => (
                  <div key={file.name} className="frow">
                    <button
                      onClick={() => {
                        triggerHaptic(20);
                        setAlertConfig({
                          show: true,
                          title: `Delete ${file.name}?`,
                          msg: 'This file will be removed from the project.',
                          input: null,
                          okText: 'Delete',
                          danger: true,
                          onConfirm: async (ok) => {
                            if (ok) {
                              const newFiles = activeProject.files.filter((_, i) => i !== index);
                              const now = new Date();
                              const upd: Project = { ...activeProject, files: newFiles, updated: fmt(now), ts: now.getTime() };
                              setActiveProject(upd);
                              await saveProject(upd);
                              setProjects((prev) => prev.map((p) => (p.id === upd.id ? upd : p)));
                              showToastNotification(`Deleted ${file.name}`);
                            }
                          },
                        });
                      }}
                      className="fdel"
                    >
                      Delete
                    </button>
                    <div
                      onClick={() => {
                        if (file.media) {
                          showToastNotification(`${file.name} is a media file`);
                          return;
                        }
                        triggerHaptic(12);
                        setActiveFileIndex(index);
                        setIsFileEditorOpen(true);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        triggerHaptic(25);
                        setActionSheetTarget({ type: 'file', index });
                        setShowActionSheet(true);
                      }}
                      className="fin"
                    >
                      {file.media ? (
                        <div
                          className="fi"
                          style={{ background: 'linear-gradient(145deg,#ff375f,#d6204a)' }}
                        >
                          <svg className="ic w-5 h-5 text-white" viewBox="0 0 24 24">
                            <rect x="3" y="4" width="18" height="16" rx="3" />
                            <circle cx="9" cy="10" r="1.8" />
                            <path d="M21 16l-5-5-8 8" />
                          </svg>
                        </div>
                      ) : (
                        <div
                          className="fi"
                          style={{
                            background: `linear-gradient(145deg, ${
                              (EXT_COL[extOf(file.name)] || EXT_COL.txt)[0]
                            }, ${(EXT_COL[extOf(file.name)] || EXT_COL.txt)[1]})`,
                          }}
                        >
                          {(extOf(file.name) || 'FILE').slice(0, 4).toUpperCase()}
                        </div>
                      )}
                      <div className="info">
                        <h3>{file.name}</h3>
                        <div className="meta">
                          {fmtTime(file.mod || activeProject.ts)} · {fmtSize(sizeOfFile(file))}
                        </div>
                      </div>
                      <svg className="chev w-5 h-5" viewBox="0 0 24 24">
                        <path className="ic" d="M9 5l7 7-7 7" />
                      </svg>
                    </div>
                  </div>
                ))
              ) : (
                <div className="fempty">
                  {fileSearchQuery ? 'No matching files found' : 'No files yet. Tap + to create one.'}
                </div>
              )}
            </div>
            <p className="foot">
              {activeProject.files.length} {activeProject.files.length === 1 ? 'file' : 'files'} · swipe left to delete · hold for action sheet
            </p>
          </div>
        )}
      </div>

      {/* --- CREATE FILE MODAL --- */}
      <div
        className={`scrim ${showCreateFileDlg ? 'on' : ''}`}
        style={{ zIndex: 65 }}
        onClick={() => setShowCreateFileDlg(false)}
      />
      <div className="wrap" style={{ zIndex: 66, pointerEvents: showCreateFileDlg ? 'auto' : 'none' }}>
        <div className={`dlg ${showCreateFileDlg ? 'on' : ''}`}>
          <h3>New File</h3>
          <p className="sub">Choose a type, then name your file.</p>
          <div className="chips">
            {[
              ['HTML', 'html'],
              ['CSS', 'css'],
              ['JS', 'js'],
              ['JSON', 'json'],
              ['XML', 'xml'],
              ['Text', 'txt'],
              ['Empty File', ''],
            ].map(([label, ext]) => (
              <button
                key={label}
                type="button"
                onClick={() => {
                  triggerHaptic(8);
                  setNewFileExt(ext);
                }}
                className={`chip ${newFileExt === ext ? 'on' : ''}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className={`grp fld ${newFileShake ? 'shake' : ''}`}>
            <input
              type="text"
              placeholder="File name"
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateFile();
              }}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck="false"
            />
            <span>{newFileExt ? `.${newFileExt}` : ''}</span>
          </div>
          <button onClick={handleCreateFile} className="primary-btn press">
            Create
          </button>
          <button
            onClick={() => setShowCreateFileDlg(false)}
            type="button"
            className="plain-btn"
          >
            Cancel
          </button>
        </div>
      </div>

      {/* --- IMPORT MODAL --- */}
      <div
        className={`scrim ${showImportDlg ? 'on' : ''}`}
        style={{ zIndex: 65 }}
        onClick={() => setShowImportDlg(false)}
      />
      <div className="wrap" style={{ zIndex: 66, pointerEvents: showImportDlg ? 'auto' : 'none' }}>
        <div className={`dlg ${showImportDlg ? 'on' : ''}`}>
          <h3>Import</h3>
          <p className="sub">Add files from your device to this project.</p>
          <div className="grp">
            <button
              onClick={() => mediaImportRef.current?.click()}
              type="button"
              className="zrow"
            >
              <i style={{ background: '#ff375f' }}>
                <svg className="ic w-4 h-4" viewBox="0 0 24 24">
                  <rect x="3" y="4" width="18" height="16" rx="3" />
                  <circle cx="9" cy="10" r="1.8" />
                  <path d="M21 16l-5-5-8 8" />
                </svg>
              </i>
              <span>
                <b>Media File</b>
                <small>Images, audio, video</small>
              </span>
              <svg className="chev w-4 h-4" viewBox="0 0 24 24">
                <path className="ic" d="M9 5l7 7-7 7" />
              </svg>
            </button>
            <button
              onClick={() => otherImportRef.current?.click()}
              type="button"
              className="zrow"
            >
              <i style={{ background: '#5856d6' }}>
                <svg className="ic w-4 h-4" viewBox="0 0 24 24">
                  <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                  <path d="M14 3v5h5" />
                </svg>
              </i>
              <span>
                <b>Other Type File</b>
                <small>HTML, CSS, JS, JSON, text...</small>
              </span>
              <svg className="chev w-4 h-4" viewBox="0 0 24 24">
                <path className="ic" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
          <button
            onClick={() => setShowImportDlg(false)}
            type="button"
            className="plain-btn"
          >
            Cancel
          </button>
          <input
            type="file"
            ref={mediaImportRef}
            accept="image/*,audio/*,video/*"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) {
                handleImportFiles(e.target.files, true);
              }
              e.target.value = '';
            }}
          />
          <input
            type="file"
            ref={otherImportRef}
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) {
                handleImportFiles(e.target.files, false);
              }
              e.target.value = '';
            }}
          />
        </div>
      </div>

      {/* --- IN-APP CODE EDITOR --- */}
      <div className={`pg ${isFileEditorOpen ? 'on' : ''}`} style={{ zIndex: 52 }}>
        <header className="ebar">
          <div className="ebar-in">
            <button
              onClick={() => {
                triggerHaptic(10);
                if (isEditorDirty) handleSaveFile(true);
                setIsFileEditorOpen(false);
              }}
              className="ebtn"
            >
              <svg className="ic w-3.5 h-5" viewBox="0 0 14 22" style={{ strokeWidth: 2.4 }}>
                <path d="M11 3L3 11l8 8" />
              </svg>
              Files
            </button>
            <div className="etitle">
              <b>{currentEditorFile?.name}</b>
              <small>
                Ln {cursorPos.line}, Col {cursorPos.col}
              </small>
            </div>
            <button
              onClick={() => {
                triggerHaptic(8);
                document.execCommand('undo');
              }}
              className="ebtn ib"
              aria-label="Undo"
            >
              <svg className="ic w-5 h-5" viewBox="0 0 24 24">
                <path d="M9 14L4 9l5-5" />
                <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
              </svg>
            </button>
            <button
              onClick={() => {
                triggerHaptic(8);
                document.execCommand('redo');
              }}
              className="ebtn ib"
              aria-label="Redo"
            >
              <svg className="ic w-5 h-5" viewBox="0 0 24 24">
                <path d="M15 14l5-5-5-5" />
                <path d="M20 9H10a6 6 0 0 0 0 12h3" />
              </svg>
            </button>
            <button
              onClick={() => handleSaveFile(false)}
              className="ebtn ib"
              style={{ color: isEditorDirty ? 'var(--blue)' : 'var(--gray)' }}
              aria-label="Save"
            >
              <svg className="ic w-5 h-5" viewBox="0 0 24 24">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                <path d="M17 21v-8H7v8M7 3v5h8" />
              </svg>
            </button>
          </div>
        </header>

        {/* Tab switcher */}
        <div className="tabs">
          {activeProject?.files.map((file, i) =>
            file.media ? null : (
              <button
                key={file.name}
                onClick={() => {
                  triggerHaptic(10);
                  if (isEditorDirty) handleSaveFile(true);
                  setActiveFileIndex(i);
                }}
                className={`tab ${i === activeFileIndex ? 'on' : ''}`}
              >
                <i style={{ background: dotColor(file.name) }} />
                {file.name}
              </button>
            )
          )}
        </div>

        {/* Editor Area with dual line numbers & syntax highlight */}
        <div className="cwrap">
          <div className="gut mono">
            <pre ref={gutterPreRef}>{lineNumbers}</pre>
          </div>
          <div className="cbox">
            <pre
              id="hl"
              ref={highlightPreRef}
              className="mono"
              dangerouslySetInnerHTML={{
                __html: `${highlightCode(editorValue, extOf(currentEditorFile?.name || ''))}\n`,
              }}
            />
            <textarea
              id="code"
              ref={codeTextareaRef}
              className="mono"
              value={editorValue}
              onChange={(e) => handleEditorInput(e.target.value)}
              onScroll={syncEditorScroll}
              onClick={updateCursorPosition}
              onKeyUp={updateCursorPosition}
              onKeyDown={(e) => {
                if (e.key === 'Tab') {
                  e.preventDefault();
                  insertSymbol('  ');
                }
              }}
              spellCheck="false"
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              wrap="off"
            />
          </div>
        </div>

        {/* Accessory Keyboard Bar */}
        <div className="kbar">
          <div className="keys">
            {[
              ['Tab', '  '],
              ['<', '<'],
              ['>', '>'],
              ['/', '/'],
              ['{', '{'],
              ['}', '}'],
              ['[', '['],
              [']', ']'],
              ['(', '('],
              [')', ')'],
              ['"', '"'],
              ["'", "'"],
              [';', ';'],
              [':', ':'],
              ['=', '='],
              ['#', '#'],
              ['.', '.'],
            ].map(([label, insertText]) => (
              <button
                key={label}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  triggerHaptic(6);
                  insertSymbol(insertText);
                }}
                className="k press"
              >
                {label}
              </button>
            ))}
          </div>
          <button
            onClick={() => {
              triggerHaptic(15);
              handleSaveFile(true);
              setIsPreviewOpen(true);
            }}
            className="run press"
            aria-label="Run"
          >
            <svg width="18" height="18" viewBox="0 0 24 24">
              <path d="M7 4l13 8-13 8z" fill="#fff" />
            </svg>
          </button>
        </div>
      </div>

      {/* --- VIRTUAL SMARTPHONE PREVIEW STUDIO (CREATE APP SCREEN) --- */}
      <div className={`pg ${isBuildOpen ? 'on' : ''}`} style={{ zIndex: 53 }}>
        <header className="ebar">
          <div className="ebar-in">
            <button
              onClick={() => {
                triggerHaptic(10);
                setIsBuildOpen(false);
              }}
              className="ebtn"
            >
              <svg className="ic w-3.5 h-5" viewBox="0 0 14 22" style={{ strokeWidth: 2.4 }}>
                <path d="M11 3L3 11l8 8" />
              </svg>
              Project
            </button>
            <div className="etitle">Create App</div>
            <span style={{ width: 84 }} />
          </div>
        </header>

        <div className="pscroll" style={{ paddingTop: 12 }}>
          {/* Segmented Controller: App / Splash / Home Screen */}
          <div className="seg">
            <button
              type="button"
              onClick={() => {
                triggerHaptic(10);
                setBuildMode('app');
              }}
              className={buildMode === 'app' ? 'on' : ''}
            >
              App
            </button>
            <button
              type="button"
              onClick={() => {
                triggerHaptic(10);
                setBuildMode('splash');
              }}
              className={buildMode === 'splash' ? 'on' : ''}
            >
              Splash
            </button>
            <button
              type="button"
              onClick={() => {
                triggerHaptic(10);
                setBuildMode('home');
              }}
              className={buildMode === 'home' ? 'on' : ''}
            >
              Home Screen
            </button>
          </div>

          {/* Smartphone Hardware Frame */}
          <div className="phone">
            <div className="scr" data-m={buildMode}>
              {/* Android Status Bar */}
              <div
                className="sbr"
                style={{
                  color: buildMode === 'home' ? '#fff' : buildMode === 'splash' && bSpOn ? '#fff' : '#000',
                }}
              >
                <span>9:41</span>
                <i />
                <span>LTE ▮</span>
              </div>

              {/* Mode 1: App Preview Iframe */}
              {buildMode === 'app' && (
                <iframe
                  sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals"
                  srcDoc={buildProjectPreviewHtml(bHome)}
                  title="App preview"
                />
              )}

              {/* Mode 2: Splash Screen Mode */}
              {buildMode === 'splash' && (
                <div
                  className="lyr lsp"
                  style={{
                    display: 'flex',
                    background: bSpOn ? bSpCol : '#ffffff',
                    color: bSpOn ? '#ffffff' : '#000000',
                  }}
                >
                  {bSpOn && bSpImg ? (
                    <img src={bSpImg} alt="Splash logo" className="spi" />
                  ) : (
                    <div
                      className="aic"
                      style={{
                        width: 76,
                        height: 76,
                        background: bIcon ? '#fff' : activeProject?.bg,
                      }}
                    >
                      {bIcon ? (
                        <img src={bIcon} alt="App icon" className="w-full h-full object-cover" />
                      ) : (
                        activeProject && renderProjectIcon(activeProject)
                      )}
                    </div>
                  )}
                  {bSpOn && <div className="sn">{bName || activeProject?.name}</div>}
                </div>
              )}

              {/* Mode 3: Home Screen Grid Mode */}
              {buildMode === 'home' && (
                <div className="lyr llh" style={{ display: 'block' }}>
                  <div className="lgrid">
                    {[
                      'Phone',
                      'Messages',
                      'Camera',
                      'Photos',
                      'Maps',
                      'Clock',
                      'Chrome',
                      'Notes',
                      'Music',
                      'Files',
                      'Mail',
                    ].map((name, idx) => (
                      <React.Fragment key={name}>
                        {idx === 4 && (
                          <div className="li">
                            <div
                              className="aic"
                              style={{
                                width: 34,
                                height: 34,
                                background: bIcon ? '#fff' : activeProject?.bg,
                              }}
                            >
                              {bIcon ? (
                                <img src={bIcon} alt="Icon" className="w-full h-full object-cover" />
                              ) : (
                                activeProject && renderProjectIcon(activeProject)
                              )}
                            </div>
                            <span>{bName || activeProject?.name}</span>
                          </div>
                        )}
                        <div className="li">
                          <div className="fk" style={{ background: PAL[idx % 6][0] }} />
                          <span>{name}</span>
                        </div>
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              )}

              {/* Android Home indicator bar */}
              <div className="navb">
                <b />
              </div>
            </div>
          </div>

          <p className="foot text-center mb-4">
            {buildMode === 'app'
              ? `Live preview running entry: ${bHome}`
              : buildMode === 'splash'
              ? bSpOn
                ? `Custom splash screen · ${bSpDur} sec duration`
                : 'Splash off · Standard Android launcher start'
              : 'App icon appearance on Android home screen'}
          </p>

          {/* App Icon Upload Button */}
          <button
            onClick={() => bIconInputRef.current?.click()}
            className="picker has press"
            aria-label="Upload icon"
          >
            <div
              className="aic w-full h-full"
              style={{ background: bIcon ? '#fff' : activeProject?.bg }}
            >
              {bIcon ? (
                <img src={bIcon} alt="App icon" className="w-full h-full object-cover" />
              ) : (
                activeProject && renderProjectIcon(activeProject)
              )}
            </div>
          </button>
          <div className="cap">App icon · tap to upload</div>

          {/* Configuration Form */}
          <div className="grp">
            <div className="fr">
              <label>App name</label>
              <input
                type="text"
                value={bName}
                onChange={(e) => setBName(e.target.value)}
                maxLength={40}
                placeholder="My App"
              />
            </div>
            <div className="fr">
              <label>Package</label>
              <input
                type="text"
                value={bPkg}
                onChange={(e) => setBPkg(e.target.value)}
                autoCapitalize="off"
                spellCheck="false"
                placeholder="com.example.app"
              />
            </div>
            <div className="fr">
              <label>Version name</label>
              <input
                type="text"
                value={bVn}
                onChange={(e) => setBVn(e.target.value)}
                placeholder="1.0.0"
              />
            </div>
            <div className="fr">
              <label>Version code</label>
              <input
                type="text"
                inputMode="numeric"
                value={bVc}
                onChange={(e) => setBVc(e.target.value)}
                placeholder="1"
              />
            </div>
            <div className="fr">
              <label>Home page</label>
              <select value={bHome} onChange={(e) => setBHome(e.target.value)}>
                {activeProject?.files
                  .filter((f) => !f.media && /\.html?$/i.test(f.name))
                  .map((f) => (
                    <option key={f.name} value={f.name}>
                      {f.name}
                    </option>
                  ))}
              </select>
            </div>
          </div>

          {/* Splash screen options */}
          <div className="grp">
            <div className="fr">
              <label style={{ flex: 1, width: 'auto' }}>
                Splash screen <small className="text-[var(--sub)]">· optional</small>
              </label>
              <button
                type="button"
                onClick={() => {
                  triggerHaptic(10);
                  setBSpOn((prev) => {
                    const next = !prev;
                    if (next) setBuildMode('splash');
                    return next;
                  });
                }}
                className={`sw ${bSpOn ? 'on' : ''}`}
                role="switch"
                aria-checked={bSpOn}
                aria-label="Splash screen"
              />
            </div>
            {bSpOn && (
              <div id="bSpOpt">
                <div className="fr">
                  <label>Background</label>
                  <input
                    type="color"
                    value={bSpCol}
                    onChange={(e) => setBSpCol(e.target.value)}
                  />
                </div>
                <div className="fr">
                  <label>Logo / Image</label>
                  <button
                    onClick={() => {
                      if (bSpImg) {
                        setBSpImg(null);
                        showToastNotification('Custom image removed');
                      } else {
                        bSpImgInputRef.current?.click();
                      }
                    }}
                    type="button"
                    className="lnk"
                  >
                    {bSpImg ? 'Custom image · tap to remove' : 'Choose'}
                  </button>
                </div>
                <div className="fr">
                  <label>Duration</label>
                  <select value={bSpDur} onChange={(e) => setBSpDur(e.target.value)}>
                    <option value="1">1 sec</option>
                    <option value="2">2 sec</option>
                    <option value="3">3 sec</option>
                  </select>
                </div>
              </div>
            )}
          </div>
          <p className="foot">Without a splash image, the app icon is displayed.</p>

          <input
            type="file"
            ref={bIconInputRef}
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) {
                const r = new FileReader();
                r.onload = () => {
                  const im = new Image();
                  im.onload = () => {
                    const c = document.createElement('canvas');
                    c.width = c.height = 192;
                    const ctx = c.getContext('2d');
                    if (ctx) {
                      const s = Math.min(im.width, im.height);
                      ctx.drawImage(im, (im.width - s) / 2, (im.height - s) / 2, s, s, 0, 0, 192, 192);
                      setBIcon(c.toDataURL('image/png'));
                    }
                  };
                  im.src = r.result as string;
                };
                r.readAsDataURL(f);
              }
              e.target.value = '';
            }}
          />
          <input
            type="file"
            ref={bSpImgInputRef}
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) {
                const r = new FileReader();
                r.onload = () => {
                  const im = new Image();
                  im.onload = () => {
                    const c = document.createElement('canvas');
                    c.width = c.height = 256;
                    const ctx = c.getContext('2d');
                    if (ctx) {
                      const s = Math.min(im.width, im.height);
                      ctx.drawImage(im, (im.width - s) / 2, (im.height - s) / 2, s, s, 0, 0, 256, 256);
                      setBSpImg(c.toDataURL('image/png'));
                      setBuildMode('splash');
                    }
                  };
                  im.src = r.result as string;
                };
                r.readAsDataURL(f);
              }
              e.target.value = '';
            }}
          />
        </div>

        <div className="bbar">
          <button onClick={handleBuildFromCurrentProject} className="primary-btn press">
            Create App
          </button>
        </div>
      </div>

      {/* --- FULLSCREEN LIVE PREVIEW --- */}
      <div className={`pg ${isPreviewOpen ? 'on' : ''}`} style={{ zIndex: 54 }}>
        <header className="ebar">
          <div className="ebar-in">
            <button
              onClick={() => {
                triggerHaptic(10);
                setIsPreviewOpen(false);
              }}
              className="ebtn"
            >
              <svg className="ic w-3.5 h-5" viewBox="0 0 14 22" style={{ strokeWidth: 2.4 }}>
                <path d="M11 3L3 11l8 8" />
              </svg>
              Done
            </button>
            <div className="etitle">Live Preview</div>
            {activeProject?.url ? (
              <a
                href={activeProject.url}
                target="_blank"
                rel="noopener noreferrer"
                className="ebtn text-xs font-semibold"
              >
                External ↗
              </a>
            ) : (
              <span style={{ width: 70 }} />
            )}
          </div>
        </header>
        <div id="pfw">
          {isPreviewOpen && (
            <iframe
              id="pf"
              sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals"
              srcDoc={buildProjectPreviewHtml(activeProject?.build?.home)}
              title="Preview"
            />
          )}
        </div>
      </div>

      {/* --- FULLSCREEN IMMERSIVE RUNNER (OPEN BUTTON) --- */}
      {runningApp && (
        <div className="runner-container">
          <div className="runner-header">
            <span className="runner-title">{runningApp.name}</span>
            <div className="flex items-center gap-2">
              {runningApp.url && (
                <button
                  onClick={() => copyToClipboard(runningApp.url!)}
                  className="runner-close-btn press text-xs"
                >
                  Copy URL
                </button>
              )}
              <button
                onClick={() => {
                  triggerHaptic(10);
                  setRunningApp(null);
                }}
                className="runner-close-btn press"
              >
                Done
              </button>
            </div>
          </div>
          <div className="runner-body">
            <iframe
              srcDoc={runningApp.html}
              sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals"
              title={runningApp.name}
            />
          </div>
        </div>
      )}

      {/* --- ACTION SHEET --- */}
      <div
        className={`scrim ${showActionSheet ? 'on' : ''}`}
        style={{ zIndex: 69 }}
        onClick={() => setShowActionSheet(false)}
      />
      <div className={`act ${showActionSheet ? 'on' : ''}`}>
        <div className="g1">
          <p>
            {actionSheetTarget?.type === 'file' && activeProject
              ? activeProject.files[actionSheetTarget.index]?.name
              : 'Action'}
          </p>
          <button
            onClick={() => {
              setShowActionSheet(false);
              if (actionSheetTarget?.type === 'file' && activeProject) {
                const targetFile = activeProject.files[actionSheetTarget.index];
                setAlertConfig({
                  show: true,
                  title: 'Rename File',
                  msg: `Enter a new name for ${targetFile.name}`,
                  input: targetFile.name,
                  okText: 'Rename',
                  danger: false,
                  onConfirm: async (newName) => {
                    if (!newName || newName === targetFile.name) return;
                    if (/[\\/:*?"<>|]/.test(newName)) {
                      showToastNotification('Invalid file name');
                      return;
                    }
                    if (
                      activeProject.files.some(
                        (f, i) => i !== actionSheetTarget.index && f.name.toLowerCase() === newName.toLowerCase()
                      )
                    ) {
                      showToastNotification('That name already exists');
                      return;
                    }
                    targetFile.name = newName;
                    targetFile.mod = Date.now();
                    const now = new Date();
                    const upd: Project = { ...activeProject, updated: fmt(now), ts: now.getTime() };
                    setActiveProject(upd);
                    await saveProject(upd);
                    setProjects((prev) => prev.map((p) => (p.id === upd.id ? upd : p)));
                    showToastNotification('Renamed successfully');
                  },
                });
              }
            }}
          >
            Rename
          </button>
          <button
            onClick={() => {
              setShowActionSheet(false);
              if (actionSheetTarget?.type === 'file' && activeProject) {
                const targetFile = activeProject.files[actionSheetTarget.index];
                setAlertConfig({
                  show: true,
                  title: `Delete ${targetFile.name}?`,
                  msg: 'This file will be permanently removed from the project.',
                  input: null,
                  okText: 'Delete',
                  danger: true,
                  onConfirm: async (ok) => {
                    if (ok) {
                      const newFiles = activeProject.files.filter((_, i) => i !== actionSheetTarget.index);
                      const now = new Date();
                      const upd: Project = { ...activeProject, files: newFiles, updated: fmt(now), ts: now.getTime() };
                      setActiveProject(upd);
                      await saveProject(upd);
                      setProjects((prev) => prev.map((p) => (p.id === upd.id ? upd : p)));
                      showToastNotification(`Deleted ${targetFile.name}`);
                    }
                  },
                });
              }
            }}
            className="danger"
          >
            Delete
          </button>
        </div>
        <button onClick={() => setShowActionSheet(false)} className="cn">
          Cancel
        </button>
      </div>

      {/* --- IOS ALERT DIALOG --- */}
      <div
        className={`scrim ${alertConfig?.show ? 'on' : ''}`}
        style={{ zIndex: 75 }}
        onClick={() => {
          if (alertConfig) alertConfig.onConfirm(null);
          setAlertConfig(null);
        }}
      />
      <div className="awrap" style={{ pointerEvents: alertConfig?.show ? 'auto' : 'none', zIndex: 76 }}>
        <div className={`alert-dialog ${alertConfig?.show ? 'on' : ''}`}>
          <div className="body">
            <h4>{alertConfig?.title}</h4>
            {alertConfig?.msg && <p>{alertConfig.msg}</p>}
            {alertConfig?.input !== null && (
              <input
                type="text"
                defaultValue={alertConfig?.input || ''}
                id="alertInputRef"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck="false"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const val = (e.target as HTMLInputElement).value.trim();
                    alertConfig?.onConfirm(val);
                    setAlertConfig(null);
                  }
                }}
              />
            )}
          </div>
          <div className="abtns">
            <button
              onClick={() => {
                alertConfig?.onConfirm(null);
                setAlertConfig(null);
              }}
            >
              Cancel
            </button>
            <button
              onClick={() => {
                const inp = document.getElementById('alertInputRef') as HTMLInputElement | null;
                const val = inp ? inp.value.trim() : 'true';
                alertConfig?.onConfirm(val);
                setAlertConfig(null);
              }}
              className={alertConfig?.danger ? 'danger' : ''}
            >
              {alertConfig?.okText || 'OK'}
            </button>
          </div>
        </div>
      </div>

      {/* --- IOS PWA INSTALL GUIDE MODAL --- */}
      {showIOSInstallGuide && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setShowIOSInstallGuide(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-[var(--card)] p-6 shadow-2xl text-center"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-14 h-14 mx-auto mb-3 rounded-2xl bg-[var(--blue)] text-white grid place-items-center shadow-lg">
              <svg className="ic w-8 h-8" viewBox="0 0 24 24">
                <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
            </div>
            <h3 className="text-xl font-bold tracking-tight">Install on iPhone / iPad</h3>
            <p className="mt-2 text-sm text-[var(--sub)] leading-relaxed text-left">
              1. Tap the <strong>Share</strong> button (
              <span className="inline-block px-1">⎋</span>) in Safari bottom toolbar.
              <br />
              2. Scroll down and tap <strong>Add to Home Screen</strong> (
              <span className="inline-block px-1">⊞</span>).
              <br />
              3. Tap <strong>Add</strong> in the top-right corner.
            </p>
            <button
              onClick={() => setShowIOSInstallGuide(false)}
              className="mt-5 w-full h-11 rounded-xl bg-[var(--blue)] text-white text-base font-semibold"
            >
              Got it
            </button>
          </div>
        </div>
      )}

      {/* --- TOAST NOTIFICATION --- */}
      <div id="toast" className={showToast ? 'show' : ''}>
        {toastMsg}
      </div>
    </div>
  );
}
