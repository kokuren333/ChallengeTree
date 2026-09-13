import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent, KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode, WheelEvent as ReactWheelEvent } from 'react'
import { ConnectorClient, ConnectorError, type ResearchEvidence } from './connector'
import { applyGrade, getProgress, migrateWorkspace, migrateWorkspaceBundle } from './core'
import { deleteWorkspace, ensureSampleWorkspace, getWorkspace, listWorkspaces, saveSnapshot, saveWorkspace, saveWorkspaces, readSettings, writeSettings } from './db'
import { browserLanguage, t } from './i18n'
import { ChallengeSchema, NodeCreateSchema, NodeSchema, ResourceSchema, WorkspaceBundleSchema } from './schemas'
import type { Challenge, ChallengeMode, ConnectorModel, ConnectorStatus, CurriculumContext, Edge, GradeResponse, NodeRecord, Proposal, ResearchRecord, Resource, Settings, UiLanguage, Workspace, WorkspaceBundle } from './types'

type Screen = 'home' | 'create' | 'proposals' | 'tree'
type CreateMode = 'ai' | 'manual'
type LastGrade = { response: GradeResponse; xpAwarded: number; unlockedIds: string[]; nodeId: string; challengeId?: string; attemptId: string; progress?: string[]; progressLabel?: string }
type NodeOperation = 'challenge' | 'grade' | 'expand' | 'manual-create'
type ManualTreeForm = { title: string; topic: string; goal: string; philosophy: string; learnerProfile: string; branches: string; advantages: string; tradeoffs: string; researchMode: 'ja' | 'global'; challengeMode: ChallengeMode }
const projectNodeKey = (projectId: string, nodeId: string) => `${projectId}:${nodeId}`
const NODE_WIDTH = 184
const NODE_HEIGHT = 76
const NODE_GAP = 24
const LAYOUT_COLUMN_GAP = 126
const LAYOUT_ROW_GAP = 86
const LAYOUT_TOP = 20

const DEFAULT_SETTINGS: Settings = { uiLanguage: browserLanguage(), connectorUrl: 'http://127.0.0.1:43110', reducedMotion: false, model: 'gpt-5.6-luna', reasoningEffort: 'low' }

function splitMetadata(value: string) {
  return value.split(/[\n,、]/).map((item) => item.trim()).filter(Boolean)
}

function rectanglesOverlap(left: { x: number; y: number }, right: { x: number; y: number }) {
  return Math.abs(left.x - right.x) < NODE_WIDTH + NODE_GAP && Math.abs(left.y - right.y) < NODE_HEIGHT + NODE_GAP
}

function findFreePosition(nodes: Record<string, NodeRecord>, preferred: { x: number; y: number }, reserved: Array<{ x: number; y: number }> = []) {
  const occupied = [...Object.values(nodes).map((node) => node.position), ...reserved]
  const offsets = [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5]
  // The occupied set is finite, so scanning columns without an arbitrary
  // cutoff guarantees a non-overlapping position even after many expansions.
  for (let column = 0; ; column += 1) {
    for (const offset of offsets) {
      const candidate = { x: preferred.x + column * (NODE_WIDTH + 86), y: preferred.y + offset * (NODE_HEIGHT + NODE_GAP) }
      if (!occupied.some((position) => rectanglesOverlap(position, candidate))) return candidate
    }
  }
}

function getTreeLayout(tree: Workspace['tree']): Record<string, { x: number; y: number }> {
  const visibleNodes = Object.values(tree.nodes).filter((node) => !node.archived && node.status !== 'hidden')
  const visibleIds = new Set(visibleNodes.map((node) => node.id))
  const children = new Map<string, string[]>()
  for (const node of visibleNodes) {
    const linkedChildren = node.children.filter((id) => visibleIds.has(id))
    const prerequisiteChildren = visibleNodes.filter((candidate) => candidate.prerequisites.includes(node.id)).map((candidate) => candidate.id)
    children.set(node.id, [...new Set([...linkedChildren, ...prerequisiteChildren])])
  }
  const roots = visibleNodes.filter((node) => !node.prerequisites.some((id) => visibleIds.has(id))).sort((left, right) => {
    if (left.id === tree.rootNodeId) return -1
    if (right.id === tree.rootNodeId) return 1
    return left.position.y - right.position.y
  })
  const positions: Record<string, { x: number; y: number }> = {}
  const active = new Set<string>()
  let leafIndex = 0
  const visit = (id: string, depth: number): number => {
    if (positions[id]) return positions[id].y
    if (active.has(id)) return LAYOUT_TOP + leafIndex++ * LAYOUT_ROW_GAP
    active.add(id)
    const childIds = children.get(id) || []
    const childYs = childIds.map((childId) => visit(childId, depth + 1))
    const y = childYs.length ? childYs.reduce((sum, value) => sum + value, 0) / childYs.length : LAYOUT_TOP + leafIndex++ * LAYOUT_ROW_GAP
    positions[id] = { x: 70 + depth * (NODE_WIDTH + LAYOUT_COLUMN_GAP), y }
    active.delete(id)
    return y
  }
  roots.forEach((node) => visit(node.id, 0))
  visibleNodes.filter((node) => !positions[node.id]).sort((left, right) => left.position.y - right.position.y).forEach((node) => visit(node.id, 0))
  return positions
}

function proposalContext(proposal: Proposal): CurriculumContext {
  return {
    proposalId: proposal.id, title: proposal.title, philosophy: proposal.philosophy,
    learnerProfile: proposal.learnerProfile, branches: proposal.branches,
    advantages: proposal.advantages, tradeoffs: proposal.tradeoffs,
  }
}

function researchRecord(operation: ResearchRecord['operation'], query: string, mode: Workspace['project']['researchMode'], evidence: ResearchEvidence, options: { nodeId?: string; challengeId?: string; resourceIds?: string[]; generatedNodeIds?: string[]; summary?: string; unknownClaims?: string[] } = {}): ResearchRecord {
  const completedAt = new Date().toISOString()
  const sources = evidence.sources.map((source) => ({ title: source.title, url: source.url, ...(source.query ? { query: source.query } : {}) }))
  return {
    id: crypto.randomUUID(), operation, ...(options.nodeId ? { nodeId: options.nodeId } : {}), ...(options.challengeId ? { challengeId: options.challengeId } : {}),
    query, mode, status: 'completed', startedAt: completedAt, completedAt,
    summary: options.summary || `${evidence.searches.length ? evidence.searches.join(' / ') : '外部検索'}（${sources.length}件の出典を確認）`,
    resourceIds: options.resourceIds || [], generatedNodeIds: options.generatedNodeIds || [], searches: evidence.searches, sources, logs: evidence.logs || [], unknownClaims: options.unknownClaims || [],
  }
}

function operationErrorMessage(error: unknown, tr: (key: string) => string) {
  if (error instanceof ConnectorError && error.code === 'native_research_required') return 'CodexのWeb検索を確認できなかったため、結果を保存せず処理を中止しました。'
  if (error instanceof ConnectorError && error.code === 'invalid_output') return tr('error.invalidOutput')
  return error instanceof Error ? error.message : tr('error.generic')
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [screen, setScreen] = useState<Screen>('home')
  const [createMode, setCreateMode] = useState<CreateMode>('ai')
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [createForm, setCreateForm] = useState({ topic: '', goal: '', researchMode: 'global' as 'ja' | 'global', challengeMode: 'explain' as ChallengeMode, priorKnowledge: 'auto' })
  const [manualForm, setManualForm] = useState<ManualTreeForm>({ title: '', topic: '', goal: '', philosophy: '', learnerProfile: '', branches: '', advantages: '', tradeoffs: '', researchMode: 'global', challengeMode: 'explain' })
  const [connectorStatus, setConnectorStatus] = useState<ConnectorStatus>({ connected: false, authenticated: false })
  const [availableModels, setAvailableModels] = useState<ConnectorModel[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState('')
  const [busy, setBusy] = useState('')
  const [nodeBusy, setNodeBusy] = useState<Record<string, NodeOperation>>({})
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [lastGrades, setLastGrades] = useState<Record<string, LastGrade | null>>({})
  const [nodeGradingLogs, setNodeGradingLogs] = useState<Record<string, string[]>>({})
  const [gradingLog, setGradingLog] = useState<string[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const appliedSettingsRef = useRef<string | null>(null)
  const settingsRef = useRef(settings)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const workspaceRef = useRef<Workspace | null>(null)
  const workspaceStoreRef = useRef<Record<string, Workspace>>({})
  const workspaceRevisionRef = useRef<Record<string, number>>({})
  const workspaceEpochRef = useRef<Record<string, number>>({})
  const persistQueueRef = useRef<Record<string, Promise<void>>>({})
  const proposalResearchRef = useRef<ResearchEvidence | null>(null)
  const draftTimersRef = useRef<Record<string, number>>({})
  const openRequestRef = useRef(0)
  const connector = useMemo(() => new ConnectorClient(settings.connectorUrl), [settings.connectorUrl])

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const stored = await readSettings()
        const nextSettings = { ...DEFAULT_SETTINGS, ...stored }
        if (!active) return
        setSettings(nextSettings)
        const saved = (await ensureSampleWorkspace(nextSettings.uiLanguage)).map((item) => migrateWorkspace(item))
        if (active) {
          workspaceStoreRef.current = Object.fromEntries(saved.map((item) => [item.project.id, item]))
          workspaceRevisionRef.current = Object.fromEntries(saved.map((item) => [item.project.id, 0]))
          workspaceEpochRef.current = Object.fromEntries(saved.map((item) => [item.project.id, 0]))
          setWorkspaces(saved)
        }
      } catch {
        if (active) setError(t(settings.uiLanguage, 'error.generic'))
      }
    })()
    return () => { active = false }
    // Initial load intentionally runs once; settings are read inside this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let active = true
    const check = async () => {
      const status = await connector.status()
      if (active) setConnectorStatus(status)
    }
    void check()
    const timer = window.setInterval(() => { void check() }, 7000)
    return () => { active = false; window.clearInterval(timer) }
  }, [connector])

  useEffect(() => {
    const requestedModel = settings.model?.trim()
    const requestedEffort = settings.reasoningEffort?.trim() || 'low'
    const requestedKey = `${requestedModel}:${requestedEffort}`
    if (!requestedModel || (connectorStatus.model === requestedModel && connectorStatus.reasoningEffort === requestedEffort) || !connectorStatus.appServerRunning || !connectorStatus.authenticated || appliedSettingsRef.current === requestedKey) return
    appliedSettingsRef.current = requestedKey
    void connector.selectModel(requestedModel, requestedEffort).then(setConnectorStatus).catch(() => {
      if (appliedSettingsRef.current === requestedKey) appliedSettingsRef.current = null
    })
  }, [connector, connectorStatus.appServerRunning, connectorStatus.authenticated, connectorStatus.model, connectorStatus.reasoningEffort, settings.model, settings.reasoningEffort])

  useEffect(() => {
    if (!settingsOpen) return
    let active = true
    setModelsLoading(true)
    setModelsError('')
    void connector.listModels().then((models) => {
      if (active) setAvailableModels(models)
    }).catch((caught) => {
      if (active) setModelsError(caught instanceof Error ? caught.message : t(settings.uiLanguage, 'settings.modelLoadError'))
    }).finally(() => {
      if (active) setModelsLoading(false)
    })
    return () => { active = false }
  }, [connector, settingsOpen])

  const lang = settings.uiLanguage
  const tr = useCallback((key: string, vars?: Record<string, string | number>) => t(lang, key, vars), [lang])

  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  useEffect(() => {
    document.documentElement.lang = lang
    document.documentElement.dataset.reducedMotion = settings.reducedMotion ? 'true' : 'false'
  }, [lang, settings.reducedMotion])

  const persistProject = useCallback(async (projectId: string, update: (current: Workspace) => Workspace, reason?: string, settingsOverride?: Settings) => {
    const run = async () => {
      const current = workspaceStoreRef.current[projectId]
      if (!current) return
      const next = update(current)
      const normalized = { ...next, settings: settingsOverride ?? settingsRef.current, project: { ...next.project, updatedAt: new Date().toISOString() } }
      workspaceRevisionRef.current[projectId] = (workspaceRevisionRef.current[projectId] ?? 0) + 1
      workspaceStoreRef.current[projectId] = normalized
      if (workspaceRef.current?.project.id === projectId) {
        workspaceRef.current = normalized
        setWorkspace(normalized)
      }
      setWorkspaces((current) => [normalized, ...current.filter((item) => item.project.id !== projectId)])
      await saveWorkspace(normalized)
      if (reason) await saveSnapshot(normalized, reason)
    }
    const previous = persistQueueRef.current[projectId] ?? Promise.resolve()
    const queued = previous.then(run, run)
    const tracked = queued.finally(() => { if (persistQueueRef.current[projectId] === tracked) delete persistQueueRef.current[projectId] })
    persistQueueRef.current[projectId] = tracked
    await queued
  }, [settings])

  const persist = useCallback(async (next: Workspace, reason?: string, settingsOverride?: Settings) => {
    await persistProject(next.project.id, () => next, reason, settingsOverride)
  }, [persistProject])

  const setNodeOperation = (projectId: string, nodeId: string, operation: NodeOperation | null) => {
    const key = projectNodeKey(projectId, nodeId)
    setNodeBusy((current) => {
      const next = { ...current }
      if (operation) next[key] = operation
      else delete next[key]
      return next
    })
  }

  const setNodeLog = (projectId: string, nodeId: string, items: string[]) => setNodeGradingLogs((current) => ({ ...current, [projectNodeKey(projectId, nodeId)]: items }))
  const setNodeGrade = (projectId: string, nodeId: string, grade: LastGrade | null | ((current: LastGrade | null) => LastGrade | null)) => {
    const key = projectNodeKey(projectId, nodeId)
    setLastGrades((current) => ({ ...current, [key]: typeof grade === 'function' ? grade(current[key] ?? null) : grade }))
  }
  const isCurrentProject = (projectId: string) => workspaceRef.current?.project.id === projectId

  const openWorkspace = async (projectId: string) => {
    const requestId = ++openRequestRef.current
    setError('')
    const item = workspaceStoreRef.current[projectId] ?? workspaces.find((candidate) => candidate.project.id === projectId) ?? await getWorkspace(projectId)
    if (!item || requestId !== openRequestRef.current) return
    workspaceStoreRef.current[item.project.id] = item
    workspaceRef.current = item
    setWorkspace(item)
    setSelectedNodeId(item.tree.rootNodeId)
    setScreen('tree')
  }

  const goHome = () => {
    openRequestRef.current += 1
    setScreen('home'); workspaceRef.current = null; setWorkspace(null); setSelectedNodeId(null); setError(''); setNotice('')
  }

  const handlePropose = async (event: FormEvent) => {
    event.preventDefault()
    if (!createForm.topic.trim() || !createForm.goal.trim()) {
      setError(`${tr('create.topic')} / ${tr('create.goal')}`)
      return
    }
    setBusy('propose'); setError('')
    try {
      if (!connectorStatus.connected || !connectorStatus.authenticated) throw new ConnectorError(tr('error.connector'), 'offline')
      setGradingLog(['領域の調査を開始しています…'])
      proposalResearchRef.current = null
      const result = await connector.treePropose({ ...createForm, topic: createForm.topic.trim(), goal: createForm.goal.trim() }, (message) => setGradingLog((items) => [...items, message]), (evidence) => { proposalResearchRef.current = evidence })
      setProposals(result); setScreen('proposals')
    } catch (caught) {
      setError(operationErrorMessage(caught, tr))
    } finally { setBusy('') }
  }

  const chooseProposal = async (proposal: Proposal) => {
    const now = new Date().toISOString()
    const rootCandidate = proposal.initialNodes.find((item) => item.id === proposal.root.id) ?? proposal.initialNodes[0]
    if (!rootCandidate) { setError(tr('error.invalidOutput')); return }
    const rootId = rootCandidate.id
    const rootChallenges = (proposal.challenges ?? []).filter((item) => item.nodeId === rootId).slice(0, 1)
    const rootResourceIds = new Set(rootChallenges.flatMap((item) => item.resourceIds))
    const rootResources = (proposal.resources ?? []).filter((item) => rootResourceIds.has(item.id))
    const root: NodeRecord = {
      ...rootCandidate, id: rootId, status: 'unlocked', xp: 0, masteryState: 'familiar', prerequisites: [], children: [],
      resourceIds: rootResources.map((item) => item.id), challengeIds: rootChallenges.map((item) => item.id), position: { x: 70, y: 270 }, createdAt: rootCandidate.createdAt ?? now, updatedAt: now,
    }
    const next: Workspace = {
      formatVersion: 1, appVersion: '0.1.0', schemaVersion: 1, connectorProtocolVersion: '1',
      project: { id: crypto.randomUUID(), title: proposal.title, topic: createForm.topic.trim(), goal: createForm.goal.trim(), researchMode: createForm.researchMode, challengeMode: createForm.challengeMode, curriculumContext: proposalContext(proposal), createdAt: now, updatedAt: now },
      tree: { rootNodeId: rootId, nodes: { [rootId]: root }, edges: [] }, challenges: rootChallenges, attempts: [], resources: rootResources,
      research: proposalResearchRef.current ? [researchRecord('tree_propose', `${createForm.topic.trim()} / ${createForm.goal.trim()}`, createForm.researchMode, proposalResearchRef.current, { resourceIds: rootResources.map((item) => item.id), summary: 'ツリー作成前の領域調査' })] : [], settings,
      stats: { totalXp: 0, totalChallenges: 0, gradeDistribution: [0, 0, 0, 0], sessionXp: 0 }, draftAnswers: {},
    }
    // Make the new project the active target before persist() so a proposal
    // chosen from the home flow is displayed even while another project has
    // background grading or research running.
    workspaceStoreRef.current[next.project.id] = next
    workspaceRef.current = next
    setBusy('save')
    try {
      await persist(next, 'new-project')
      setSelectedNodeId(rootId); setScreen('tree'); setNotice(tr('home.saved'))
    } catch { setError(tr('error.generic')) } finally { setBusy('') }
  }

  const handleManualCreate = async (event: FormEvent) => {
    event.preventDefault()
    if (!manualForm.title.trim() || !manualForm.topic.trim() || !manualForm.goal.trim()) {
      setError(`${tr('create.title')} / ${tr('create.topic')} / ${tr('create.goal')}`)
      return
    }
    const context: CurriculumContext = {
      title: manualForm.title.trim(), philosophy: manualForm.philosophy.trim(), learnerProfile: manualForm.learnerProfile.trim(),
      branches: splitMetadata(manualForm.branches), advantages: splitMetadata(manualForm.advantages), tradeoffs: manualForm.tradeoffs.trim(),
    }
    setBusy('manual-create'); setError(''); setGradingLog(['ツリーの開始ノードを作成しています…'])
    try {
      if (!connectorStatus.connected || !connectorStatus.authenticated) throw new ConnectorError(tr('error.connector'), 'offline')
      let research: ResearchEvidence | null = null
      const generated = await connector.nodeCreate({ title: context.title, topic: manualForm.topic.trim(), goal: manualForm.goal.trim(), researchMode: manualForm.researchMode, challengeMode: manualForm.challengeMode, curriculumContext: context }, (message) => setGradingLog((items) => [...items, message]), (evidence) => { research = evidence })
      const now = new Date().toISOString()
      const rawNode = NodeCreateSchema.parse(generated.node)
      const rootId = rawNode.id
      const challenge = ChallengeSchema.parse(generated.challenges[0]) as Challenge
      const rootChallenge = { ...challenge, nodeId: rootId }
      const resources = generated.resources.map((item) => ResourceSchema.parse(item) as Resource)
      const rootResourceIds = rootChallenge.resourceIds.filter((id) => resources.some((item) => item.id === id))
      const root: NodeRecord = { ...rawNode, id: rootId, status: 'unlocked', xp: 0, masteryState: 'familiar', prerequisites: [], children: [], resourceIds: rootResourceIds, challengeIds: [rootChallenge.id], position: { x: 110, y: 270 }, createdAt: now, updatedAt: now }
      const next: Workspace = {
        formatVersion: 1, appVersion: '0.1.0', schemaVersion: 1, connectorProtocolVersion: '1',
        project: { id: crypto.randomUUID(), title: context.title, topic: manualForm.topic.trim(), goal: manualForm.goal.trim(), researchMode: manualForm.researchMode, challengeMode: manualForm.challengeMode, curriculumContext: context, createdAt: now, updatedAt: now },
        tree: { rootNodeId: rootId, nodes: { [rootId]: root }, edges: [] }, challenges: [{ ...rootChallenge, resourceIds: rootResourceIds }], attempts: [], resources,
        research: research ? [researchRecord('node_create', `${manualForm.topic.trim()} / ${context.title}`, manualForm.researchMode, research, { resourceIds: rootResourceIds, generatedNodeIds: [rootId], summary: '手動ツリーの開始ノード調査' })] : [], settings,
        stats: { totalXp: 0, totalChallenges: 0, gradeDistribution: [0, 0, 0, 0], sessionXp: 0 }, draftAnswers: {},
      }
      workspaceStoreRef.current[next.project.id] = next; workspaceRevisionRef.current[next.project.id] = 0; workspaceEpochRef.current[next.project.id] = 0
      workspaceRef.current = next; await persist(next, 'new-project'); setSelectedNodeId(rootId); setScreen('tree'); setNotice(tr('home.saved'))
    } catch (caught) {
      setError(operationErrorMessage(caught, tr))
    } finally { setBusy('') }
  }

  const updateSettings = async (next: Settings) => {
    const currentModel = connectorStatus.model || settings.model || 'gpt-5.6-luna'
    const currentEffort = connectorStatus.reasoningEffort || settings.reasoningEffort || 'low'
    const selectedModel = next.model?.trim() || currentModel
    const selectedEffort = next.reasoningEffort?.trim() || currentEffort
    if (selectedModel !== currentModel || selectedEffort !== currentEffort) {
      const nextStatus = await connector.selectModel(selectedModel, selectedEffort)
      setConnectorStatus(nextStatus)
    }
    const normalizedSettings = { ...next, model: selectedModel, reasoningEffort: selectedEffort }
    setSettings(normalizedSettings)
    await writeSettings(normalizedSettings)
    if (workspace) await persist({ ...workspace, settings: normalizedSettings }, undefined, normalizedSettings)
    setSettingsOpen(false)
    setNotice(tr('home.saved'))
  }

  const exportWorkspace = () => {
    const allWorkspaces = workspaces.map((item) => workspaceStoreRef.current[item.project.id] ?? item)
    if (!allWorkspaces.length) return
    const bundle: WorkspaceBundle = {
      formatVersion: 2, appVersion: '0.1.0', schemaVersion: 1, connectorProtocolVersion: '1',
      settings, workspaces: allWorkspaces,
    }
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'challenge-tree-workspace.json'; anchor.click(); URL.revokeObjectURL(url)
  }

  const importSave = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = async () => {
      try {
        const value: unknown = JSON.parse(String(reader.result))
        if (workspace) await saveSnapshot(workspace, 'before-import')
        const imported = migrateWorkspaceBundle(value)
        const parsed = WorkspaceBundleSchema.parse(imported) as WorkspaceBundle
        const importedSettings = parsed.settings
        const importedWorkspaces = parsed.workspaces.map((item) => ({ ...item, settings: importedSettings }))
        const importedIds = new Set(importedWorkspaces.map((item) => item.project.id))
        for (const projectId of importedIds) {
          workspaceEpochRef.current[projectId] = (workspaceEpochRef.current[projectId] ?? 0) + 1
          if (draftTimersRef.current[projectId]) window.clearTimeout(draftTimersRef.current[projectId])
          delete draftTimersRef.current[projectId]
        }
        await Promise.all([...importedIds].map((projectId) => persistQueueRef.current[projectId] ?? Promise.resolve()))
        await saveWorkspaces(importedWorkspaces)
        const merged = [...importedWorkspaces, ...workspaces.filter((item) => !importedIds.has(item.project.id))]
        workspaceStoreRef.current = { ...workspaceStoreRef.current, ...Object.fromEntries(importedWorkspaces.map((item) => [item.project.id, item])) }
        for (const projectId of importedIds) workspaceRevisionRef.current[projectId] = 0
        setWorkspaces(merged)
        setSettings(importedSettings)
        await writeSettings(importedSettings)
        const selected = importedWorkspaces.find((item) => item.project.id === workspaceRef.current?.project.id) ?? importedWorkspaces[0]
        workspaceRef.current = selected
        setWorkspace(selected); setSelectedNodeId(selected.tree.rootNodeId); setScreen('tree'); setNotice(tr('import.success', { count: importedWorkspaces.length })); setError('')
      } catch { setError(tr('import.invalid')) }
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
    reader.readAsText(file)
  }

  const deleteProject = async (projectId: string) => {
    if (!window.confirm(tr('home.deleteConfirm'))) return
    try {
      workspaceEpochRef.current[projectId] = (workspaceEpochRef.current[projectId] ?? 0) + 1
      if (draftTimersRef.current[projectId]) window.clearTimeout(draftTimersRef.current[projectId])
      delete draftTimersRef.current[projectId]
      await (persistQueueRef.current[projectId] ?? Promise.resolve())
      await deleteWorkspace(projectId)
      delete workspaceStoreRef.current[projectId]
      delete workspaceRevisionRef.current[projectId]
      delete workspaceEpochRef.current[projectId]
      setWorkspaces((items) => items.filter((item) => item.project.id !== projectId))
      if (workspace?.project.id === projectId) goHome()
    } catch { setError(tr('error.generic')) }
  }

  const setDraft = async (challengeId: string, answer: string) => {
    if (!workspace) return
    const projectId = workspace.project.id
    const currentWorkspace = workspaceStoreRef.current[projectId] ?? workspace
    const next = { ...currentWorkspace, draftAnswers: { ...currentWorkspace.draftAnswers, [challengeId]: answer } }
    workspaceRevisionRef.current[projectId] = (workspaceRevisionRef.current[projectId] ?? 0) + 1
    workspaceStoreRef.current[projectId] = next
    workspaceRef.current = next
    setWorkspace(next)
    setWorkspaces((items) => items.map((item) => item.project.id === next.project.id ? next : item))
    if (draftTimersRef.current[projectId]) window.clearTimeout(draftTimersRef.current[projectId])
    draftTimersRef.current[projectId] = window.setTimeout(() => {
      const latest = workspaceStoreRef.current[projectId]
      if (latest) void persist(latest).catch(() => { if (isCurrentProject(projectId)) setError(tr('error.generic')) })
    }, 250)
  }

  const createChallenge = async (node: NodeRecord) => {
    if (!workspace) return
    const projectId = workspace.project.id
    const operationEpoch = workspaceEpochRef.current[projectId] ?? 0
    let research: ResearchEvidence | null = null
    setNodeOperation(projectId, node.id, 'challenge'); setError('')
    try {
      if (!connectorStatus.connected || !connectorStatus.authenticated) throw new ConnectorError(tr('error.connector'), 'offline')
      const result = await connector.challengeCreate({ topic: workspace.project.topic, node, goal: workspace.project.goal, curriculumContext: workspace.project.curriculumContext, challengeMode: workspace.project.challengeMode || 'explain', researchMode: workspace.project.researchMode, resources: workspace.resources.filter((item) => node.resourceIds.includes(item.id)), mastery: node.masteryState, recentAttempts: workspace.attempts.filter((item) => item.nodeId === node.id).slice(-3) }, undefined, (evidence) => { research = evidence })
      const generatedChallenge = ChallengeSchema.parse(result) as Challenge
      if ((workspaceEpochRef.current[projectId] ?? 0) !== operationEpoch) throw new ConnectorError('The learning tree was replaced or deleted while the challenge was being generated.', 'stale_operation')
      await persistProject(projectId, (latestWorkspace) => {
        const latestNode = latestWorkspace.tree.nodes[node.id]
        if (!latestNode) return latestWorkspace
        let challengeId = generatedChallenge.id
        while (latestWorkspace.challenges.some((item) => item.id === challengeId)) challengeId = `challenge-${crypto.randomUUID()}`
        const allowedResourceIds = new Set(latestWorkspace.resources.filter((item) => latestNode.resourceIds.includes(item.id)).map((item) => item.id))
        const checked: Challenge = { ...generatedChallenge, id: challengeId, nodeId: node.id, resourceIds: generatedChallenge.resourceIds.filter((id) => allowedResourceIds.has(id)) }
        const nextNode = { ...latestNode, challengeIds: [...new Set([...latestNode.challengeIds, checked.id])], updatedAt: new Date().toISOString() }
        return { ...latestWorkspace, tree: { ...latestWorkspace.tree, nodes: { ...latestWorkspace.tree.nodes, [node.id]: nextNode } }, challenges: [...latestWorkspace.challenges, checked], research: research ? [...latestWorkspace.research, researchRecord('challenge_create', `${latestWorkspace.project.topic} / ${latestNode.title}`, latestWorkspace.project.researchMode, research, { nodeId: node.id, challengeId: checked.id, resourceIds: checked.resourceIds, summary: '追加問題の調査' })] : latestWorkspace.research }
      }, 'challenge-created')
    } catch (caught) { if (isCurrentProject(projectId)) { setNodeGrade(projectId, node.id, null); setError(operationErrorMessage(caught, tr)) } } finally { setNodeOperation(projectId, node.id, null) }
  }

  const mergeExpansion = (base: Workspace, nodeId: string, expansion: Awaited<ReturnType<ConnectorClient['nodeExpand']>>, branchCount: number): Workspace => {
    const parsedNodes = expansion.nodes.slice(0, branchCount).map((item) => {
      const raw = item as Record<string, unknown>
      const parsed = NodeSchema.parse(raw) as NodeRecord
      // The connector suggests concepts; the client owns graph integrity.
      // Each appended branch has exactly the node being expanded as its
      // prerequisite, so an invalid or stale AI edge cannot create a hidden
      // dependency or a dangling reference.
      return { ...parsed, status: 'unlocked' as const, xp: 0, masteryState: 'familiar' as const, prerequisites: [nodeId], children: [] }
    })
    if (parsedNodes.length !== branchCount) throw new Error('Expansion returned the wrong number of nodes')
    const parsedResources = expansion.resources.map((item) => ResourceSchema.parse(item) as Resource).slice(0, 8)
    const parsedChallenges = expansion.challenges.slice(0, branchCount).map((item) => ChallengeSchema.parse(item) as Challenge)
    if (parsedChallenges.length !== branchCount) throw new Error('Expansion returned the wrong number of challenges')
    const currentPosition = base.tree.nodes[nodeId]?.position || { x: 70, y: 270 }
    const nodeMap: Record<string, NodeRecord> = { ...base.tree.nodes }
    const usedNodeIds = new Set(Object.keys(nodeMap))
    const usedChallengeIds = new Set(base.challenges.map((item) => item.id))
    const laidOutNodes: NodeRecord[] = []
    const newEdges: Edge[] = []
    parsedNodes.forEach((item, index) => {
      let newId = item.id
      while (usedNodeIds.has(newId)) newId = `${item.id}-${crypto.randomUUID().slice(0, 8)}`
      usedNodeIds.add(newId)
      let challengeId = parsedChallenges[index].id
      while (usedChallengeIds.has(challengeId)) challengeId = `${parsedChallenges[index].id}-${crypto.randomUUID().slice(0, 8)}`
      usedChallengeIds.add(challengeId)
      const position = findFreePosition(nodeMap, { x: currentPosition.x + NODE_WIDTH + 86, y: currentPosition.y + (index - (branchCount - 1) / 2) * (NODE_HEIGHT + NODE_GAP) }, laidOutNodes.map((node) => node.position))
      const child = { ...item, id: newId, position, challengeIds: [challengeId], resourceIds: item.resourceIds.filter((id) => parsedResources.some((resource) => resource.id === id) || base.resources.some((resource) => resource.id === id)), updatedAt: new Date().toISOString() }
      laidOutNodes.push(child); nodeMap[newId] = child
      newEdges.push({ from: nodeId, to: newId, type: 'dependency' })
      parsedChallenges[index] = { ...parsedChallenges[index], id: challengeId, nodeId: newId, resourceIds: parsedChallenges[index].resourceIds.filter((id) => parsedResources.some((resource) => resource.id === id) || base.resources.some((resource) => resource.id === id)) }
    })
    const current = nodeMap[nodeId]
    const linkedCurrent = current ? { ...current, children: [...new Set([...current.children, ...laidOutNodes.map((item) => item.id)])], updatedAt: new Date().toISOString() } : current
    return {
      ...base,
      tree: { ...base.tree, nodes: { ...nodeMap, ...(linkedCurrent ? { [nodeId]: linkedCurrent } : {}) }, edges: [...base.tree.edges, ...newEdges] },
      resources: [...base.resources, ...parsedResources.filter((item) => !base.resources.some((old) => old.id === item.id))],
      challenges: [...base.challenges, ...parsedChallenges],
    }
  }

  const createManualNode = async (title: string, position: { x: number; y: number }) => {
    if (!workspace || !title.trim()) return
    const projectId = workspace.project.id
    const operationEpoch = workspaceEpochRef.current[projectId] ?? 0
    const operationId = `manual-${crypto.randomUUID()}`
    let research: ResearchEvidence | null = null
    setNodeOperation(projectId, operationId, 'manual-create'); setError('')
    try {
      if (!connectorStatus.connected || !connectorStatus.authenticated) throw new ConnectorError(tr('error.connector'), 'offline')
      const generated = await connector.nodeCreate({ title: title.trim(), topic: workspace.project.topic, goal: workspace.project.goal, researchMode: workspace.project.researchMode, challengeMode: workspace.project.challengeMode || 'explain', curriculumContext: workspace.project.curriculumContext, existingNodes: Object.values(workspace.tree.nodes).map((item) => ({ id: item.id, title: item.title, goal: item.goal })) }, undefined, (evidence) => { research = evidence })
      const rawNode = NodeCreateSchema.parse(generated.node)
      const resources = generated.resources.map((item) => ResourceSchema.parse(item) as Resource)
      const rawChallenge = ChallengeSchema.parse(generated.challenges[0]) as Challenge
      if ((workspaceEpochRef.current[projectId] ?? 0) !== operationEpoch) throw new ConnectorError('The learning tree was replaced or deleted while the node was being generated.', 'stale_operation')
      await persistProject(projectId, (latestWorkspace) => {
        const nodeId = latestWorkspace.tree.nodes[rawNode.id] ? `node-${crypto.randomUUID()}` : rawNode.id
        const challengeId = latestWorkspace.challenges.some((item) => item.id === rawChallenge.id) ? `challenge-${crypto.randomUUID()}` : rawChallenge.id
        const freePosition = findFreePosition(latestWorkspace.tree.nodes, position)
        const challenge = { ...rawChallenge, id: challengeId, nodeId, resourceIds: rawChallenge.resourceIds.filter((id) => resources.some((item) => item.id === id) || latestWorkspace.resources.some((item) => item.id === id)) }
        const now = new Date().toISOString()
        const node: NodeRecord = { ...rawNode, id: nodeId, status: 'unlocked', xp: 0, masteryState: 'familiar', prerequisites: [], children: [], challengeIds: [challengeId], resourceIds: challenge.resourceIds, position: freePosition, createdAt: now, updatedAt: now }
        return { ...latestWorkspace, tree: { ...latestWorkspace.tree, nodes: { ...latestWorkspace.tree.nodes, [nodeId]: node } }, challenges: [...latestWorkspace.challenges, challenge], resources: [...latestWorkspace.resources, ...resources.filter((item) => !latestWorkspace.resources.some((old) => old.id === item.id))], research: research ? [...latestWorkspace.research, researchRecord('node_create', `${latestWorkspace.project.topic} / ${title.trim()}`, latestWorkspace.project.researchMode, research, { nodeId, challengeId, resourceIds: challenge.resourceIds, generatedNodeIds: [nodeId], summary: '手動追加ノードの調査' })] : latestWorkspace.research }
      }, 'manual-node-created')
    } catch (caught) {
      if (isCurrentProject(projectId)) setError(caught instanceof ConnectorError && caught.code === 'invalid_output' ? tr('error.invalidOutput') : caught instanceof Error ? caught.message : tr('error.generic'))
    } finally { setNodeOperation(projectId, operationId, null) }
  }

  const submitAnswer = async (node: NodeRecord, challenge: Challenge, answer: string) => {
    if (!workspace || !answer.trim()) return
    const projectId = workspace.project.id
    const operationEpoch = workspaceEpochRef.current[projectId] ?? 0
    let gradeSaved = false
    let gradeResearch: ResearchEvidence | null = null
    setNodeOperation(projectId, node.id, 'grade'); setError('')
    try {
      if (!connectorStatus.connected || !connectorStatus.authenticated) throw new ConnectorError(tr('error.connector'), 'offline')
      const initialLog = ['採点を開始しています…']
      const pendingResponse: GradeResponse = { grade: 'C', summary: '', correct: [], missing: [], misconceptions: [], nuance: [], recommendedAction: 'retry', recommendedNodeIds: [] }
      setNodeLog(projectId, node.id, initialLog)
      setNodeGrade(projectId, node.id, { response: pendingResponse, xpAwarded: 0, unlockedIds: [], nodeId: node.id, challengeId: challenge.id, attemptId: 'pending', progress: initialLog, progressLabel: '採点中' })
      const response = await connector.answerGrade({ challenge, node, sourceContext: workspace.resources.filter((item) => challenge.resourceIds.includes(item.id)), answer, recentAttempts: workspace.attempts.filter((item) => item.nodeId === node.id).slice(-3) }, (message) => {
        setNodeGradingLogs((current) => {
          const key = projectNodeKey(projectId, node.id)
          const next = [...(current[key] || []), message]
          setNodeGrade(projectId, node.id, (grade) => grade?.attemptId === 'pending' ? { ...grade, progress: next } : grade)
          return { ...current, [key]: next }
        })
      }, (evidence) => { gradeResearch = evidence })
      if ((workspaceEpochRef.current[projectId] ?? 0) !== operationEpoch) throw new ConnectorError('The learning tree was replaced or deleted while the answer was being graded.', 'stale_operation')
      const resultRef: { value?: ReturnType<typeof applyGrade> } = {}
      await persistProject(projectId, (latestWorkspace) => {
        const latestNode = latestWorkspace.tree.nodes[node.id]
        if (!latestNode) return latestWorkspace
        const applied = applyGrade(latestWorkspace, latestNode.id, challenge.id, answer, response)
        resultRef.value = applied
        return gradeResearch ? { ...applied.workspace, research: [...applied.workspace.research, researchRecord('answer_grade', `${applied.workspace.project.topic} / ${challenge.prompt}`, applied.workspace.project.researchMode, gradeResearch, { nodeId: node.id, challengeId: challenge.id, resourceIds: challenge.resourceIds, summary: '回答採点時の検証調査', unknownClaims: [...response.nuance, response.nextStep || ''].filter((item) => item.includes('確認できない')) })] } : applied.workspace
      })
      const result = resultRef.value
      if (!result) return
      gradeSaved = true
      setNodeGrade(projectId, node.id, { response, xpAwarded: result.attempt.xpAwarded, unlockedIds: result.unlockedIds, nodeId: node.id, challengeId: challenge.id, attemptId: result.attempt.id })
      // The first answer is enough context to personalize the next three
      // concepts. Mastery still controls XP/status; expansion is independent
      // so learners are not forced to repeat the same starter question first.
      const gradedWorkspace = workspaceStoreRef.current[projectId] ?? result.workspace
      const gradedNode = gradedWorkspace.tree.nodes[node.id]
      if (gradedNode?.children.length === 0 && connectorStatus.connected && connectorStatus.authenticated) {
        setNodeOperation(projectId, node.id, 'expand')
        setNodeGrade(projectId, node.id, (grade) => grade ? { ...grade, progressLabel: '領域を調査中' } : grade)
        try {
          let expansionResearch: ResearchEvidence | null = null
          const expansion = await connector.nodeExpand({ topic: gradedWorkspace.project.topic, node: gradedNode, answeredChallenge: challenge, recentAttempts: gradedWorkspace.attempts.filter((item) => item.nodeId === node.id).slice(-3), nearbyNodes: Object.values(gradedWorkspace.tree.nodes).filter((item) => gradedNode.children.includes(item.id) || gradedNode.prerequisites.includes(item.id)), goal: gradedWorkspace.project.goal, curriculumContext: gradedWorkspace.project.curriculumContext, researchMode: gradedWorkspace.project.researchMode, challengeMode: gradedWorkspace.project.challengeMode || 'explain', branchCount: 3, existingResources: gradedWorkspace.resources }, (message) => {
            setNodeGradingLogs((current) => {
              const key = projectNodeKey(projectId, node.id)
              const next = [...(current[key] || []), message]
              setNodeGrade(projectId, node.id, (grade) => grade?.attemptId === result.attempt.id ? { ...grade, progress: next } : grade)
              return { ...current, [key]: next }
            })
          }, (evidence) => { expansionResearch = evidence })
          if ((workspaceEpochRef.current[projectId] ?? 0) !== operationEpoch) throw new ConnectorError('The learning tree was replaced or deleted while branches were being generated. The answer was saved.', 'stale_operation')
          const latestBeforeExpansion = workspaceStoreRef.current[projectId] ?? gradedWorkspace
          await saveSnapshot(latestBeforeExpansion, 'before-expansion')
          await persistProject(projectId, (latestWorkspace) => {
            const expanded = mergeExpansion(latestWorkspace, node.id, expansion, 3)
            return expansionResearch ? { ...expanded, research: [...expanded.research, researchRecord('node_expand', `${expanded.project.topic} / ${gradedNode.title}`, expanded.project.researchMode, expansionResearch, { nodeId: node.id, generatedNodeIds: expansion.nodes.map((item) => String((item as Record<string, unknown>).id || '')), summary: '回答後の次ノード調査' })] } : expanded
          })
        } catch (expansionError) {
          if (isCurrentProject(projectId)) setError(expansionError instanceof Error ? expansionError.message : tr('error.generic'))
        }
      }
      setNodeGrade(projectId, node.id, { response, xpAwarded: result.attempt.xpAwarded, unlockedIds: result.unlockedIds, nodeId: node.id, challengeId: challenge.id, attemptId: result.attempt.id })
      if (isCurrentProject(projectId)) setNotice(result.clearedNow || result.unlockedIds.length ? tr('grade.unlocked') : tr('grade.xpEarned', { xp: result.attempt.xpAwarded }))
    } catch (caught) { if (isCurrentProject(projectId)) { if (!gradeSaved) setNodeGrade(projectId, node.id, null); setError(operationErrorMessage(caught, tr)) } } finally { setNodeOperation(projectId, node.id, null) }
  }

  const expandNode = async (node: NodeRecord, branchCount = 3) => {
    if (!workspace) return
    const projectId = workspace.project.id
    const operationEpoch = workspaceEpochRef.current[projectId] ?? 0
    let expansionResearch: ResearchEvidence | null = null
    setNodeOperation(projectId, node.id, 'expand'); setError('')
    try {
      if (!connectorStatus.connected || !connectorStatus.authenticated) throw new ConnectorError(tr('error.connector'), 'offline')
      const initialLog = ['領域の調査を開始しています…']
      setGradingLog(initialLog)
      const pendingResponse: GradeResponse = { grade: 'C', summary: '', correct: [], missing: [], misconceptions: [], nuance: [], recommendedAction: 'branch', recommendedNodeIds: [] }
      setNodeLog(projectId, node.id, initialLog)
      setNodeGrade(projectId, node.id, { response: pendingResponse, xpAwarded: 0, unlockedIds: [], nodeId: node.id, attemptId: 'pending', progress: initialLog, progressLabel: '領域を調査中' })
      const expansion = await connector.nodeExpand({ topic: workspace.project.topic, node, recentAttempts: workspace.attempts.filter((item) => item.nodeId === node.id).slice(-3), nearbyNodes: Object.values(workspace.tree.nodes).filter((item) => node.children.includes(item.id) || node.prerequisites.includes(item.id)), goal: workspace.project.goal, curriculumContext: workspace.project.curriculumContext, researchMode: workspace.project.researchMode, challengeMode: workspace.project.challengeMode || 'explain', branchCount, existingResources: workspace.resources }, (message) => {
        setNodeGradingLogs((current) => {
          const key = projectNodeKey(projectId, node.id)
          const next = [...(current[key] || []), message]
          setNodeGrade(projectId, node.id, (grade) => grade?.attemptId === 'pending' ? { ...grade, progress: next } : grade)
          return { ...current, [key]: next }
        })
      }, (evidence) => { expansionResearch = evidence })
      if ((workspaceEpochRef.current[projectId] ?? 0) !== operationEpoch) throw new ConnectorError('The learning tree was replaced or deleted while branches were being generated.', 'stale_operation')
      const latestWorkspace = workspaceStoreRef.current[projectId] ?? workspace
      if (!latestWorkspace.tree.nodes[node.id]) return
      await saveSnapshot(latestWorkspace, 'before-expansion')
      await persistProject(projectId, (currentWorkspace) => {
        const expanded = mergeExpansion(currentWorkspace, node.id, expansion, branchCount)
        return expansionResearch ? { ...expanded, research: [...expanded.research, researchRecord('node_expand', `${expanded.project.topic} / ${node.title}`, expanded.project.researchMode, expansionResearch, { nodeId: node.id, generatedNodeIds: expansion.nodes.map((item) => String((item as Record<string, unknown>).id || '')), summary: '次ノード生成時の領域調査' })] } : expanded
      })
      setNodeGrade(projectId, node.id, null)
    } catch (caught) { if (isCurrentProject(projectId)) { setNodeGrade(projectId, node.id, null); setError(operationErrorMessage(caught, tr)) } } finally { setNodeOperation(projectId, node.id, null) }
  }

  const refresh = () => { void connector.status().then(setConnectorStatus) }

  if (screen === 'create') return <><CreateScreen lang={lang} tr={tr} mode={createMode} setMode={setCreateMode} form={createForm} setForm={setCreateForm} manualForm={manualForm} setManualForm={setManualForm} busy={busy === 'propose' || busy === 'manual-create'} error={error} onSubmit={handlePropose} onManualSubmit={handleManualCreate} onCancel={goHome} connectorStatus={connectorStatus} />{(busy === 'propose' || busy === 'manual-create') && <div className="create-progress-floating"><GradingLog items={gradingLog} label={busy === 'manual-create' ? 'ツリーを作成中' : 'ツリーを調査中'} /></div>}</>
  if (screen === 'proposals') return <><ProposalScreen lang={lang} tr={tr} proposals={proposals} topic={createForm.topic} busy={busy === 'save'} error={error} onChoose={chooseProposal} onBack={() => setScreen('create')} /></>
  if (screen === 'tree' && workspace) return <>
    <TreeScreen workspace={workspace} lang={lang} tr={tr} selectedNodeId={selectedNodeId} setSelectedNodeId={setSelectedNodeId} connectorStatus={connectorStatus} nodeBusy={nodeBusy} lastGrades={lastGrades} nodeGradingLogs={nodeGradingLogs} error={error} notice={notice} onBack={goHome} onSettings={() => setSettingsOpen(true)} onImport={() => fileInputRef.current?.click()} onExport={exportWorkspace} onDraft={setDraft} onCreateChallenge={createChallenge} onSubmit={submitAnswer} onExpand={expandNode} onManualNode={createManualNode} onRetry={() => { if (selectedNodeId) setNodeGrade(workspace.project.id, selectedNodeId, null) }} onRefreshConnector={refresh} onClearMessage={() => { setError(''); setNotice('') }} />
     {settingsOpen && <SettingsModal settings={settings} currentModel={connectorStatus.model} currentReasoningEffort={connectorStatus.reasoningEffort} models={availableModels} modelsLoading={modelsLoading} modelsError={modelsError} lang={lang} tr={tr} onClose={() => setSettingsOpen(false)} onSave={updateSettings} />}
  </>
  return <>
    <HomeScreen workspaces={workspaces} lang={lang} tr={tr} connectorStatus={connectorStatus} error={error} onNew={() => { setError(''); setCreateMode('ai'); setScreen('create') }} onOpen={openWorkspace} onImport={() => fileInputRef.current?.click()} onExport={exportWorkspace} onSettings={() => setSettingsOpen(true)} onHelp={() => setHelpOpen(true)} onRefreshConnector={refresh} onDelete={deleteProject} />
    <input ref={fileInputRef} hidden type="file" accept="application/json,.json,.challenge-tree" onChange={importSave} />
    {settingsOpen && <SettingsModal settings={settings} currentModel={connectorStatus.model} currentReasoningEffort={connectorStatus.reasoningEffort} models={availableModels} modelsLoading={modelsLoading} modelsError={modelsError} lang={lang} tr={tr} onClose={() => setSettingsOpen(false)} onSave={updateSettings} />}
    {helpOpen && <HelpModal lang={lang} tr={tr} onClose={() => setHelpOpen(false)} />}
  </>
}

function Header({ lang, tr, connectorStatus, onSettings, onBack, onImport, onExport }: { lang: UiLanguage; tr: (key: string, vars?: Record<string, string | number>) => string; connectorStatus: ConnectorStatus; onSettings?: () => void; onBack?: () => void; onImport?: () => void; onExport?: () => void }) {
  return <header className="topbar">
    <div className="brand-lockup" onClick={onBack} onKeyDown={(event) => { if (onBack && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onBack() } }} role={onBack ? 'button' : undefined} tabIndex={onBack ? 0 : undefined}>
      <img src={`${import.meta.env.BASE_URL}assets/challenge-tree-logo.svg`} alt="" className="brand-mark" />
      <span>{tr('app.name')}</span>
    </div>
    <div className="topbar-actions">
      <ConnectorPill status={connectorStatus} tr={tr} />
      {onImport && <button className="quiet-button" onClick={onImport} aria-label={tr('home.import')} title={tr('home.import')}><Icon name="upload" /><span className="workspace-action-label">{tr('home.import')}</span></button>}
      {onExport && <button className="quiet-button" onClick={onExport} aria-label={tr('home.export')} title={tr('home.export')}><Icon name="download" /><span className="workspace-action-label">{tr('home.export')}</span></button>}
      {onSettings && <button className="icon-button settings-button" onClick={onSettings} aria-label={tr('nav.settings')}><Icon name="settings" /></button>}
    </div>
  </header>
}

function HomeScreen({ workspaces, lang, tr, connectorStatus, error, onNew, onOpen, onImport, onExport, onSettings, onHelp, onRefreshConnector, onDelete }: { workspaces: Workspace[]; lang: UiLanguage; tr: (key: string, vars?: Record<string, string | number>) => string; connectorStatus: ConnectorStatus; error: string; onNew: () => void; onOpen: (id: string) => void; onImport: () => void; onExport: () => void; onSettings: () => void; onHelp: () => void; onRefreshConnector: () => void; onDelete: (id: string) => void }) {
  return <div className="app-frame home-frame"><Header lang={lang} tr={tr} connectorStatus={connectorStatus} onImport={onImport} onExport={onExport} onSettings={onSettings} />
    <main className="home-content">
      <section className="home-intro"><p className="eyebrow">{tr('app.tagline')}</p><h1>{tr('app.name')}</h1></section>
      {error && <ErrorBanner message={error} />}
      <div className="home-actions"><button className="primary-button" onClick={onNew}><Icon name="plus" /> {tr('home.newTree')}</button><p className="form-note">{tr('home.workspaceSaveHint')}</p></div>
      <section className="project-section"><div className="section-heading"><div><p className="eyebrow">{tr('home.continue')}</p><h2>{tr('home.projects')}</h2></div><span className="save-mark"><span className="status-dot good" /> {tr('home.saved')}</span></div>
        {workspaces.length === 0 ? <div className="empty-state">{tr('home.noProjects')}</div> : <div className="project-list">{workspaces.map((item) => <ProjectRow key={item.project.id} workspace={item} tr={tr} onOpen={() => onOpen(item.project.id)} onDelete={() => onDelete(item.project.id)} />)}</div>}
      </section>
      <section className="connector-panel"><div className="section-heading"><div><p className="eyebrow">{tr('home.connector')}</p><h2><span className={`status-dot ${connectorStatus.connected ? 'good' : 'muted'}`} /> {connectorStatus.connected && connectorStatus.authenticated ? tr('home.connected') : tr('home.notRunning')}</h2></div><button className="quiet-button" onClick={onRefreshConnector}><Icon name="refresh" /> {tr('home.retry')}</button></div><p>{tr('home.connectHint')}</p><ConnectorDiagnostics status={connectorStatus} tr={tr} /><button className="text-button" onClick={onHelp}>{tr('home.download')} <Icon name="arrow" /></button></section>
    </main><footer className="app-footer"><span>{tr('footer.local')}</span><span>{tr('footer.version')}</span></footer>
  </div>
}

function ProjectRow({ workspace, tr, onOpen, onDelete }: { workspace: Workspace; tr: (key: string, vars?: Record<string, string | number>) => string; onOpen: () => void; onDelete: () => void }) {
  const progress = getProgress(workspace.tree)
  return <article className="project-row"><button className="project-main" onClick={onOpen}><span className="project-glyph"><Icon name="branch" /></span><span className="project-copy"><strong>{workspace.project.title}</strong><small>{workspace.project.topic}</small></span><span className="project-meta">{tr('home.nodesSummary', { nodes: progress.total, completed: progress.completed })}</span><Icon name="arrow" /></button><button className="row-delete" onClick={onDelete} aria-label={tr('home.delete')}><Icon name="trash" /></button></article>
}

function CreateScreen({ lang, tr, mode, setMode, form, setForm, manualForm, setManualForm, busy, error, onSubmit, onManualSubmit, onCancel, connectorStatus }: { lang: UiLanguage; tr: (key: string, vars?: Record<string, string | number>) => string; mode: CreateMode; setMode: (mode: CreateMode) => void; form: { topic: string; goal: string; researchMode: 'ja' | 'global'; challengeMode: ChallengeMode; priorKnowledge: string }; setForm: (form: { topic: string; goal: string; researchMode: 'ja' | 'global'; challengeMode: ChallengeMode; priorKnowledge: string }) => void; manualForm: ManualTreeForm; setManualForm: (form: ManualTreeForm) => void; busy: boolean; error: string; onSubmit: (event: FormEvent) => void; onManualSubmit: (event: FormEvent) => void; onCancel: () => void; connectorStatus: ConnectorStatus }) {
  const updateManual = (key: keyof ManualTreeForm, value: string) => setManualForm({ ...manualForm, [key]: value })
  return <div className="app-frame"><Header lang={lang} tr={tr} connectorStatus={connectorStatus} onBack={onCancel} /><main className="form-shell"><button className="back-link" onClick={onCancel}><Icon name="back" /> {tr('nav.back')}</button><section className="form-intro"><p className="eyebrow">{tr('create.eyebrow')}</p><h1>{mode === 'manual' ? tr('manual.title') : tr('create.title')}</h1><p>{mode === 'manual' ? tr('manual.description') : tr('create.description')}</p></section>{error && <ErrorBanner message={error} />}<CreateModePicker mode={mode} setMode={setMode} tr={tr} />{mode === 'ai' ? <form className="tree-form" onSubmit={onSubmit}><label>{tr('create.topic')}<input autoFocus value={form.topic} onChange={(event) => setForm({ ...form, topic: event.target.value })} placeholder={tr('create.topicPlaceholder')} /></label><label>{tr('create.goal')}<textarea rows={4} value={form.goal} onChange={(event) => setForm({ ...form, goal: event.target.value })} placeholder={tr('create.goalPlaceholder')} /></label><fieldset><legend>{tr('create.researchMode')}</legend><div className="mode-options"><label className={`mode-option ${form.researchMode === 'ja' ? 'selected' : ''}`}><input type="radio" name="research-mode" checked={form.researchMode === 'ja'} onChange={() => setForm({ ...form, researchMode: 'ja' })} /><span><strong>{tr('create.ja')}</strong><small>{tr('create.jaHint')}</small></span></label><label className={`mode-option ${form.researchMode === 'global' ? 'selected' : ''}`}><input type="radio" name="research-mode" checked={form.researchMode === 'global'} onChange={() => setForm({ ...form, researchMode: 'global' })} /><span><strong>{tr('create.global')}</strong><small>{tr('create.globalHint')}</small></span></label></div></fieldset><ChallengeModePicker lang={lang} value={form.challengeMode} onChange={(challengeMode) => setForm({ ...form, challengeMode })} /><details className="advanced-options"><summary>{tr('create.advanced')}<small>{tr('create.advancedHint')}</small></summary><label>{tr('create.prior')}<select value={form.priorKnowledge} onChange={(event) => setForm({ ...form, priorKnowledge: event.target.value })}><option value="auto">{tr('create.auto')}</option><option value="beginner">{tr('create.beginner')}</option><option value="intermediate">{tr('create.intermediate')}</option><option value="advanced">{tr('create.advancedLevel')}</option></select></label></details><div className="form-actions"><button type="button" className="secondary-button" onClick={onCancel}>{tr('create.cancel')}</button><button className="primary-button" disabled={busy || !connectorStatus.connected || !connectorStatus.authenticated}>{busy ? tr('proposal.loading') : tr('create.submit')}</button></div>{!connectorStatus.connected && <p className="form-note"><span className="status-dot muted" /> {tr('home.connectHint')}</p>}</form> : <form className="tree-form" onSubmit={onManualSubmit}><label>{tr('manual.treeTitle')}<input autoFocus value={manualForm.title} onChange={(event) => updateManual('title', event.target.value)} placeholder={tr('manual.treeTitlePlaceholder')} /></label><label>{tr('create.topic')}<input value={manualForm.topic} onChange={(event) => updateManual('topic', event.target.value)} placeholder={tr('manual.topicPlaceholder')} /></label><label>{tr('create.goal')}<textarea rows={3} value={manualForm.goal} onChange={(event) => updateManual('goal', event.target.value)} placeholder={tr('manual.goalPlaceholder')} /></label><fieldset><legend>{tr('create.researchMode')}</legend><div className="mode-options"><label className={`mode-option ${manualForm.researchMode === 'ja' ? 'selected' : ''}`}><input type="radio" name="manual-research-mode" checked={manualForm.researchMode === 'ja'} onChange={() => setManualForm({ ...manualForm, researchMode: 'ja' })} /><span><strong>{tr('create.ja')}</strong><small>{tr('create.jaHint')}</small></span></label><label className={`mode-option ${manualForm.researchMode === 'global' ? 'selected' : ''}`}><input type="radio" name="manual-research-mode" checked={manualForm.researchMode === 'global'} onChange={() => setManualForm({ ...manualForm, researchMode: 'global' })} /><span><strong>{tr('create.global')}</strong><small>{tr('create.globalHint')}</small></span></label></div></fieldset><ChallengeModePicker lang={lang} value={manualForm.challengeMode} onChange={(challengeMode) => setManualForm({ ...manualForm, challengeMode })} /><details className="advanced-options" open><summary>{tr('manual.context')}</summary><label>{tr('manual.philosophy')}<textarea rows={2} value={manualForm.philosophy} onChange={(event) => updateManual('philosophy', event.target.value)} placeholder={tr('manual.philosophyPlaceholder')} /></label><label>{tr('manual.learner')}<textarea rows={2} value={manualForm.learnerProfile} onChange={(event) => updateManual('learnerProfile', event.target.value)} placeholder={tr('manual.learnerPlaceholder')} /></label><label>{tr('manual.branches')}<textarea rows={2} value={manualForm.branches} onChange={(event) => updateManual('branches', event.target.value)} placeholder={tr('manual.branchesPlaceholder')} /></label><label>{tr('manual.advantages')}<textarea rows={2} value={manualForm.advantages} onChange={(event) => updateManual('advantages', event.target.value)} placeholder={tr('manual.advantagesPlaceholder')} /></label><label>{tr('manual.tradeoffs')}<textarea rows={2} value={manualForm.tradeoffs} onChange={(event) => updateManual('tradeoffs', event.target.value)} placeholder={tr('manual.tradeoffsPlaceholder')} /></label></details><div className="form-actions"><button type="button" className="secondary-button" onClick={onCancel}>{tr('create.cancel')}</button><button className="primary-button" disabled={busy || !connectorStatus.connected || !connectorStatus.authenticated}>{busy ? tr('proposal.loading') : tr('manual.submit')}</button></div>{!connectorStatus.connected && <p className="form-note"><span className="status-dot muted" /> {tr('home.connectHint')}</p>}</form>}</main></div>
}

function CreateModePicker({ mode, setMode, tr }: { mode: CreateMode; setMode: (mode: CreateMode) => void; tr: (key: string, vars?: Record<string, string | number>) => string }) {
  const options: Array<[CreateMode, string, string]> = [['ai', tr('create.aiMethod'), tr('create.aiMethodHint')], ['manual', tr('create.manualMethod'), tr('create.manualMethodHint')]]
  return <fieldset className="create-mode-picker"><legend>{tr('create.method')}</legend><div className="create-mode-options">{options.map(([value, title, hint]) => <button type="button" key={value} className={`create-mode-option ${mode === value ? 'selected' : ''}`} aria-pressed={mode === value} onClick={() => setMode(value)}><span className="mode-choice-mark" aria-hidden="true" /><span><strong>{title}</strong><small>{hint}</small></span></button>)}</div></fieldset>
}

function ProposalScreen({ lang, tr, proposals, topic, busy, error, onChoose, onBack }: { lang: UiLanguage; tr: (key: string, vars?: Record<string, string | number>) => string; proposals: Proposal[]; topic: string; busy: boolean; error: string; onChoose: (proposal: Proposal) => void; onBack: () => void }) {
  return <div className="app-frame"><Header lang={lang} tr={tr} connectorStatus={{ connected: true, authenticated: true }} onBack={onBack} /><main className="proposal-shell"><button className="back-link" onClick={onBack}><Icon name="back" /> {tr('nav.back')}</button><section className="form-intro"><p className="eyebrow">{tr('proposal.eyebrow')}</p><h1>{tr('proposal.title', { topic })}</h1><p>{tr('proposal.description')}</p></section>{error && <ErrorBanner message={error} />}<div className="proposal-grid">{proposals.map((proposal, index) => <article className="proposal-card" key={proposal.id}><div className="proposal-index">{String.fromCharCode(65 + index)}</div><h2>{proposal.title}</h2><section><h3>{tr('proposal.philosophy')}</h3><p>{proposal.philosophy}</p></section><section><h3>{tr('proposal.for')}</h3><p>{proposal.learnerProfile}</p></section><section><h3>{tr('proposal.branches')}</h3><div className="branch-list">{proposal.branches.map((branch) => <span key={branch}>{branch}</span>)}</div></section><section><h3>{tr('proposal.advantages')}</h3><ul>{proposal.advantages.map((item) => <li key={item}>{item}</li>)}</ul></section><section className="tradeoff"><h3>{tr('proposal.tradeoffs')}</h3><p>{proposal.tradeoffs}</p></section><button className="secondary-button full-button" disabled={busy} onClick={() => onChoose(proposal)}>{busy ? tr('node.saving') : tr('proposal.choose')} <Icon name="arrow" /></button></article>)}</div></main></div>
}

function ChallengeModePicker({ lang, value, onChange }: { lang: UiLanguage; value: ChallengeMode; onChange: (value: ChallengeMode) => void }) {
  const options: Array<[ChallengeMode, string, string]> = [['explain', lang === 'ja' ? '説明式' : 'Explain', lang === 'ja' ? '自由記述で説明する' : 'Explain in your own words'], ['short_answer', lang === 'ja' ? '短答式' : 'Short answer', lang === 'ja' ? '短い答えを3問' : 'Three short answers'], ['true_false', lang === 'ja' ? '正誤式' : 'True / False', lang === 'ja' ? '正誤を5問' : 'Five true-or-false questions']]
  return <section className="challenge-mode-picker"><p className="eyebrow">{lang === 'ja' ? '問題形式' : 'Challenge format'}</p><div className="challenge-mode-options">{options.map(([mode, title, hint]) => <label key={mode} className={`challenge-mode-option ${value === mode ? 'selected' : ''}`}><input type="radio" name="challenge-mode" checked={value === mode} onChange={() => onChange(mode)} /><span className="mode-choice-mark" aria-hidden="true" /><span className="mode-choice-copy"><strong>{title}</strong><small>{hint}</small></span></label>)}</div></section>
}

function TreeScreen({ workspace, lang, tr, selectedNodeId, setSelectedNodeId, connectorStatus, nodeBusy, lastGrades, nodeGradingLogs, error, notice, onBack, onSettings, onImport, onExport, onDraft, onCreateChallenge, onSubmit, onExpand, onManualNode, onRetry, onRefreshConnector, onClearMessage }: { workspace: Workspace; lang: UiLanguage; tr: (key: string, vars?: Record<string, string | number>) => string; selectedNodeId: string | null; setSelectedNodeId: (id: string | null) => void; connectorStatus: ConnectorStatus; nodeBusy: Record<string, NodeOperation>; lastGrades: Record<string, LastGrade | null>; nodeGradingLogs: Record<string, string[]>; error: string; notice: string; onBack: () => void; onSettings: () => void; onImport: () => void; onExport: () => void; onDraft: (id: string, answer: string) => Promise<void>; onCreateChallenge: (node: NodeRecord) => Promise<void>; onSubmit: (node: NodeRecord, challenge: Challenge, answer: string) => Promise<void>; onExpand: (node: NodeRecord, branchCount?: number) => Promise<void>; onManualNode: (title: string, position: { x: number; y: number }) => Promise<void>; onRetry: () => void; onRefreshConnector: () => void; onClearMessage: () => void }) {
  const [query, setQuery] = useState('')
  const progress = getProgress(workspace.tree)
  const selected = selectedNodeId ? workspace.tree.nodes[selectedNodeId] : undefined
  const matchedIds = query.trim() ? new Set(Object.values(workspace.tree.nodes).filter((node) => `${node.title} ${node.description} ${node.goal}`.toLowerCase().includes(query.toLowerCase()) || workspace.resources.some((resource) => node.resourceIds.includes(resource.id) && resource.title.toLowerCase().includes(query.toLowerCase()))).map((node) => node.id)) : null
  return <div className="app-frame tree-frame"><Header lang={lang} tr={tr} connectorStatus={connectorStatus} onBack={onBack} onImport={onImport} onExport={onExport} onSettings={onSettings} /><div className="tree-layout"><aside className="tree-sidebar"><div className="project-title"><p className="eyebrow">{tr('tree.eyebrow')}</p><h1>{workspace.project.title}</h1><p>{workspace.project.goal}</p></div><div className="progress-block"><div className="progress-label"><span>{tr('tree.progress', { completed: progress.completed, total: progress.total })}</span><strong>{progress.percentage}%</strong></div><div className="progress-track"><span style={{ width: `${progress.percentage}%` }} /></div><div className="progress-foot"><span>{progress.earnedXp} / {progress.possibleXp} {tr('tree.xp')}</span></div></div><label className="search-field"><Icon name="search" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr('tree.search')} /></label><section className="legend"><h2>{tr('tree.legend')}</h2>{(['current', 'incomplete', 'completed'] as const).map((state) => <div key={state}><span className={`legend-mark state-${state}`} /> <span>{tr(`tree.${state}`)}</span></div>)}</section><div className="sidebar-footer"><button className="text-button" onClick={onRefreshConnector}><span className={`status-dot ${connectorStatus.connected ? 'good' : 'muted'}`} /> {connectorStatus.connected && connectorStatus.authenticated ? tr('home.connected') : tr('home.notRunning')}</button></div></aside><main className="map-main"><div className="map-heading"><div><span className="research-tag">{workspace.project.researchMode === 'ja' ? tr('create.ja') : tr('create.global')}</span><span className="map-hint">{tr('tree.selectHint')}</span></div></div>{(error || notice) && <div className={error ? 'message-banner error' : 'message-banner'} role="status"><span>{error || notice}</span><button onClick={onClearMessage} aria-label={tr('nav.close')}><Icon name="close" /></button></div>}<SkillMap workspace={workspace} selectedNodeId={selectedNodeId} setSelectedNodeId={setSelectedNodeId} matchedIds={matchedIds} tr={tr} onManualNode={onManualNode} /></main><aside className="node-sidebar">{selected ? <NodePanel workspace={workspace} node={selected} tr={tr} connectorStatus={connectorStatus} busy={nodeBusy[projectNodeKey(workspace.project.id, selected.id)] || ''} gradingLog={nodeGradingLogs[projectNodeKey(workspace.project.id, selected.id)] || []} lastGrade={lastGrades[projectNodeKey(workspace.project.id, selected.id)] || null} onDraft={onDraft} onCreateChallenge={onCreateChallenge} onSubmit={onSubmit} onExpand={onExpand} onRetry={onRetry} onOpenNode={setSelectedNodeId} /> : <div className="node-empty"><Icon name="branch" /><p>{tr('tree.selectHint')}</p></div>}</aside></div></div>
}

function SkillMap({ workspace, selectedNodeId, setSelectedNodeId, matchedIds, tr, onManualNode }: { workspace: Workspace; selectedNodeId: string | null; setSelectedNodeId: (id: string) => void; matchedIds: Set<string> | null; tr: (key: string, vars?: Record<string, string | number>) => string; onManualNode: (title: string, position: { x: number; y: number }) => Promise<void> }) {
  return <ZoomableMap workspace={workspace} selectedNodeId={selectedNodeId} setSelectedNodeId={setSelectedNodeId} matchedIds={matchedIds} tr={tr} onManualNode={onManualNode} />
}

function ZoomableMap({ workspace, selectedNodeId, setSelectedNodeId, matchedIds, tr, onManualNode }: { workspace: Workspace; selectedNodeId: string | null; setSelectedNodeId: (id: string) => void; matchedIds: Set<string> | null; tr: (key: string, vars?: Record<string, string | number>) => string; onManualNode: (title: string, position: { x: number; y: number }) => Promise<void> }) {
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const [lastPoint, setLastPoint] = useState({ x: 0, y: 0 })
  const [manualPosition, setManualPosition] = useState<{ x: number; y: number } | null>(null)
  const [manualTitle, setManualTitle] = useState('')
  const [manualBusy, setManualBusy] = useState(false)
  const visibleNodes = Object.values(workspace.tree.nodes).filter((node) => !node.archived && node.status !== 'hidden' && (!matchedIds || matchedIds.has(node.id)))
  const layoutPositions = getTreeLayout(workspace.tree)
  const point = (id: string) => layoutPositions[id] ?? workspace.tree.nodes[id]?.position ?? { x: 100, y: 100 }
  const updateZoom = (delta: number) => setZoom((value) => Math.max(.55, Math.min(2.2, Number((value + delta).toFixed(2)))))
  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    updateZoom(event.deltaY > 0 ? -.1 : .1)
  }
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // A node click must remain a click. Capturing the pointer on the map
    // surface here used to retarget the event and prevented unlocked nodes
    // from changing the selected panel.
    if (event.target instanceof Element && event.target.closest('.map-node')) return
    setDragging(true)
    setLastPoint({ x: event.clientX, y: event.clientY })
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const handleContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest('.map-node, .map-controls')) return
    event.preventDefault()
    const svg = event.currentTarget.querySelector('svg')
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const x = (event.clientX - rect.left) / rect.width * 1600
    const y = (event.clientY - rect.top) / rect.height * 620
    setManualPosition({ x: (x - pan.x) / zoom, y: (y - pan.y) / zoom })
    setManualTitle('')
  }
  return <><div className="map-surface" onContextMenu={handleContextMenu} onWheel={handleWheel} onPointerDown={handlePointerDown} onPointerMove={(event) => { if (!dragging) return; setPan((value) => ({ x: value.x + event.clientX - lastPoint.x, y: value.y + event.clientY - lastPoint.y })); setLastPoint({ x: event.clientX, y: event.clientY }) }} onPointerUp={() => setDragging(false)} onPointerCancel={() => setDragging(false)}><div className="map-controls" onPointerDown={(event) => event.stopPropagation()}><button type="button" onClick={() => updateZoom(.1)} aria-label="拡大">＋</button><span>{Math.round(zoom * 100)}%</span><button type="button" onClick={() => updateZoom(-.1)} aria-label="縮小">−</button><button type="button" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }} aria-label="表示をリセット">↺</button></div><svg viewBox="0 0 1600 620" role="img" aria-label={tr('tree.eyebrow')}><defs><pattern id="grid-zoom" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(169,184,182,.06)" strokeWidth="1" /></pattern></defs><rect width="1600" height="620" fill="url(#grid-zoom)" /><g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>{workspace.tree.edges.map((edge) => { const from = point(edge.from); const to = point(edge.to); const visible = visibleNodes.some((item) => item.id === edge.from) && visibleNodes.some((item) => item.id === edge.to); return <line key={`${edge.from}-${edge.to}`} className={`tree-edge ${visible ? '' : 'edge-hidden'}`} x1={from.x + 92} y1={from.y + 38} x2={to.x + 10} y2={to.y + 38} /> })}{visibleNodes.map((node) => <MapNode key={node.id} node={node} position={point(node.id)} selected={node.id === selectedNodeId} tr={tr} onSelect={() => setSelectedNodeId(node.id)} />)}</g></svg>{visibleNodes.length === 0 && <div className="map-empty">{tr('tree.searchEmpty')}</div>}</div>{manualPosition && <div className="manual-node-backdrop" role="presentation"><section className="manual-node-dialog" role="dialog" aria-modal="true"><h2>{tr('tree.manualNodeTitle')}</h2><p>{tr('tree.manualNodeHint')}</p><input autoFocus value={manualTitle} onChange={(event) => setManualTitle(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && manualTitle.trim()) { event.preventDefault(); setManualBusy(true); void onManualNode(manualTitle, manualPosition).finally(() => { setManualBusy(false); setManualPosition(null) }) } }} /><div className="modal-actions"><button className="secondary-button" disabled={manualBusy} onClick={() => setManualPosition(null)}>{tr('create.cancel')}</button><button className="primary-button" disabled={manualBusy || !manualTitle.trim()} onClick={() => { setManualBusy(true); void onManualNode(manualTitle, manualPosition).finally(() => { setManualBusy(false); setManualPosition(null) }) }}>{manualBusy ? tr('node.saving') : tr('tree.manualNodeCreate')}</button></div></section></div>}</>
}

function MapNode({ node, position, selected, tr, onSelect }: { node: NodeRecord; position: { x: number; y: number }; selected: boolean; tr: (key: string, vars?: Record<string, string | number>) => string; onSelect: () => void }) {
  const completed = node.status === 'cleared'
  const statusKey = selected ? 'current' : completed ? 'completed' : 'incomplete'
  const label = tr(`tree.${statusKey}`)
  const xp = completed ? Math.min(node.xp, 100) : 0
  const handleKey = (event: KeyboardEvent<SVGGElement>) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect() } }
  return <g className={`map-node state-${statusKey} ${selected ? 'selected' : ''}`} transform={`translate(${position.x}, ${position.y})`} onClick={onSelect} onKeyDown={handleKey} tabIndex={0} role="button" aria-label={`${node.title}, ${label}`}><rect className="node-back" width="184" height="76" rx="4" />{node.status === 'cleared' && <path className={node.masteryState === 'mastered' ? 'node-crown' : 'node-check'} d={node.masteryState === 'mastered' ? 'M14 38l3-6 4 4 4-6 4 8' : 'M14 38l4 4 8-9'} />}{node.status === 'unlocked' && <circle cx="20" cy="38" r="3" className="node-dot" />}<foreignObject x="40" y="10" width="136" height="42"><div className="node-title-wrap">{node.title}</div></foreignObject><text className="node-state" x="40" y="64">{label} · {xp} XP</text></g>
}

function NodePanel({ workspace, node, tr, connectorStatus, busy, gradingLog, lastGrade, onDraft, onCreateChallenge, onSubmit, onExpand, onRetry, onOpenNode }: { workspace: Workspace; node: NodeRecord; tr: (key: string, vars?: Record<string, number | string>) => string; connectorStatus: ConnectorStatus; busy: string; gradingLog: string[]; lastGrade: LastGrade | null; onDraft: (id: string, answer: string) => Promise<void>; onCreateChallenge: (node: NodeRecord) => Promise<void>; onSubmit: (node: NodeRecord, challenge: Challenge, answer: string) => Promise<void>; onExpand: (node: NodeRecord, branchCount?: number) => Promise<void>; onRetry: () => void; onOpenNode: (id: string) => void }) {
  const [branchPickerOpen, setBranchPickerOpen] = useState(false)
  const [branchCount, setBranchCount] = useState(3)
  const availableChallenges = workspace.challenges.filter((item) => node.challengeIds.includes(item.id) && item.nodeId === node.id)
  const [selectedChallengeId, setSelectedChallengeId] = useState(availableChallenges[0]?.id || '')
  useEffect(() => {
    if (!availableChallenges.some((item) => item.id === selectedChallengeId)) setSelectedChallengeId(availableChallenges[0]?.id || '')
  }, [node.id, availableChallenges.map((item) => item.id).join(','), selectedChallengeId])
  const challenge = availableChallenges.find((item) => item.id === selectedChallengeId) || availableChallenges[0]
  const attempts = workspace.attempts.filter((item) => item.nodeId === node.id)
  const answer = challenge ? workspace.draftAnswers[challenge.id] ?? '' : ''
  const resources = workspace.resources.filter((item) => node.resourceIds.includes(item.id) || challenge?.resourceIds.includes(item.id))
  const visibleGrade = lastGrade && (!lastGrade.challengeId || !challenge || lastGrade.challengeId === challenge.id) ? lastGrade : null
  if (node.status === 'hidden') return <div className="node-empty"><span className="fog-mark" /><p>{tr('node.notAvailable')}</p></div>
  return <>{availableChallenges.length > 1 && <label className="challenge-picker"><span>{tr('node.challengeVersion')}</span><select value={challenge?.id || ''} onChange={(event) => setSelectedChallengeId(event.target.value)}>{availableChallenges.map((item, index) => <option key={item.id} value={item.id}>{tr('grade.round', { count: index + 1 })} · {new Date(item.createdAt).toLocaleDateString()}</option>)}</select></label>}<NodePanelContent workspace={workspace} node={node} challenge={challenge} resources={resources} tr={tr} connectorStatus={connectorStatus} busy={busy} gradingLog={gradingLog} lastGrade={visibleGrade} answer={answer} onDraft={onDraft} onCreateChallenge={onCreateChallenge} onSubmit={onSubmit} onExpand={onExpand} onRetry={onRetry} onOpenNode={onOpenNode} />{!visibleGrade && <AttemptHistory attempts={attempts} tr={tr} />}{node.status === 'cleared' && <section className="expand-section node-panel-extra-action"><div><strong>{tr('tree.expand')}</strong>{branchPickerOpen ? <><p>{tr('tree.branchCount')}: {branchCount}</p><input type="range" min="1" max="10" value={branchCount} onChange={(event) => setBranchCount(Number(event.target.value))} aria-label={tr('tree.branchCount')} /><div className="branch-picker-actions"><button className="secondary-button" onClick={() => setBranchPickerOpen(false)}>{tr('create.cancel')}</button><button className="primary-button" disabled={busy === 'expand' || !connectorStatus.connected || !connectorStatus.authenticated} onClick={() => { setBranchPickerOpen(false); void onExpand(node, branchCount) }}>{tr('tree.expand')}</button></div></> : <p>{tr('tree.expandHint')}</p>}</div>{!branchPickerOpen && <button className="icon-button" disabled={busy === 'expand' || !connectorStatus.connected || !connectorStatus.authenticated} onClick={() => setBranchPickerOpen(true)} aria-label={tr('tree.expand')}><Icon name="branch" /></button>}</section>}{challenge && <ModelAnswerDisclosure challenge={challenge} tr={tr} />}<ResearchHistory records={workspace.research.filter((item) => !item.nodeId || item.nodeId === node.id)} /></>
}

function ModelAnswerDisclosure({ challenge, tr }: { challenge: Challenge; tr: (key: string, vars?: Record<string, string | number>) => string }) {
  const [visible, setVisible] = useState(false)
  const mode = challenge.mode || 'explain'
  const questions = challenge.questions?.length ? challenge.questions : [{ id: `${challenge.id}-main`, prompt: challenge.prompt, modelAnswer: challenge.modelAnswer, expectedConcepts: challenge.expectedConcepts, explanation: challenge.explanation }]
  const answer = mode === 'explain'
    ? challenge.modelAnswer
    : questions.map((question, index) => {
      const value = question.modelAnswer.trim().toLowerCase() === 'true' ? '○' : question.modelAnswer.trim().toLowerCase() === 'false' ? '×' : question.modelAnswer
      return `${index + 1}. ${value}`
    }).join('\n')
  useEffect(() => { setVisible(false) }, [challenge.id])
  const explanations = mode === 'explain'
    ? challenge.explanation
    : questions.map((question, index) => question.explanation.trim() ? `${index + 1}. ${question.explanation}` : '').filter(Boolean).join('\n')
  return <section className="model-answer-disclosure"><button type="button" className="secondary-button full-button" onClick={() => setVisible((value) => !value)}>{visible ? tr('node.hideModelAnswer') : tr('node.showModelAnswer')}</button>{visible && <div className="model-answer-content"><h3>{tr('node.modelAnswer')}</h3><p>{answer}</p>{explanations && <><h3>{tr('node.explanation')}</h3><p>{explanations}</p></>}</div>}</section>
}

function NodePanelContent({ workspace, node, challenge, resources, tr, connectorStatus, busy, gradingLog, lastGrade, answer, onDraft, onCreateChallenge, onSubmit, onExpand, onRetry, onOpenNode }: { workspace: Workspace; node: NodeRecord; challenge?: Challenge; resources: Resource[]; tr: (key: string, vars?: Record<string, string | number>) => string; connectorStatus: ConnectorStatus; busy: string; gradingLog: string[]; lastGrade: LastGrade | null; answer: string; onDraft: (id: string, answer: string) => Promise<void>; onCreateChallenge: (node: NodeRecord) => Promise<void>; onSubmit: (node: NodeRecord, challenge: Challenge, answer: string) => Promise<void>; onExpand: (node: NodeRecord) => Promise<void>; onRetry: () => void; onOpenNode: (id: string) => void }) {
  const mode = challenge?.mode || 'explain'
  const questions = challenge?.questions?.length ? challenge.questions : challenge ? [{ id: `${challenge.id}-main`, prompt: challenge.prompt, modelAnswer: challenge.modelAnswer, expectedConcepts: challenge.expectedConcepts, explanation: challenge.explanation }] : []
  let savedAnswers: Record<string, string> = {}
  try { savedAnswers = answer.startsWith('{') ? JSON.parse(answer) as Record<string, string> : {} } catch { savedAnswers = {} }
  const submitAnswer = mode === 'explain' ? answer : JSON.stringify(Object.fromEntries(questions.map((question) => [question.id, savedAnswers[question.id] || ''])))
  const updateAnswer = (questionId: string, value: string) => { void onDraft(challenge?.id || '', mode === 'explain' ? value : JSON.stringify({ ...savedAnswers, [questionId]: value })) }
  const submitOnShortcut = (event: KeyboardEvent<HTMLElement>) => {
    if (!(event.target instanceof HTMLTextAreaElement)) return
    if (!(event.ctrlKey || event.metaKey) || event.key !== 'Enter') return
    event.preventDefault()
    if (busy !== 'grade' && submitAnswer.trim() && connectorStatus.connected && connectorStatus.authenticated) void onSubmit(node, challenge!, submitAnswer)
  }
  return <div className="node-panel-keyboard-hook" onKeyDown={submitOnShortcut}><NodePanelView workspace={workspace} node={node} challenge={challenge!} resources={resources} mode={mode} questions={questions} savedAnswers={savedAnswers} submitAnswer={submitAnswer} tr={tr} connectorStatus={connectorStatus} busy={busy} gradingLog={gradingLog} lastGrade={lastGrade} answer={answer} updateAnswer={updateAnswer} onDraft={onDraft} onCreateChallenge={onCreateChallenge} onSubmit={onSubmit} onRetry={onRetry} onOpenNode={onOpenNode} /></div>
}

function NodePanelView({ workspace, node, challenge, resources, mode, questions, savedAnswers, submitAnswer, tr, connectorStatus, busy, gradingLog, lastGrade, answer, updateAnswer, onDraft, onCreateChallenge, onSubmit, onRetry, onOpenNode }: { workspace: Workspace; node: NodeRecord; challenge: Challenge; resources: Resource[]; mode: ChallengeMode; questions: Array<{ id: string; prompt: string; modelAnswer: string; expectedConcepts: string[]; explanation: string }>; savedAnswers: Record<string, string>; submitAnswer: string; tr: (key: string, vars?: Record<string, number | string>) => string; connectorStatus: ConnectorStatus; busy: string; gradingLog: string[]; lastGrade: LastGrade | null; answer: string; updateAnswer: (id: string, value: string) => void; onDraft: (id: string, answer: string) => Promise<void>; onCreateChallenge: (node: NodeRecord) => Promise<void>; onSubmit: (node: NodeRecord, challenge: Challenge, answer: string) => Promise<void>; onRetry: () => void; onOpenNode: (id: string) => void }) {
  const completed = node.status === 'cleared'
  const statusLabel = completed ? tr('tree.completed') : tr('tree.incomplete')
  return <div className="node-panel"><div className="node-panel-head"><div><p className="eyebrow">{tr('node.status')}</p><h2>{node.title}</h2></div><span className={`status-chip state-${completed ? 'completed' : 'incomplete'}`}>{statusLabel}</span></div><section className="node-section goal-section"><h3>{tr('node.goal')}</h3><p>{node.goal || node.description}</p></section>{(busy === 'grade' || busy === 'expand') && <GradingLog items={gradingLog} label={busy === 'expand' ? '領域を調査中' : '採点中'} />}<section className="node-section"><div className="section-title"><h3>{tr('node.resources')}</h3><span>{resources.length}</span></div>{resources.length ? <div className="resource-list">{resources.map((resource) => <ResourceRow key={resource.id} resource={resource} tr={tr} />)}</div> : <p className="muted-copy">{tr('node.noChallenge')}</p>}</section><section className="node-section challenge-section"><div className="section-title"><h3>{tr('node.challenge')}</h3>{challenge && <span className="difficulty">{tr(`node.difficulty${challenge.difficulty}`)}</span>}</div>{challenge ? <>{mode === 'explain' && <p className="challenge-prompt">{challenge.prompt}</p>}{lastGrade ? <GradeReview grade={lastGrade} tr={tr} workspace={workspace} onRetry={onRetry} onOpenNode={onOpenNode} /> : <><div className="question-list">{questions.map((question, index) => <label className="answer-label" key={question.id}>{mode === 'explain' ? tr('node.answer') : `${index + 1}. ${question.prompt}`}{mode === 'true_false' ? <span className="boolean-options"><button type="button" className={savedAnswers[question.id] === 'true' ? 'selected' : ''} onClick={() => updateAnswer(question.id, 'true')}>○</button><button type="button" className={savedAnswers[question.id] === 'false' ? 'selected' : ''} onClick={() => updateAnswer(question.id, 'false')}>×</button></span> : <textarea value={mode === 'explain' ? answer : savedAnswers[question.id] || ''} onChange={(event) => updateAnswer(question.id, event.target.value)} placeholder={tr('node.answerPlaceholder')} rows={mode === 'explain' ? 8 : 2} />}</label>)}</div><button className="primary-button full-button" disabled={busy === 'grade' || !submitAnswer.trim() || !connectorStatus.connected || !connectorStatus.authenticated} onClick={() => void onSubmit(node, challenge, submitAnswer)}>{busy === 'grade' ? tr('node.saving') : tr('node.submit')} <Icon name="arrow" /></button></>}</> : <><p className="muted-copy">{tr('node.noChallenge')}</p><button className="secondary-button full-button" disabled={busy === 'challenge' || !connectorStatus.connected || !connectorStatus.authenticated} onClick={() => void onCreateChallenge(node)}>{busy === 'challenge' ? tr('proposal.loading') : tr('node.createChallenge')} <Icon name="plus" /></button></>}</section></div>
}

function ResourceRow({ resource, tr }: { resource: Resource; tr: (key: string, vars?: Record<string, string | number>) => string }) {
  return <article className="resource-row"><span className={`resource-icon resource-${resource.type}`}><Icon name="document" /></span><div><a href={resource.url} target="_blank" rel="noreferrer">{resource.title}</a><small>{resource.locator ? `${tr('node.read')}: ${resource.locator.value}` : tr('node.source')} · Tier {resource.authorityTier}</small><p>{resource.guidance}</p></div><a className="external-link" href={resource.url} target="_blank" rel="noreferrer" aria-label={tr('node.open')}><Icon name="external" /></a></article>
}

function GradeReview({ grade, tr, workspace, onRetry, onOpenNode }: { grade: LastGrade; tr: (key: string, vars?: Record<string, string | number>) => string; workspace: Workspace; onRetry: () => void; onOpenNode: (id: string) => void }) {
  if (grade.progress) return <GradingLog items={grade.progress} label={grade.progressLabel} />
  const response = grade.response
  const label = tr(`grade.${response.grade}`)
  const currentNode = workspace.tree.nodes[grade.nodeId]
  const directChildren = (currentNode?.children || []).map((id) => workspace.tree.nodes[id]).filter((node): node is NodeRecord => Boolean(node) && node.status !== 'hidden')
  const recommendedIds = new Set(response.recommendedNodeIds)
  const nextNodes = [...response.recommendedNodeIds.map((id) => workspace.tree.nodes[id]).filter((node): node is NodeRecord => Boolean(node) && node.status !== 'hidden'), ...directChildren.filter((node) => !recommendedIds.has(node.id))]
  return <div className="grade-review"><div className="grade-header"><div className={`grade-score grade-${response.grade}`}>{response.grade}</div><div><p className="eyebrow">{tr('grade.title')}</p><h3>{label}</h3></div><strong className="xp-earned">{tr('grade.xpEarned', { xp: grade.xpAwarded })}</strong></div><ReviewList title={tr('grade.summary')} items={[response.summary]} plain /><ReviewList title={tr('grade.correct')} items={response.correct} icon="check" /><ReviewList title={tr('grade.missing')} items={response.missing} icon="minus" /><ReviewList title={tr('grade.misconceptions')} items={response.misconceptions.length ? response.misconceptions : [tr('grade.noItems')]} icon="warn" /><ReviewList title={tr('grade.nuance')} items={response.nuance} /><ReviewList title={tr('grade.next')} items={[response.nextStep ?? '']} plain />{grade.unlockedIds.length > 0 && <div className="unlock-note"><Icon name="branch" /><span><strong>{tr('grade.unlocked')}</strong><small>{grade.unlockedIds.map((id) => workspace.tree.nodes[id]?.title).filter(Boolean).join(' · ')}</small></span></div>}{nextNodes.length > 0 && <section className="next-branches"><h4>{tr('grade.nextBranches')}</h4><div className="next-branch-list">{nextNodes.map((nextNode) => <button key={nextNode.id} className="next-branch-button" onClick={() => onOpenNode(nextNode.id)}><span>{nextNode.title}</span><Icon name="arrow" /></button>)}</div></section>}<div className="grade-actions"><button className="secondary-button" onClick={onRetry}>{tr('grade.retry')}</button></div><AttemptHistory attempts={workspace.attempts.filter((item) => item.nodeId === grade.nodeId)} tr={tr} /></div>
}

function GradingLog({ items, label = '採点中' }: { items: string[]; label?: string }) {
  return <section className="grading-log" role="status" aria-live="polite"><div className="grading-log-title"><span className="status-dot good" /> {label}</div>{items.map((item, index) => <p key={`${item}-${index}`}>{item}</p>)}</section>
}

function ReviewList({ title, items, icon, plain }: { title: string; items: string[]; icon?: 'check' | 'minus' | 'warn'; plain?: boolean }) {
  const cleaned = items.filter(Boolean)
  return <section className={`review-list ${plain ? 'review-plain' : ''}`}><h4>{title}</h4>{cleaned.map((item, index) => <p key={`${item}-${index}`}>{icon && <span className={`review-icon ${icon}`}>{icon === 'check' ? '✓' : icon === 'minus' ? '–' : '!'}</span>}{item}</p>)}</section>
}

function AttemptHistory({ attempts, tr }: { attempts: Workspace['attempts']; tr: (key: string, vars?: Record<string, string | number>) => string }) {
  if (!attempts.length) return null
  const formatAnswer = (answer: string) => {
    try {
      const parsed = JSON.parse(answer) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return Object.values(parsed as Record<string, unknown>).map((value, index) => `${index + 1}. ${value === 'true' ? '○' : value === 'false' ? '×' : String(value ?? '')}`).join('\n')
      }
    } catch {
      // Explain mode stores plain text.
    }
    return answer
  }
  return <section className="attempt-history"><h4>{tr('grade.history')}</h4>{attempts.slice().reverse().map((attempt, index) => <details key={attempt.id || index}><summary><div className="attempt-history-head"><strong>{tr('grade.round', { count: attempts.length - index })}</strong><span className={`grade-score grade-${attempt.grade}`}>{attempt.grade}</span><time>{new Date(attempt.createdAt).toLocaleString()}</time></div><p className="muted-copy">{attempt.feedback.summary}</p></summary><div className="attempt-detail"><h5>{tr('grade.answer')}</h5><p className="attempt-answer">{formatAnswer(attempt.answer)}</p><ReviewList title={tr('grade.correct')} items={attempt.feedback.correct} icon="check" /><ReviewList title={tr('grade.missing')} items={attempt.feedback.missing} icon="minus" /><ReviewList title={tr('grade.misconceptions')} items={attempt.feedback.misconceptions} icon="warn" /><ReviewList title={tr('grade.nuance')} items={attempt.feedback.nuance} /><ReviewList title={tr('grade.next')} items={[attempt.feedback.nextStep]} plain /></div></details>)}</section>
}

function ResearchHistory({ records }: { records: ResearchRecord[] }) {
  if (!records.length) return null
  const labels: Record<ResearchRecord['operation'], string> = {
    tree_propose: 'ツリー作成', node_expand: '次のノード調査', node_create: 'ノード作成', challenge_create: '問題作成', answer_grade: '採点',
  }
  return <section className="research-history"><div className="section-title"><h3>調査履歴</h3><span>{records.length}</span></div>{records.slice().reverse().map((record) => <details key={record.id}><summary><strong>{labels[record.operation]}</strong><time>{new Date(record.completedAt).toLocaleString()}</time><p>{record.summary}</p></summary><div className="research-detail">{record.searches.length > 0 && <p><strong>検索:</strong> {record.searches.join(' / ')}</p>}{record.logs.length > 0 && <div><strong>検索ログ</strong>{record.logs.map((item, index) => <p key={`${record.id}-log-${index}`}>{item}</p>)}</div>}{record.sources.length > 0 && <div><strong>確認した出典</strong>{record.sources.map((source) => <a key={`${record.id}-${source.url}`} href={source.url} target="_blank" rel="noreferrer">{source.title}</a>)}</div>}{record.unknownClaims.length > 0 && <div><strong>確認できなかった点</strong>{record.unknownClaims.map((item) => <p key={item}>{item}</p>)}</div>}</div></details>)}</section>
}

function SettingsModal({ settings, currentModel, currentReasoningEffort, models, modelsLoading, modelsError, lang, tr, onClose, onSave }: { settings: Settings; currentModel?: string; currentReasoningEffort?: string | null; models: ConnectorModel[]; modelsLoading: boolean; modelsError: string; lang: UiLanguage; tr: (key: string, vars?: Record<string, string | number>) => string; onClose: () => void; onSave: (settings: Settings) => Promise<void> }) {
  const [draft, setDraft] = useState({ ...settings, model: settings.model || currentModel || 'gpt-5.6-luna', reasoningEffort: settings.reasoningEffort || currentReasoningEffort || 'low' })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const fallbackModel = currentModel || draft.model
  const fallbackEffort = currentReasoningEffort || draft.reasoningEffort || 'low'
  const fallbackEntries = [fallbackModel, draft.model].filter((item, index, all): item is string => Boolean(item) && all.indexOf(item) === index).map((model) => ({ id: model, model, displayName: model, description: '', defaultReasoningEffort: fallbackEffort, supportedReasoningEfforts: [{ reasoningEffort: fallbackEffort, description: '' }], isDefault: false }))
  const modelOptions = [...fallbackEntries, ...models].filter((item, index, all) => all.findIndex((candidate) => candidate.model === item.model) === index)
  const selectedEntry = modelOptions.find((item) => item.model === draft.model) || modelOptions[0]
  const effortOptions = selectedEntry?.supportedReasoningEfforts.length ? selectedEntry.supportedReasoningEfforts : [{ reasoningEffort: draft.reasoningEffort || fallbackEffort, description: '' }]
  const selectedEffort = draft.reasoningEffort || selectedEntry?.defaultReasoningEffort || effortOptions[0]?.reasoningEffort || ''
  const selectModel = (model: string) => {
    const entry = modelOptions.find((item) => item.model === model)
    const effort = entry?.supportedReasoningEfforts.find((item) => item.reasoningEffort === draft.reasoningEffort)?.reasoningEffort || entry?.defaultReasoningEffort || entry?.supportedReasoningEfforts[0]?.reasoningEffort || 'low'
    setDraft({ ...draft, model, reasoningEffort: effort })
  }
  const submit = async () => {
    setSaving(true)
    setSaveError('')
    try {
      await onSave({ ...draft, model: draft.model || fallbackModel, reasoningEffort: selectedEffort })
  } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : tr('settings.modelSaveError'))
    } finally {
      setSaving(false)
    }
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose() }}><section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="modal-head"><div><p className="eyebrow">{tr('nav.settings')}</p><h2 id="settings-title">{tr('settings.title')}</h2></div><button className="icon-button" onClick={onClose} aria-label={tr('settings.close')} disabled={saving}><Icon name="close" /></button></div><label>{tr('settings.language')}<select value={draft.uiLanguage} onChange={(event) => setDraft({ ...draft, uiLanguage: event.target.value as UiLanguage })} disabled={saving}><option value="ja">日本語</option><option value="en">English</option></select><small>{tr('settings.languageHint')}</small></label><label>{tr('settings.model')}<select value={draft.model || ''} onChange={(event) => selectModel(event.target.value)} disabled={modelsLoading || modelOptions.length === 0 || saving}><option value="" disabled>{modelsLoading ? tr('settings.modelLoading') : tr('settings.modelUnavailable')}</option>{modelOptions.map((item) => <option key={item.id} value={item.model}>{item.displayName === item.model ? item.model : `${item.displayName} · ${item.model}`}</option>)}</select><small>{tr('settings.modelHint')}</small></label><label>{tr('settings.reasoningEffort')}<select value={selectedEffort} onChange={(event) => setDraft({ ...draft, reasoningEffort: event.target.value })} disabled={modelsLoading || effortOptions.length === 0 || saving}>{effortOptions.map((item) => <option key={item.reasoningEffort} value={item.reasoningEffort}>{item.reasoningEffort}</option>)}</select><small>{tr('settings.reasoningEffortHint')}</small></label>{modelsError && <p className="settings-error" role="alert">{modelsError}</p>}<div className="settings-note"><Icon name="connector" /><span><strong>{tr('settings.connectorReady')}</strong><small>{tr('settings.connectorReadyHint')}</small></span></div><label className="toggle-row"><span><strong>{tr('settings.motion')}</strong><small>{tr('settings.motionHint')}</small></span><input type="checkbox" checked={draft.reducedMotion} onChange={(event) => setDraft({ ...draft, reducedMotion: event.target.checked })} disabled={saving} /></label>{saveError && <p className="settings-error" role="alert">{saveError}</p>}<div className="modal-actions"><button className="secondary-button" onClick={onClose} disabled={saving}>{tr('settings.close')}</button><button className="primary-button" onClick={() => void submit()} disabled={modelsLoading || modelOptions.length === 0 || saving}>{saving ? tr('settings.modelApplying') : tr('settings.save')}</button></div></section></div>
}

function HelpModal({ lang, tr, onClose }: { lang: UiLanguage; tr: (key: string, vars?: Record<string, string | number>) => string; onClose: () => void }) {
  const downloads = [
    ['home.downloadWindows', 'home.downloadWindowsHint', 'challenge-tree-connector-win-x64.exe'],
    ['home.downloadMacIntel', 'home.downloadMacIntelHint', 'challenge-tree-connector-macos-x64'],
    ['home.downloadMacArm', 'home.downloadMacArmHint', 'challenge-tree-connector-macos-arm64'],
    ['home.downloadLinux', 'home.downloadLinuxHint', 'challenge-tree-connector-linux-x64'],
  ] as const
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title"><div className="modal-head"><div><p className="eyebrow">{tr('home.connector')}</p><h2 id="help-title">{tr('home.setupTitle')}</h2></div><button className="icon-button" onClick={onClose} aria-label={tr('settings.close')}><Icon name="close" /></button></div><p className="help-intro">{tr('home.setupDescription')}</p><div className="setup-steps"><div className="setup-step"><span>1</span><div><strong>{tr('home.setupDownload')}</strong><div className="connector-downloads">{downloads.map(([label, hint, filename]) => <div className="connector-download" key={filename}><a className="primary-button download-button" href={new URL(`downloads/${filename}`, document.baseURI).href} download={filename}><Icon name="download" /> {tr(label)}</a><small>{tr(hint)}</small></div>)}</div></div></div><div className="setup-step"><span>2</span><div><strong>{tr('home.setupStart')}</strong><small>{tr('home.setupStartHint')}</small></div></div><div className="setup-step"><span>3</span><div><strong>{tr('home.setupReturn')}</strong><small>{tr('home.setupReturnHint')}</small></div></div></div><p className="help-note"><Icon name="connector" /> {lang === 'ja' ? '接続先やポート番号の入力は不要です。' : 'No connector URL or port entry is needed.'}</p><div className="modal-actions"><button className="secondary-button" onClick={onClose}>{tr('settings.close')}</button></div></section></div>
}

function ConnectorPill({ status, tr }: { status: ConnectorStatus; tr: (key: string, vars?: Record<string, string | number>) => string }) {
  const connected = status.connected && status.authenticated
  return <span className={`connector-pill ${connected ? 'connected' : ''}`}><span className="status-dot" /> {tr('home.connector')} · {connected ? tr('home.connected') : tr('home.notRunning')}</span>
}

function ConnectorDiagnostics({ status, tr }: { status: ConnectorStatus; tr: (key: string, vars?: Record<string, string | number>) => string }) {
  const value = (ready: boolean | undefined, readyKey: string, missingKey: string) => ready === undefined ? '—' : ready ? tr(readyKey) : tr(missingKey)
  const error = status.error?.message || status.message
  return <div className="connector-diagnostics" aria-label={tr('home.diagnostics')}>
    <div><span>{tr('home.cli')}</span><strong>{status.codexVersion || (status.codexFound === false ? tr('home.noCli') : '—')}</strong></div>
    <div><span>{tr('home.appServer')}</span><strong>{value(status.appServerRunning, 'home.running', 'home.stopped')}</strong></div>
    <div><span>{tr('home.auth')}</span><strong>{value(status.authenticated, 'home.signedIn', 'home.required')}</strong></div>
    <div><span>{tr('home.model')}</span><strong>{status.model || '—'} · {value(status.modelAvailable, 'home.available', 'home.unavailable')}</strong></div>
    {error && <p className="connector-diagnostic-error">{error}</p>}
  </div>
}

function ErrorBanner({ message }: { message: string }) { return <div className="error-banner" role="alert"><Icon name="warn" /><span>{message}</span></div> }

function Icon({ name }: { name: string }) {
  if (name === 'settings') return <svg className="icon settings-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" /><circle cx="12" cy="12" r="3" /></svg>
  if (name === 'connector') return <svg className="icon connector-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="5" width="6" height="6" rx="1" /><rect x="14" y="13" width="6" height="6" rx="1" /><path d="M10 8h2a4 4 0 0 1 4 4v1M14 16h-2a4 4 0 0 1-4-4v-1" /></svg>
  const paths: Record<string, ReactNode> = {
    plus: <><path d="M12 5v14M5 12h14" /></>, upload: <><path d="M12 16V4m0 0L7 9m5-5 5 5" /><path d="M5 15v4h14v-4" /></>, download: <><path d="M12 4v12m0 0 5-5m-5 5-5-5" /><path d="M5 20h14" /></>, settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-1.7 1.7-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V20h-2.4v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1L8 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H6v-2.4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9L7.3 8.6 9 7l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5V5h2.4v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1L19 8l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.2v2.4h-.2a1.7 1.7 0 0 0-1.5 1Z" /></>, branch: <><circle cx="6" cy="5" r="2" /><circle cx="18" cy="19" r="2" /><circle cx="18" cy="5" r="2" /><path d="M8 5h5a5 5 0 0 1 5 5v7M8 5v6a5 5 0 0 0 5 5h3" /></>, arrow: <><path d="M4 12h15m-6-6 6 6-6 6" /></>, back: <><path d="M19 12H5m6 6-6-6 6-6" /></>, refresh: <><path d="M20 11a8 8 0 0 0-14.8-3L4 10" /><path d="M4 5v5h5M4 13a8 8 0 0 0 14.8 3L20 14" /><path d="M20 19v-5h-5" /></>, search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4 4" /></>, document: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h5M9 13h6m-6 4h6" /></>, external: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 13v6H4V5h6" /></>, trash: <><path d="M5 7h14m-9 4v6m4-6v6M9 7V4h6v3m-8 0 1 13h8l1-13" /></>, close: <><path d="m6 6 12 12M18 6 6 18" /></>, check: <path d="m5 12 4 4L19 6" />, warn: <><path d="M12 4 3 20h18L12 4Z" /><path d="M12 10v4m0 3h.01" /></>, spark: <><path d="m12 3 1.5 6.5L20 12l-6.5 1.5L12 20l-1.5-6.5L4 12l6.5-2.5L12 3Z" /></>, 'minus': <path d="M5 12h14" />,
  }
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name] ?? paths.branch}</svg>
}
