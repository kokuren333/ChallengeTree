import type { Challenge, NodeRecord, Resource, Workspace } from './types'

const now = '2026-01-01T00:00:00.000Z'

export function createSampleWorkspace(uiLanguage: 'ja' | 'en' = 'en'): Workspace {
  const rootId = 'transformer-overview'
  const challengeId = 'ch-transformer-overview'
  const resource: Resource = {
    id: 'res-attention-paper', title: 'Attention Is All You Need', url: 'https://arxiv.org/abs/1706.03762', language: 'en', type: 'primary_paper', authorityTier: 'A',
    locator: { kind: 'section', value: '3.2 — Attention' }, guidance: 'Read the definition of scaled dot-product attention and the reason for dividing by √dₖ. Start here; later branches are generated after your first answer.', supports: ['transformer-overview'], verifiedAt: now,
  }
  const challenge: Challenge = {
    id: challengeId, nodeId: rootId, promptStyle: 'definition', difficulty: 1,
    prompt: 'Transformerは、系列データを扱う従来のモデルと比べて、何をどのように処理するアーキテクチャですか？ Attentionとの関係にも触れて説明してください。',
    expectedConcepts: ['attention-based sequence processing', 'parallel processing', 'relationships between tokens'],
    modelAnswer: 'Transformerは再帰や畳み込みを中心にせず、Attentionで系列中のトークン同士の関係を重み付けして処理するモデルです。系列全体を並列に扱えるため、長距離の依存関係も直接参照できます。',
    explanation: 'Attentionでトークン間の関係を計算し、系列全体を並列に処理できることが要点です。',
    rubric: [{ criterion: 'Attentionでトークン間の関係を処理する', required: true }, { criterion: '並列処理または長距離依存に触れる', required: true }],
    commonMisconceptions: ['Attention is a fixed lookup table', 'Transformers understand meaning without training data'], resourceIds: [resource.id], createdAt: now, mode: 'explain', questions: [{ id: `${challengeId}-main`, prompt: 'Transformerの中心的な処理を説明してください。', modelAnswer: 'Attentionでトークン間の関係を処理し、系列全体を並列に扱う。', expectedConcepts: ['attention', 'parallel processing'], explanation: 'Attentionによる関係計算と並列処理が中心です。' }],
  }
  const root: NodeRecord = {
    id: rootId, title: 'Transformer overview', description: 'The central idea: model relationships between tokens with attention.', goal: 'Explain what a Transformer computes and why attention is its organizing principle.', status: 'unlocked', xp: 0, masteryState: 'familiar', prerequisites: [], children: [], resourceIds: [resource.id], challengeIds: [challengeId], position: { x: 110, y: 270 }, createdAt: now, updatedAt: now,
  }
  return {
    formatVersion: 1, appVersion: '0.1.0', schemaVersion: 1, connectorProtocolVersion: '1',
    project: { id: 'sample-transformer-v3', title: 'Transformer foundations', topic: 'Transformer', goal: 'Understand the architecture well enough to read technical papers and implementation discussions.', researchMode: 'global', challengeMode: 'explain', createdAt: now, updatedAt: now },
    tree: { rootNodeId: rootId, nodes: { [rootId]: root }, edges: [] }, challenges: [challenge], attempts: [], resources: [resource], research: [],
    settings: { uiLanguage, connectorUrl: 'http://127.0.0.1:43110', reducedMotion: false, model: 'gpt-5.6-luna', reasoningEffort: 'low' },
    stats: { totalXp: 0, totalChallenges: 0, gradeDistribution: [0, 0, 0, 0], sessionXp: 0 }, draftAnswers: {},
  }
}
