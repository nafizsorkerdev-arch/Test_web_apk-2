export interface ProjectFile {
  name: string;
  content: string;
  media?: boolean;
  data?: string; // Data URL for media
  size?: number;
  mod?: number;
}

export interface BuildConfig {
  name: string;
  pkg: string;
  vn: string;
  vc: string;
  home: string;
  spOn: boolean;
  spCol: string;
  spDur: string;
  icon?: string | null;
  spImg?: string | null;
}

export interface Project {
  id: string;
  name: string;
  created: string;
  updated: string;
  ts: number;
  bg: string;
  icon?: string;
  img?: string | null;
  url?: string;
  files: ProjectFile[];
  build?: BuildConfig;
  hostedId?: string;
  hostedUrl?: string;
}

export interface APKItem {
  id: string;
  name: string;
  bg: string;
  icon: string;
  ver: string;
  size: string;
  date: string;
  built?: boolean;
  projectId?: string;
  pkg?: string;
  apkFileName?: string;
  hostedUrl?: string;
  apkBase64?: string;
  signingKeyBase64?: string;
  signingKeyFileName?: string;
  fallbackUrl?: string;
}
