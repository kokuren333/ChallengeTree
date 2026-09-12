import type { Attempt, Grade, GradeResponse, MasteryState, NodeRecord, Stats, Tree, Workspace, WorkspaceBundle } from './types'
import { WorkspaceBundleSchema, WorkspaceSchema } from './schemas'

export const XP_BY_GRADE: Record<Grade, number> = { C: 0, B: 40, A: 70, S: 100 }
export const MASTERED_XP = XP_BY_GRADE.S
export const GRADE_INDEX: Record<Grade, 0 | 1 | 2 | 3> = { C: 0, B: 1, A: 2, S: 3 }

export function masteryFromXp(xp: number): MasteryState {
  if (xp >= MASTERED_XP) return 'mastered'
  if (xp > 0) return 'developing'
  return 'familiar'
}

export function applyGradeToNode(node: NodeRecord, grade: Grade, now = new Date().toISOString()): { node: NodeRecord; xpAwarded: number; clearedNow: boolean; masteredNow: boolean } {
  const before = node.status
  // A node keeps its best demonstrated level. Regrading therefore never
  // inflates the progress percentage beyond the S ceiling.
  const targetXp = XP_BY_GRADE[grade]
  const xp = Math.max(node.xp, targetXp)
  const xpAwarded = xp - node.xp
  const masteryState = masteryFromXp(xp)
  // Any submitted grade completes the current node. Mastery is represented by
  // the S grade/XP band, not by a separate user-facing node status.
  const status = 'cleared' as const
  return {
    node: { ...node, xp, masteryState, status, updatedAt: now },
    xpAwarded,
    clearedNow: before !== 'cleared',
    masteredNow: before !== 'cleared' && status === 'cleared' && masteryState === 'mastered',
  }
}

export function unlockAvailableNodes(tree: Tree): { tree: Tree; unlockedIds: string[] } {
  const nodes = Object.fromEntries(Object.entries(tree.nodes).map(([id, node]) => [id, { ...node }]))
  const unlockedIds: string[] = []
  // Hidden nodes are not shown in the map. Once every prerequisite is
  // complete, reveal them directly as selectable learning nodes.
  for (const node of Object.values(nodes)) {
    if (node.status !== 'hidden' || node.prerequisites.length === 0) continue
    if (node.prerequisites.every((id) => {
      const prerequisite = nodes[id]
      return prerequisite?.status === 'cleared'
    })) {
      node.status = 'unlocked'
      node.updatedAt = new Date().toISOString()
      unlockedIds.push(node.id)
    }
  }
  return { tree: { ...tree, nodes }, unlockedIds }
}

export function appendAttemptStats(stats: Stats, attempt: Attempt): Stats {
  const gradeDistribution = [...stats.gradeDistribution] as [number, number, number, number]
  gradeDistribution[GRADE_INDEX[attempt.grade]] += 1
  return {
    ...stats,
    totalXp: stats.totalXp + attempt.xpAwarded,
    sessionXp: stats.sessionXp + attempt.xpAwarded,
    totalChallenges: stats.totalChallenges + 1,
    gradeDistribution,
  }
}

export function getProgress(tree: Tree) {
  const nodes = Object.values(tree.nodes).filter((node) => !node.archived && node.status !== 'hidden')
  const completedNodes = nodes.filter((node) => node.status === 'cleared')
  const cleared = completedNodes.length
  const mastered = nodes.filter((node) => node.masteryState === 'mastered').length
  const earnedXp = completedNodes.reduce((sum, node) => sum + Math.min(node.xp, XP_BY_GRADE.S), 0)
  const possibleXp = completedNodes.length * XP_BY_GRADE.S
  return { total: nodes.length, cleared, completed: cleared, mastered, earnedXp, possibleXp, percentage: possibleXp ? Math.round((earnedXp / possibleXp) * 100) : 0 }
}

export function applyGrade(workspace: Workspace, nodeId: string, challengeId: string, answer: string, response: GradeResponse, now = new Date().toISOString()): { workspace: Workspace; attempt: Attempt; unlockedIds: string[]; clearedNow: boolean } {
  const node = workspace.tree.nodes[nodeId]
  if (!node) throw new Error('Node not found')
  const challenge = workspace.challenges.find((item) => item.id === challengeId)
  if (!challenge || challenge.nodeId !== nodeId || !node.challengeIds.includes(challengeId)) throw new Error('Challenge does not belong to node')
  const applied = applyGradeToNode(node, response.grade, now)
  const attempt: Attempt = {
    id: crypto.randomUUID(), challengeId, nodeId, answer, grade: response.grade,
    feedback: {
      summary: response.summary, correct: response.correct, missing: response.missing,
      misconceptions: response.misconceptions, nuance: response.nuance, nextStep: response.nextStep ?? '',
      recommendedAction: response.recommendedAction, recommendedNodeIds: response.recommendedNodeIds,
    },
    xpAwarded: applied.xpAwarded, createdAt: now,
  }
  const tree: Tree = { ...workspace.tree, nodes: { ...workspace.tree.nodes, [nodeId]: applied.node } }
  const unlocked = unlockAvailableNodes(tree)
  return {
    workspace: { ...workspace, tree: unlocked.tree, attempts: [...workspace.attempts, attempt], stats: appendAttemptStats(workspace.stats, attempt), draftAnswers: { ...workspace.draftAnswers, [challengeId]: '' }, project: { ...workspace.project, updatedAt: now } },
    attempt, unlockedIds: unlocked.unlockedIds, clearedNow: applied.clearedNow,
  }
}

export function migrateWorkspace(input: unknown): Workspace {
  if (!input || typeof input !== 'object') throw new Error('Save data must be an object')
  const raw = input as Record<string, unknown>
  const formatVersion = typeof raw.formatVersion === 'number' ? raw.formatVersion : 1
  if (formatVersion > 1) throw new Error(`Unsupported save format v${formatVersion}`)
  const normalized: Record<string, any> = {
    ...raw,
    formatVersion: 1,
    appVersion: typeof raw.appVersion === 'string' ? raw.appVersion : '0.1.0',
    schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 1,
    connectorProtocolVersion: typeof raw.connectorProtocolVersion === 'string' ? raw.connectorProtocolVersion : '1',
    research: Array.isArray(raw.research) ? raw.research : [],
    attempts: Array.isArray(raw.attempts) ? raw.attempts : [],
    draftAnswers: raw.draftAnswers && typeof raw.draftAnswers === 'object' ? raw.draftAnswers : {},
    settings: { uiLanguage: 'en', connectorUrl: 'http://127.0.0.1:43110', reducedMotion: false, model: 'gpt-5.6-luna', reasoningEffort: 'low', ...(raw.settings as object ?? {}) },
    project: { challengeMode: 'explain', ...(raw.project as object ?? {}) },
    stats: { totalXp: 0, totalChallenges: 0, gradeDistribution: [0, 0, 0, 0], sessionXp: 0, ...(raw.stats as object ?? {}) },
  }
  if (Array.isArray(normalized.attempts)) {
    normalized.attempts = normalized.attempts.map((attempt) => ({
      ...(attempt as object),
      grade: typeof (attempt as Record<string, unknown>).grade === 'number'
        ? (['C', 'B', 'A', 'S'][(attempt as Record<string, unknown>).grade as number] || 'C')
        : (attempt as Record<string, unknown>).grade,
    }))
  }
  const rawTree = normalized.tree as Record<string, unknown> | undefined
  if (rawTree?.nodes && typeof rawTree.nodes === 'object' && !Array.isArray(rawTree.nodes)) {
    const attemptsByNode = new Map<string, number>()
    for (const attempt of normalized.attempts as Array<Record<string, unknown>>) {
      const nodeId = typeof attempt.nodeId === 'string' ? attempt.nodeId : ''
      const grade = typeof attempt.grade === 'string' ? attempt.grade as keyof typeof XP_BY_GRADE : undefined
      if (!nodeId || !grade || XP_BY_GRADE[grade] === undefined) continue
      attemptsByNode.set(nodeId, Math.max(attemptsByNode.get(nodeId) ?? 0, XP_BY_GRADE[grade]))
    }
    normalized.tree = {
      ...rawTree,
      nodes: Object.fromEntries(Object.entries(rawTree.nodes as Record<string, unknown>).map(([id, value]) => {
        const node = value as Record<string, unknown>
        const historicalXp = attemptsByNode.get(id)
        const complete = node.status === 'cleared' || historicalXp !== undefined
        const xp = Math.min(100, Math.max(complete ? Number(node.xp) || 0 : 0, historicalXp ?? 0))
        const status = complete ? 'cleared' : node.status
        const masteryState = xp >= XP_BY_GRADE.S ? 'mastered' : xp > 0 ? 'developing' : 'familiar'
        return [id, { ...node, xp, status, masteryState }]
      })),
    }
  }
  return WorkspaceSchemaForMigration(normalized)
}

export function migrateWorkspaceBundle(input: unknown): WorkspaceBundle {
  if (!input || typeof input !== 'object') throw new Error('Save data must be an object')
  const raw = input as Record<string, unknown>
  const formatVersion = typeof raw.formatVersion === 'number' ? raw.formatVersion : 1
  if (formatVersion > 2) throw new Error(`Unsupported workspace save format v${formatVersion}`)
  const legacyWorkspace = raw.project && raw.tree ? migrateWorkspace(raw) : undefined
  const rawWorkspaces = Array.isArray(raw.workspaces) ? raw.workspaces : legacyWorkspace ? [legacyWorkspace] : []
  if (rawWorkspaces.length === 0) throw new Error('Workspace save contains no learning trees')
  const workspaces = rawWorkspaces.map((item) => migrateWorkspace(item))
  const firstSettings = workspaces[0].settings
  const rawSettings = raw.settings && typeof raw.settings === 'object' ? raw.settings : {}
  const settings = { ...firstSettings, ...rawSettings }
  const normalized = {
    formatVersion: 2,
    appVersion: typeof raw.appVersion === 'string' ? raw.appVersion : '0.1.0',
    schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 1,
    connectorProtocolVersion: typeof raw.connectorProtocolVersion === 'string' ? raw.connectorProtocolVersion : '1',
    settings,
    workspaces: workspaces.map((item) => ({ ...item, settings })),
  }
  return WorkspaceBundleSchema.parse(normalized) as WorkspaceBundle
}

function WorkspaceSchemaForMigration(value: unknown): Workspace {
  return WorkspaceSchema.parse(value) as Workspace
}
