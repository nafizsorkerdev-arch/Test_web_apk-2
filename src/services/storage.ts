import { openDB, DBSchema, IDBPDatabase } from 'idb';
import { Project, APKItem } from '../types';

interface NFXStudioDB extends DBSchema {
  projects: {
    key: string;
    value: Project;
    indexes: { 'by-updated': number };
  };
  apks: {
    key: string;
    value: APKItem;
    indexes: { 'by-date': string };
  };
}

const DB_NAME = 'nfx-studio-db';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<NFXStudioDB>> | null = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<NFXStudioDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('projects')) {
          const projectStore = db.createObjectStore('projects', { keyPath: 'id' });
          projectStore.createIndex('by-updated', 'ts');
        }
        if (!db.objectStoreNames.contains('apks')) {
          const apkStore = db.createObjectStore('apks', { keyPath: 'id' });
          apkStore.createIndex('by-date', 'date');
        }
      },
    });
  }
  return dbPromise;
}

const DEMO_NAMES = new Set(['GreenLife', 'ShopEasy', 'CodeHub']);
const DEMO_IDS = new Set(['p1', 'p2', 'p3', 'p4', 'a1', 'a2', 'a3', 'a4']);

// Forcefully purge any residual demo/seed data from both localStorage and IndexedDB
export async function purgeDemoData(): Promise<void> {
  try {
    localStorage.removeItem('nfx-projects');
    localStorage.removeItem('nfx-apks');
  } catch {}

  try {
    const db = await getDB();
    // Clean APKs
    const allApks = await db.getAll('apks');
    for (const apk of allApks) {
      if (
        DEMO_IDS.has(apk.id) ||
        DEMO_NAMES.has(apk.name) ||
        (apk.name === 'NFX Studio' && (apk.id === 'a1' || apk.ver === '1.4.0'))
      ) {
        await db.delete('apks', apk.id);
      }
    }

    // Clean Projects
    const allProjects = await db.getAll('projects');
    for (const proj of allProjects) {
      if (
        DEMO_IDS.has(proj.id) ||
        DEMO_NAMES.has(proj.name) ||
        (proj.name === 'NFX Studio' && proj.id === 'p1')
      ) {
        await db.delete('projects', proj.id);
      }
    }
  } catch (err) {
    console.error('Error during demo data purge:', err);
  }
}

export async function getAllProjects(): Promise<Project[]> {
  const db = await getDB();
  const projects = await db.getAll('projects');
  // Filter out any lingering demo projects
  const filtered = projects.filter(
    (p) =>
      !DEMO_IDS.has(p.id) &&
      !DEMO_NAMES.has(p.name) &&
      !(p.name === 'NFX Studio' && p.id === 'p1')
  );
  return filtered.sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

export async function saveProject(project: Project): Promise<void> {
  const db = await getDB();
  await db.put('projects', project);
}

export async function deleteProject(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('projects', id);
}

export async function clearAllProjects(): Promise<void> {
  const db = await getDB();
  await db.clear('projects');
}

export async function getAllAPKs(): Promise<APKItem[]> {
  const db = await getDB();
  const apks = await db.getAll('apks');
  // Filter out any lingering demo APKs
  const filtered = apks.filter(
    (a) =>
      !DEMO_IDS.has(a.id) &&
      !DEMO_NAMES.has(a.name) &&
      !(a.name === 'NFX Studio' && (a.id === 'a1' || a.ver === '1.4.0'))
  );
  return filtered;
}

export async function saveAPK(apk: APKItem): Promise<void> {
  const db = await getDB();
  await db.put('apks', apk);
}

export async function deleteAPK(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('apks', id);
}

export async function clearAllAPKs(): Promise<void> {
  const db = await getDB();
  await db.clear('apks');
}
