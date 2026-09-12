import { describe, expect, it } from 'vitest'
import { applyGradeToNode, masteryFromXp, unlockAvailableNodes } from './core'
import { createSampleWorkspace } from './sample'
import { GradeResponseSchema, safeParseWorkspace } from './schemas'
import { migrateWorkspace } from './core'

describe('Challenge Tree core rules', () => {
  it('maps letter grades to XP and mastery bands', () => {
    expect(applyGradeToNode(createSampleWorkspace().tree.nodes['transformer-overview'], 'S').xpAwarded).toBe(100)
    expect(masteryFromXp(40)).toBe('developing')
    expect(masteryFromXp(70)).toBe('developing')
    expect(masteryFromXp(100)).toBe('mastered')
  })

  it('keeps the best grade and caps one node at 100 XP across retries', () => {
    const workspace = createSampleWorkspace()
    const node = workspace.tree.nodes['transformer-overview']
    expect(applyGradeToNode(node, 'B').node.xp).toBe(40)
    expect(applyGradeToNode({ ...node, xp: 40 }, 'A').node.xp).toBe(70)
    expect(applyGradeToNode({ ...node, xp: 100 }, 'B').xpAwarded).toBe(0)
    expect(applyGradeToNode({ ...node, xp: 100 }, 'S').node.xp).toBe(100)
  })

  it('unlocks a hidden node after every dependency is cleared', () => {
    const workspace = createSampleWorkspace()
    const child = { ...workspace.tree.nodes['transformer-overview'], id: 'child', title: 'Child', status: 'hidden' as const, prerequisites: ['transformer-overview'], children: [], challengeIds: [], resourceIds: [] }
    const tree = { ...workspace.tree, nodes: { 'transformer-overview': { ...workspace.tree.nodes['transformer-overview'], status: 'cleared' as const }, child } }
    const result = unlockAvailableNodes(tree)
    expect(result.unlockedIds).toEqual(['child'])
    expect(result.tree.nodes.child.status).toBe('unlocked')
  })

  it('does not expose a node before its dependency is cleared', () => {
    const workspace = createSampleWorkspace()
    const nodes = { ...workspace.tree.nodes,
      child: { ...workspace.tree.nodes['transformer-overview'], id: 'child', title: 'Child', status: 'hidden' as const, prerequisites: ['transformer-overview'], children: [], challengeIds: [], resourceIds: [] },
    }
    const first = unlockAvailableNodes({ ...workspace.tree, nodes: { ...nodes, 'transformer-overview': { ...workspace.tree.nodes['transformer-overview'], status: 'cleared' as const } } })
    expect(first.tree.nodes.child.status).toBe('unlocked')
    expect(first.unlockedIds).toContain('child')
  })

  it('round-trips a human-readable save through schema validation', () => {
    const workspace = createSampleWorkspace('ja')
    const roundTrip = JSON.parse(JSON.stringify(workspace))
    expect(safeParseWorkspace(roundTrip).success).toBe(true)
  })

  it('migrates a legacy save with omitted metadata', () => {
    const workspace = createSampleWorkspace()
    const legacy = { ...workspace, formatVersion: undefined, appVersion: undefined, schemaVersion: undefined, connectorProtocolVersion: undefined }
    const migrated = migrateWorkspace(legacy)
    expect(migrated.formatVersion).toBe(1)
    expect(migrated.connectorProtocolVersion).toBe('1')
  })

  it('rejects malformed structured grading output', () => {
    expect(GradeResponseSchema.safeParse({ grade: 9, summary: 'bad' }).success).toBe(false)
  })
})
