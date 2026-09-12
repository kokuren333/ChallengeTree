import type { Settings, Workspace } from './types'
import { createSampleWorkspace } from './sample'

const DB_NAME = 'challenge-tree-local'
const DB_VERSION = 1

interface Snapshot {
  id: string
  projectId: string
  reason: string
  createdAt: string
  workspace: Workspace
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
  })
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
  })
}

export function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'project.id' })
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots', { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB is unavailable'))
  })
}

export async function listWorkspaces(): Promise<Workspace[]> {
  const db = await openDatabase()
  const tx = db.transaction('projects', 'readonly')
  const records = await request(tx.objectStore('projects').getAll()) as Workspace[]
  await transactionDone(tx)
  return records.sort((a, b) => b.project.updatedAt.localeCompare(a.project.updatedAt))
}

export async function saveWorkspace(workspace: Workspace): Promise<void> {
  const db = await openDatabase()
  const tx = db.transaction('projects', 'readwrite')
  tx.objectStore('projects').put(workspace)
  await transactionDone(tx)
}

export async function saveWorkspaces(workspaces: Workspace[]): Promise<void> {
  const db = await openDatabase()
  const tx = db.transaction('projects', 'readwrite')
  const store = tx.objectStore('projects')
  workspaces.forEach((workspace) => store.put(workspace))
  await transactionDone(tx)
}

export async function deleteWorkspace(projectId: string): Promise<void> {
  const db = await openDatabase()
  const projectTx = db.transaction('projects', 'readwrite')
  projectTx.objectStore('projects').delete(projectId)
  await transactionDone(projectTx)
  const readTx = db.transaction('snapshots', 'readonly')
  const snapshots = await request(readTx.objectStore('snapshots').getAll()) as Snapshot[]
  await transactionDone(readTx)
  const cleanTx = db.transaction('snapshots', 'readwrite')
  snapshots.filter((item) => item.projectId === projectId).forEach((item) => cleanTx.objectStore('snapshots').delete(item.id))
  await transactionDone(cleanTx)
}

export async function getWorkspace(projectId: string): Promise<Workspace | undefined> {
  const db = await openDatabase()
  const tx = db.transaction('projects', 'readonly')
  const workspace = await request(tx.objectStore('projects').get(projectId)) as Workspace | undefined
  await transactionDone(tx)
  return workspace
}

export async function saveSnapshot(workspace: Workspace, reason: string): Promise<void> {
  const db = await openDatabase()
  const tx = db.transaction('snapshots', 'readwrite')
  const store = tx.objectStore('snapshots')
  // Multiple parallel jobs may finish in the same millisecond. A timestamp
  // alone would make one snapshot overwrite another before retention runs.
  store.put({ id: `${workspace.project.id}:${Date.now()}:${crypto.randomUUID()}`, projectId: workspace.project.id, reason, createdAt: new Date().toISOString(), workspace } satisfies Snapshot)
  await transactionDone(tx)
  const readTx = db.transaction('snapshots', 'readonly')
  const snapshots = (await request(readTx.objectStore('snapshots').getAll())) as Snapshot[]
  await transactionDone(readTx)
  const old = snapshots.filter((item) => item.projectId === workspace.project.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(3)
  if (old.length) {
    const cleanTx = db.transaction('snapshots', 'readwrite')
    old.forEach((item) => cleanTx.objectStore('snapshots').delete(item.id))
    await transactionDone(cleanTx)
  }
}

export async function readSettings(): Promise<Settings | undefined> {
  const db = await openDatabase()
  const tx = db.transaction('settings', 'readonly')
  const stored = await request(tx.objectStore('settings').get('global')) as { id: string; settings: Settings } | undefined
  await transactionDone(tx)
  return stored?.settings
}

export async function writeSettings(settings: Settings): Promise<void> {
  const db = await openDatabase()
  const tx = db.transaction('settings', 'readwrite')
  tx.objectStore('settings').put({ id: 'global', settings })
  await transactionDone(tx)
}

export async function ensureSampleWorkspace(uiLanguage: 'ja' | 'en'): Promise<Workspace[]> {
  const existing = await listWorkspaces()
  const legacySample = existing.find((item) => ['sample-transformer', 'sample-transformer-v2'].includes(item.project.id))
  if (legacySample) {
    await deleteWorkspace(legacySample.project.id)
    const remaining = existing.filter((item) => item.project.id !== legacySample.project.id)
    const sample = createSampleWorkspace(uiLanguage)
    await saveWorkspace(sample)
    return [...remaining, sample].sort((a, b) => b.project.updatedAt.localeCompare(a.project.updatedAt))
  }
  if (existing.length) return existing
  const sample = createSampleWorkspace(uiLanguage)
  await saveWorkspace(sample)
  return [sample]
}
