import { GradeResponseSchema, ProposalResponseSchema, ChallengeSchema, NodeSchema, ResourceSchema } from './schemas'
import type { Challenge, ConnectorModel, ConnectorStatus, GradeResponse, Proposal } from './types'

export interface ResearchEvidence {
  searchCalls: number
  searches: string[]
  sources: Array<{ title: string; url: string; query?: string }>
  logs?: string[]
}

export type ConnectorOperation = 'tree_propose' | 'node_expand' | 'node_create' | 'challenge_create' | 'answer_grade'

export class ConnectorError extends Error {
  constructor(message: string, public readonly code = 'connector_error') {
    super(message)
    this.name = 'ConnectorError'
  }
}

export class ConnectorClient {
  private token: string | undefined

  constructor(private readonly baseUrl: string) {}

  async status(): Promise<ConnectorStatus> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/status`, { headers: { Accept: 'application/json' } })
      if (!response.ok) throw new ConnectorError('Connector returned an error', 'http_error')
      const data = await response.json() as ConnectorStatus
      this.token = data.token
      return { ...data, connected: Boolean(data.connected), authenticated: Boolean(data.authenticated) }
    } catch (error) {
      this.token = undefined
      return { connected: false, authenticated: false, appServerRunning: false, modelAvailable: false, message: 'Connector is not reachable.', error: { code: 'offline', message: error instanceof Error ? error.message : 'Connector is not reachable.' } }
    }
  }

  async listModels(): Promise<ConnectorModel[]> {
    const token = await this.ensureToken()
    const response = await fetch(`${this.baseUrl}/v1/models`, { headers: { Accept: 'application/json', 'X-Challenge-Tree-Token': token } })
    if (!response.ok) throw await this.readError(response, 'Could not load the model list.')
    const data = await response.json() as { models?: ConnectorModel[] }
    return Array.isArray(data.models) ? data.models : []
  }

  async selectModel(model: string, reasoningEffort?: string): Promise<ConnectorStatus> {
    const token = await this.ensureToken()
    const response = await fetch(`${this.baseUrl}/v1/settings/model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Challenge-Tree-Token': token },
      body: JSON.stringify({ model, ...(reasoningEffort ? { reasoningEffort } : {}) })
    })
    if (!response.ok) throw await this.readError(response, 'The selected model could not be applied.')
    return this.status()
  }

  async treePropose(input: { topic: string; goal: string; researchMode: 'ja' | 'global'; challengeMode: 'explain' | 'short_answer' | 'true_false'; priorKnowledge: string }, onProgress?: (message: string) => void, onResearch?: (evidence: ResearchEvidence) => void): Promise<Proposal[]> {
    const parsed = await this.runValidated('tree_propose', input, (value) => ProposalResponseSchema.safeParse(value), onProgress, onResearch)
    return parsed.proposals as Proposal[]
  }

  async nodeExpand(input: unknown, onProgress?: (message: string) => void, onResearch?: (evidence: ResearchEvidence) => void): Promise<{ nodes: unknown[]; edges: unknown[]; resources: unknown[]; challenges: unknown[] }> {
    const data = await this.runValidated<{ nodes: unknown[]; edges: unknown[]; resources: unknown[]; challenges: unknown[] }>('node_expand', input, (value: unknown) => {
      const item = value as Record<string, unknown>
      const requestedCount = Number((input as Record<string, unknown>)?.branchCount ?? 3)
      const expectedCount = Number.isInteger(requestedCount) ? Math.max(1, Math.min(10, requestedCount)) : 3
      const edges = Array.isArray(item?.edges) ? item.edges : []
      const validEdges = Array.isArray(item?.edges) && edges.every((edge) => {
        const value = edge as Record<string, unknown>
        return typeof value?.from === 'string' && typeof value?.to === 'string' && ['dependency', 'recommended', 'related'].includes(String(value?.type))
      })
      const nodes = Array.isArray(item?.nodes) ? item.nodes : []
      const resources = Array.isArray(item?.resources) ? item.resources : []
      const challenges = Array.isArray(item?.challenges) ? item.challenges : []
      const normalizedItem = { ...item, nodes, edges, resources, challenges }
      return Array.isArray(item?.nodes) && nodes.length === expectedCount && nodes.every((node) => NodeSchema.safeParse(node).success) && validEdges && edges.length === expectedCount && Array.isArray(item?.resources) && resources.every((resource) => ResourceSchema.safeParse(resource).success) && Array.isArray(item?.challenges) && challenges.length === expectedCount && challenges.every((challenge) => ChallengeSchema.safeParse(challenge).success)
        ? { success: true as const, data: normalizedItem } : { success: false as const, error: 'invalid' }
    }, onProgress, onResearch)
    return { nodes: data.nodes as unknown[], edges: data.edges as unknown[], resources: data.resources as unknown[], challenges: data.challenges as unknown[] }
  }

  async nodeCreate(input: unknown, onProgress?: (message: string) => void, onResearch?: (evidence: ResearchEvidence) => void): Promise<{ node: unknown; resources: unknown[]; challenges: unknown[] }> {
    const data = await this.runValidated<{ node: unknown; resources: unknown[]; challenges: unknown[] }>('node_create', input, (value: unknown) => {
      const item = value as Record<string, unknown>
      const resources = Array.isArray(item?.resources) ? item.resources : []
      const challenges = Array.isArray(item?.challenges) ? item.challenges : []
      const node = item?.node
      return node && NodeSchema.safeParse(node).success && resources.every((resource) => ResourceSchema.safeParse(resource).success) && challenges.length === 1 && challenges.every((challenge) => ChallengeSchema.safeParse(challenge).success)
        ? { success: true as const, data: { ...item, node, resources, challenges } } : { success: false as const, error: 'invalid' }
    }, onProgress, onResearch)
    return { node: data.node, resources: data.resources as unknown[], challenges: data.challenges as unknown[] }
  }

  async challengeCreate(input: unknown, onProgress?: (message: string) => void, onResearch?: (evidence: ResearchEvidence) => void): Promise<Challenge> {
    return await this.runValidated('challenge_create', input, (value) => ChallengeSchema.safeParse(value), onProgress, onResearch) as Challenge
  }

  async answerGrade(input: unknown, onProgress?: (message: string) => void, onResearch?: (evidence: ResearchEvidence) => void): Promise<GradeResponse> {
    return await this.runValidated('answer_grade', input, (value) => GradeResponseSchema.safeParse(value), onProgress, onResearch) as GradeResponse
  }

  private async runValidated<T>(operation: ConnectorOperation, input: unknown, validator: (value: unknown) => { success: boolean; data?: T }, onProgress?: (message: string) => void, onResearch?: (evidence: ResearchEvidence) => void): Promise<T> {
    let runResult = await this.run(operation, input, onProgress)
    let parsed = validator(runResult.data)
    if (!parsed.success) {
      const repairInput = input && typeof input === 'object' ? { ...(input as Record<string, unknown>), repair: true } : { input, repair: true }
      runResult = await this.run(operation, repairInput, onProgress)
      parsed = validator(runResult.data)
    }
    if (!parsed.success || parsed.data === undefined) throw new ConnectorError(`${operation.toUpperCase()} returned invalid structured data`, 'invalid_output')
    onResearch?.(runResult.research)
    return parsed.data
  }

  private async run(operation: ConnectorOperation, input: unknown, onProgress?: (message: string) => void): Promise<{ data: unknown; research: ResearchEvidence }> {
    const response = await fetch(`${this.baseUrl}/v1/jobs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Challenge-Tree-Token': this.token ?? '' },
      body: JSON.stringify({ operation, payload: input }),
    }).catch(() => { throw new ConnectorError('Connector is not reachable.', 'offline') })
    if (!response.ok) throw new ConnectorError(`Connector request failed (${response.status})`, 'http_error')
    const body = await response.json() as Record<string, unknown>
    if ('result' in body) return this.unwrapRunResult(body.result)
    if (body.jobId) return this.readJobEvents(String(body.jobId), onProgress)
    throw new ConnectorError('Connector returned no job result', 'invalid_response')
  }

  private async ensureToken(): Promise<string> {
    if (this.token) return this.token
    const status = await this.status()
    if (status.token) return status.token
    throw new ConnectorError(status.error?.message || 'Connector is not reachable.', status.error?.code || 'offline')
  }

  private async readError(response: Response, fallback: string): Promise<ConnectorError> {
    let message = fallback
    try {
      const body = await response.json() as { error?: { message?: string } }
      if (body.error?.message) message = body.error.message
    } catch {
      // Keep the local fallback when the connector response is not JSON.
    }
    return new ConnectorError(message, response.status === 401 ? 'unauthorized' : 'http_error')
  }

  private unwrapRunResult(value: unknown): { data: unknown; research: ResearchEvidence } {
    if (value && typeof value === 'object' && !Array.isArray(value) && 'data' in value) {
      const envelope = value as { data?: unknown; research?: ResearchEvidence }
      return { data: envelope.data, research: envelope.research || { searchCalls: 0, searches: [], sources: [], logs: [] } }
    }
    return { data: value, research: { searchCalls: 0, searches: [], sources: [], logs: [] } }
  }

  private async readJobEvents(jobId: string, onProgress?: (message: string) => void): Promise<{ data: unknown; research: ResearchEvidence }> {
    const response = await fetch(`${this.baseUrl}/v1/jobs/${encodeURIComponent(jobId)}/events`, {
      headers: { Accept: 'text/event-stream', 'X-Challenge-Tree-Token': this.token ?? '' },
    }).catch(() => { throw new ConnectorError('Could not read connector job events.', 'stream_error') })
    if (!response.ok || !response.body) throw new ConnectorError('Connector event stream failed.', 'stream_error')
    let result: unknown = undefined
    let sawEvent = false
    let buffer = ''
    const processBlock = (block: string) => {
      const eventName = block.match(/^event:\s*(.+)$/m)?.[1]
      const dataLine = block.match(/^data:\s*(.+)$/m)?.[1]
      if (!eventName || !dataLine) return
      sawEvent = true
      try {
        const data = JSON.parse(dataLine) as Record<string, unknown>
        if (eventName === 'progress' && typeof data.message === 'string') onProgress?.(data.message)
        if (eventName === 'result' || eventName === 'job.result') result = data
        if (eventName === 'error' || eventName === 'job.failed') throw new ConnectorError(String(data.message ?? 'Codex operation failed.'), typeof data.code === 'string' ? data.code : 'job_error')
        if (eventName === 'done' && data.cancelled) throw new ConnectorError('Codex operation was cancelled.', 'job_cancelled')
        if (eventName === 'job.cancelled') throw new ConnectorError('Codex operation was cancelled.', 'job_cancelled')
      } catch (error) {
        if (error instanceof ConnectorError) throw error
        throw new ConnectorError('Connector returned malformed event data.', 'invalid_output')
      }
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      const blocks = buffer.split(/\r?\n\r?\n/)
      buffer = blocks.pop() || ''
      for (const block of blocks) processBlock(block)
    }
    buffer += decoder.decode()
    if (buffer.trim()) processBlock(buffer)
    if (!sawEvent) throw new ConnectorError('Connector returned an empty event stream.', 'empty_stream')
    if (result === undefined) throw new ConnectorError('Connector completed without a result.', 'empty_result')
    return this.unwrapRunResult(result)
  }
}
