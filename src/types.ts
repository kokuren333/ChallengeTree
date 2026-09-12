export type ResearchMode = 'ja' | 'global'
export type UiLanguage = 'ja' | 'en'
export type NodeStatus = 'hidden' | 'unlocked' | 'cleared'
export type MasteryState = 'familiar' | 'developing' | 'mastered'
export type PromptStyle = 'definition' | 'why' | 'mechanism' | 'compare' | 'scenario' | 'critique' | 'synthesis'
export type ChallengeMode = 'explain' | 'short_answer' | 'true_false'
export type Grade = 'C' | 'B' | 'A' | 'S'
export type ResourceType =
  | 'primary_paper'
  | 'official_docs'
  | 'government'
  | 'university'
  | 'textbook'
  | 'course'
  | 'technical_docs'
  | 'article'
  | 'video'
  | 'community'
  | 'other'

export interface Position {
  x: number
  y: number
}

export interface CurriculumContext {
  proposalId?: string
  title: string
  philosophy: string
  learnerProfile: string
  branches: string[]
  advantages: string[]
  tradeoffs: string
}

export interface Project {
  id: string
  title: string
  topic: string
  goal: string
  researchMode: ResearchMode
  challengeMode?: ChallengeMode
  curriculumContext?: CurriculumContext
  createdAt: string
  updatedAt: string
}

export interface NodeRecord {
  id: string
  title: string
  description: string
  goal: string
  status: NodeStatus
  xp: number
  masteryState: MasteryState
  prerequisites: string[]
  children: string[]
  resourceIds: string[]
  challengeIds: string[]
  position: Position
  createdAt: string
  updatedAt: string
  archived?: boolean
}

export interface Edge {
  from: string
  to: string
  type: 'dependency' | 'recommended' | 'related'
}

export interface Tree {
  rootNodeId: string
  nodes: Record<string, NodeRecord>
  edges: Edge[]
}

export interface ResourceLocator {
  kind: 'section' | 'page' | 'heading' | 'chapter' | 'timestamp' | 'other'
  value: string
}

export interface Resource {
  id: string
  title: string
  url: string
  language: string
  type: ResourceType
  authorityTier: 'A' | 'B' | 'C' | 'D'
  locator?: ResourceLocator
  guidance: string
  supports: string[]
  verifiedAt?: string
}

export interface RubricItem {
  criterion: string
  required: boolean
}

export interface Challenge {
  id: string
  nodeId: string
  promptStyle: PromptStyle
  difficulty: 1 | 2 | 3 | 4
  prompt: string
  expectedConcepts: string[]
  modelAnswer: string
  rubric: RubricItem[]
  commonMisconceptions: string[]
  resourceIds: string[]
  createdAt: string
  mode?: ChallengeMode
  questions?: ChallengeQuestion[]
  explanation: string
}

export interface ChallengeQuestion {
  id: string
  prompt: string
  modelAnswer: string
  expectedConcepts: string[]
  explanation: string
}

export interface GradeFeedback {
  summary: string
  correct: string[]
  missing: string[]
  misconceptions: string[]
  nuance: string[]
  nextStep: string
  recommendedAction?: 'retry' | 'deepen' | 'repair' | 'branch'
  recommendedNodeIds?: string[]
}

export interface Attempt {
  id: string
  challengeId: string
  nodeId: string
  answer: string
  grade: Grade
  feedback: GradeFeedback
  xpAwarded: number
  createdAt: string
}

export interface ResearchRecord {
  id: string
  operation: 'tree_propose' | 'node_expand' | 'node_create' | 'challenge_create' | 'answer_grade'
  nodeId?: string
  challengeId?: string
  query: string
  mode: ResearchMode
  status: 'completed' | 'failed'
  startedAt: string
  completedAt: string
  summary: string
  resourceIds: string[]
  generatedNodeIds: string[]
  searches: string[]
  sources: Array<{ title: string; url: string; query?: string }>
  logs: string[]
  unknownClaims: string[]
}

export interface Settings {
  uiLanguage: UiLanguage
  connectorUrl: string
  reducedMotion: boolean
  model?: string
  reasoningEffort?: string
}

export interface Stats {
  totalXp: number
  totalChallenges: number
  gradeDistribution: [number, number, number, number]
  sessionXp: number
}

export interface Workspace {
  formatVersion: number
  appVersion: string
  schemaVersion: number
  connectorProtocolVersion: string
  project: Project
  tree: Tree
  challenges: Challenge[]
  attempts: Attempt[]
  resources: Resource[]
  research: ResearchRecord[]
  settings: Settings
  stats: Stats
  draftAnswers: Record<string, string>
}

/** A portable workspace file can contain every learning tree in the browser. */
export interface WorkspaceBundle {
  formatVersion: number
  appVersion: string
  schemaVersion: number
  connectorProtocolVersion: string
  settings: Settings
  workspaces: Workspace[]
}

export interface Proposal {
  id: string
  title: string
  philosophy: string
  learnerProfile: string
  branches: string[]
  advantages: string[]
  tradeoffs: string
  root: Omit<NodeRecord, 'status' | 'xp' | 'masteryState' | 'prerequisites' | 'children' | 'resourceIds' | 'challengeIds'>
  initialNodes: NodeRecord[]
  initialEdges: Edge[]
  resources?: Resource[]
  challenges?: Challenge[]
}

export interface ConnectorStatus {
  connected: boolean
  authenticated: boolean
  connector?: string
  codexFound?: boolean
  appServerRunning?: boolean
  modelAvailable?: boolean
  model?: string
  reasoningEffort?: string | null
  codexVersion?: string | null
  appServerVersion?: string | null
  token?: string
  message?: string
  error?: { code?: string; message?: string; stderr?: string[] } | null
  stderr?: string[]
}

export interface ConnectorModel {
  id: string
  model: string
  displayName: string
  description: string
  defaultReasoningEffort?: string | null
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>
  isDefault?: boolean
}

export interface GradeResponse {
  grade: Grade
  summary: string
  correct: string[]
  missing: string[]
  misconceptions: string[]
  nuance: string[]
  recommendedAction: 'retry' | 'deepen' | 'repair' | 'branch'
  recommendedNodeIds: string[]
  nextStep?: string
}
