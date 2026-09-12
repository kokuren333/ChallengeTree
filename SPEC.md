# Challenge Tree — Product & Technical Specification

Version: 0.1-draft  
Status: Product specification / implementation contract  
Primary target: Browser-based learning game + local Codex connector  
AI backend assumption: Codex App Server using GPT-5.6 Luna (lightweight / low-cost operation)

---

## 1. Product Summary

**Challenge Tree** is a gamified self-learning system in which users grow a visual skill tree by completing AI-generated explanation challenges grounded in real web resources.

The product does **not** attempt to generate entire textbooks or replace high-quality educational resources. Instead, Codex researches the web, identifies good sources, designs an appropriate skill tree, creates challenges and grading rubrics, guides the learner toward the exact sections needed to answer them, evaluates the learner's response, detects misunderstandings, and unlocks the next branches of the tree.

The central fantasy is:

> **Explore a knowledge domain by clearing challenges, and watch the map of what you understand expand.**

The product is intentionally optimized for **deep binge learning** rather than daily streaks, reminders, habit formation, or spaced-repetition-first workflows.

---

# 2. Product Philosophy

## 2.1 Core idea

Challenge Tree turns a learning domain into an explorable dependency graph.

A user does not begin with a course.

A user begins with:

1. a topic they want to master,
2. three possible ways of structuring that domain,
3. a small visible frontier,
4. a set of challenges,
5. real external resources that help solve those challenges.

As challenges are cleared, new nodes and subdomains become visible.

The tree is therefore simultaneously:

- a curriculum,
- a progress map,
- a game board,
- a record of demonstrated understanding,
- a recommendation engine for what to learn next.

---

## 2.2 What Challenge Tree is not

Challenge Tree is **not**:

- a note-taking app,
- a flashcard app,
- a daily streak app,
- a generated textbook,
- a generic chatbot,
- a full LMS,
- a social network,
- an achievement/loot economy simulator,
- a knowledge graph that attempts to map an entire field in advance.

The product must resist feature creep toward any of these.

---

## 2.3 Primary design principles

### P1. Explain-first

All challenges are answered primarily through natural language explanation.

Recall, reasoning, comparison, application, and critique are treated as variants of explanation rather than separate task systems.

### P2. Existing resources over generated textbooks

AI should not generate long instructional chapters when a good existing resource already exists.

AI's role is closer to:

- librarian,
- curriculum designer,
- examiner,
- evaluator,
- misconception detector.

### P3. Lazy expansion

The system should not generate the entire tree upfront.

Only the current frontier and nearby descendants should be expanded.

This keeps:

- token usage low,
- trees manageable,
- uncertainty bounded,
- exploration game-like.

### P4. Demonstrated understanding, not content consumption

Reading a page does not clear a node.

A user clears a node by demonstrating understanding in a Challenge.

### P5. Game progression without fake game systems

The product should get its reward loop from:

- clearing nodes,
- raising mastery,
- unlocking branches,
- revealing hidden concepts,
- seeing the tree grow.

Do not add currencies, loot, daily streaks, energy systems, shops, or arbitrary collectibles unless later evidence clearly shows they improve the experience.

### P6. Local-first ownership

User learning data belongs to the user.

Primary storage:

- browser IndexedDB.

Portable backup:

- JSON import/export.

No Challenge Tree account is required for core use.

### P7. BYO Codex

Challenge Tree does not centrally pay for or proxy model inference.

Each user connects their own local Codex environment through a portable connector.

---

# 3. Target User Experience

## 3.1 Core emotional loop

The desired feeling is:

> "I want to clear just one more node because I want to see what is behind it."

Not:

> "I should study today because my streak will break."

---

## 3.2 Typical session

A session may last:

- 10 minutes,
- 45 minutes,
- 3 hours,
- 8 hours.

The system should not assume fixed lesson lengths.

The tree should support continuous binge-style progression.

---

# 4. Core Loop

```text
Choose / create learning project
        ↓
Codex researches topic
        ↓
Generate 3 possible tree structures
        ↓
User chooses one
        ↓
Root + first frontier appears
        ↓
User opens node
        ↓
See:
- objective
- resource guide
- challenge
        ↓
User studies external resources as needed
        ↓
User writes explanation
        ↓
Codex grades response
        ↓
Feedback:
- correct understanding
- missing points
- misconceptions
- nuance / caveats
        ↓
Update mastery / XP
        ↓
If threshold reached:
- clear node
- unlock children
- optionally expand frontier via new research
        ↓
Recommend next node(s)
        ↓
Repeat
```

---

# 5. Project Creation Flow

## 5.1 Start screen

Primary actions:

- `New Learning Tree`
- `Continue`
- `Import Save`
- `Settings`

Secondary status:

- Codex Connector: Connected / Not Connected
- Local save status

---

## 5.2 New Learning Tree

User enters:

### Required

- Topic / domain
- Learning goal

Example:

```text
Topic:
Transformer

Goal:
I want to understand modern transformer-based LLM architecture well enough
to critically read technical papers and implementation discussions.
```

### Research mode

Two primary modes:

#### Japanese

Search preference:

1. official Japanese documentation,
2. Japanese university materials,
3. Japanese government / public institutions,
4. high-quality Japanese technical documentation,
5. trustworthy Japanese explanatory resources,
6. English primary sources only when important or unavoidable.

User-facing explanations and challenges remain Japanese.

#### Global

Search preference:

1. primary literature,
2. official documentation,
3. universities,
4. textbooks / reputable course materials,
5. high-quality technical references,
6. strong explanatory resources.

English resources are freely permitted.

User-facing UI and challenges may still be Japanese.

---

## 5.3 Optional creation parameters

Keep hidden under `Advanced`.

- Prior knowledge: beginner / intermediate / advanced / auto-diagnose
- Tree breadth preference: focused / balanced / broad
- Theory ↔ practical emphasis
- Maximum initial visible nodes
- Source strictness
- Time budget hint

These must not be required for MVP.

---

# 6. Tree Proposal Phase

Codex performs initial web research and returns **three alternative curriculum structures**.

Each proposal contains:

- title,
- one-sentence philosophy,
- intended learner profile,
- major branches,
- advantages,
- tradeoffs.

Example:

```text
A. Foundations-first
Math → Attention → Transformer Block → Training → Inference

B. Architecture-first
Transformer Overview → Attention → Position → MLP → Normalization → Scaling

C. LLM-engineering-first
Tokenization → Context → KV Cache → Sampling → Serving → Model Internals
```

The user selects one.

The other two are discarded unless explicitly saved.

---

# 7. Skill Tree Model

## 7.1 Tree semantics

The visual structure may technically be a DAG rather than a strict tree.

However, the product should present it as a "tree".

A node represents:

> A coherent concept or capability that can reasonably be tested through one or more explanation challenges.

Examples:

Good:
- KV Cache
- Bayes theorem
- Septic shock
- Jazz secondary dominants

Too broad:
- Medicine
- Machine Learning

Too narrow:
- one isolated factual sentence.

---

## 7.2 Node lifecycle

```text
hidden
  ↓
discovered
  ↓
unlocked
  ↓
in_progress
  ↓
cleared
  ↓
mastered
```

### hidden

Not visible yet.

### discovered

Visible on tree but unavailable.

Used to create anticipation.

### unlocked

Challenge available.

### in_progress

At least one attempt made.

### cleared

Minimum mastery threshold reached.

Children may unlock.

### mastered

Optional higher threshold indicating strong repeated performance.

Mastered is not required to progress unless defined by tree rules.

---

## 7.3 Suggested mastery rules

Simple first implementation.

Each challenge grade maps to mastery gain.

```text
Grade 0: 0 XP
Grade 1: +20 XP
Grade 2: +50 XP
Grade 3: +90 XP
```

Suggested thresholds:

```text
0–49 XP    Familiarity
50–119     Developing
120–199    Cleared
200+       Mastered
```

Exact numbers are presentation values, not psychometric claims.

Do not present mastery percentages as scientifically precise estimates of competence.

---

# 8. Challenge System

## 8.1 One unified challenge primitive

All tasks use free-form natural-language responses.

Internal prompt styles may vary, but the data model remains unified.

Supported prompt patterns:

- Definition
- Explain Why
- Mechanism
- Compare
- Relationship
- Scenario
- Critique
- Counterexample
- Error Detection
- Synthesis

These are **generation styles**, not distinct game modes.

---

## 8.2 Examples

### Definition

> Explain what KV Cache is and what problem it solves.

### Why

> Explain why scaled dot-product attention divides by √d_k.

### Compare

> Explain the difference between BatchNorm and LayerNorm and why Transformer architectures usually prefer the latter.

### Scenario

> A decoder-only Transformer becomes increasingly expensive as output length grows. Explain what redundant computation occurs and how KV Cache changes it.

### Critique

> "RAG eliminates hallucinations because the model always answers from retrieved documents."  
> Explain what is wrong or incomplete about this claim.

---

# 9. Resource Guide

The Resource Guide is a central product feature.

For every node, Codex should identify external materials and specify **where to look**.

A resource entry should include:

- title,
- URL,
- source type,
- language,
- authority level,
- exact relevant section/page/heading when possible,
- why this resource is useful,
- what the learner should understand from it.

Example:

```text
Attention Is All You Need
Section 3.2.1 — Scaled Dot-Product Attention

Read specifically:
- the definition of dot-product attention,
- the paragraph explaining large dot products,
- the reason for dividing by √d_k.

You do NOT need to read the entire paper for this challenge.
```

This "what to read" guidance is more important than generic resource listing.

---

# 10. Source Quality Policy

Codex should rank sources approximately as:

## Tier A

- primary papers,
- standards,
- official technical documentation,
- government / public bodies,
- university course materials,
- professional guidelines.

## Tier B

- reputable textbooks,
- well-maintained technical documentation,
- established educational organizations.

## Tier C

- high-quality explanatory articles,
- reputable engineering blogs,
- respected personal technical references.

## Tier D

- forums,
- community Q&A,
- informal blogs,
- social posts.

Tier D should be used only when useful for intuition or practical context, not as sole support for important factual claims.

---

# 11. Challenge Generation

A Challenge object should be created from:

- node objective,
- selected resources,
- current mastery,
- recent mistakes,
- prior challenge history,
- desired difficulty.

The generated challenge should contain:

1. prompt,
2. expected concepts,
3. model answer,
4. grading rubric,
5. common misconceptions,
6. supporting resource references.

The **model answer is hidden from the learner until grading**.

---

# 12. Grading

## 12.1 Grade scale

Use a coarse four-level scale.

```text
0 — Incorrect / insufficient
1 — Partial understanding
2 — Mostly correct
3 — Strong understanding
```

Avoid fake precision such as 83.7%.

---

## 12.2 Evaluation dimensions

Codex should evaluate:

- factual correctness,
- conceptual coverage,
- reasoning / causal understanding,
- major misconceptions.

Clarity may be commented on but should not dominate mastery unless explanation quality itself is the target skill.

---

## 12.3 Required grading output

Every grading result must return:

- grade,
- concise summary,
- correct points,
- missing points,
- misconceptions,
- nuance / caution,
- suggested next step,
- optional follow-up challenge.

Example:

```text
Grade: 2 — Mostly correct

Correct:
✓ You correctly identified reuse of previous K/V states.
✓ You explained the autoregressive setting.

Missing:
- The memory/computation tradeoff.
- Why queries still need to be computed for the new token.

Misconception:
None detected.

Next:
Study the memory scaling of KV Cache, then retry with a comparison against recomputation.
```

---

# 13. Retry Behavior

A failed challenge should not simply regenerate another unrelated question.

Recommended sequence:

```text
Attempt 1 fails
    ↓
Feedback + resource guidance
    ↓
Retry same underlying concept with reworded prompt
    ↓
If repeatedly failed:
split node / reveal prerequisite / recommend adjacent prerequisite
```

This enables the tree to adapt structurally.

---

# 14. Dynamic Tree Expansion

The tree is generated lazily.

When a node is cleared:

1. inspect existing planned descendants,
2. determine whether expansion is needed,
3. run web research if needed,
4. generate up to N child nodes,
5. reveal a small subset.

Recommended constraints:

```text
max children per expansion: 2–4
max visible frontier per branch: 3–6
```

Avoid exponential explosion.

---

# 15. Next-Step Recommendation

After grading, Codex may recommend:

### Continue

Current node needs another challenge.

### Deepen

Unlock a more advanced child.

### Repair

Study missing prerequisite.

### Branch

Move to an adjacent concept.

The user remains free to choose any unlocked node.

Recommendations must not force a linear course.

---

# 16. Gamification

## 16.1 Core game systems

Only four systems are mandatory:

### Skill Tree

Visual map of knowledge.

### Unlocking

Clearing nodes reveals new territory.

### XP

A simple progress indicator.

### Mastery State

Cleared / mastered distinction.

---

## 16.2 Primary reward

The strongest reward is visual expansion.

When a challenge is cleared:

1. node animates,
2. connecting edges illuminate,
3. hidden branches materialize,
4. newly discovered concepts appear.

The player should feel that their understanding physically expanded the map.

---

## 16.3 Optional later systems

Only after core-loop validation:

- achievements,
- boss nodes,
- milestone summaries,
- learning stats,
- session recap,
- optional challenge chains.

Do not include in MVP:

- streaks,
- hearts,
- energy,
- loot,
- currencies,
- shops,
- PvP,
- leaderboards.

---

# 17. Boss Nodes

Optional advanced concept.

A Boss Node represents a synthesis challenge requiring multiple prerequisite nodes.

Example:

```text
Transformer Block — Boss

Explain the complete data flow through a pre-norm decoder Transformer block,
including attention, residual paths, MLP, normalization, and causal masking.
```

Boss nodes:

- have multiple prerequisites,
- award more XP,
- unlock major new regions.

Useful, but not required for v0.1.

---

# 18. Visual Direction

## 18.1 Aesthetic

Target mood:

- dark knowledge-map interface,
- restrained sci-fi / arcane research aesthetic,
- not cartoon education software,
- not corporate LMS,
- not excessive fantasy RPG ornament.

Possible references in spirit:

- technology tree,
- constellation map,
- neural network graph,
- research map,
- dungeon progression.

---

## 18.2 Core visual hierarchy

Node states should be immediately recognizable.

Suggested states:

```text
Hidden      invisible / fogged
Discovered  faint silhouette
Unlocked    bright outline
In Progress pulsing / partial ring
Cleared     solid illuminated
Mastered    enhanced halo / emblem
```

Color should not be the only differentiator for accessibility.

Use:

- shape,
- glow intensity,
- icon,
- border style,
- state label.

---

# 19. Required Image / Visual Assets

Prefer SVG / procedural UI over large raster assets.

## 19.1 Mandatory

### App logo

`challenge-tree-logo.svg`

Concept:
- branching tree + node network,
- simple enough for favicon.

### Favicon

`favicon.svg`

### Node state icons

- locked
- unlocked
- cleared
- mastered
- current challenge

### Resource type icons

- paper
- official docs
- university
- article
- video
- book / textbook
- documentation

### Connector state icons

- connected
- disconnected
- authenticating
- running

---

## 19.2 Optional

### Background texture

Subtle grid / constellation / dark fog.

Prefer CSS/SVG generation rather than image file.

### Major milestone badge

A small set of generic milestone emblems.

Do not require per-subject generated art.

---

## 19.3 Explicitly avoid

- character illustrations,
- per-node AI-generated art,
- complex fantasy item assets,
- animated avatars,
- large decorative image packs.

These add cost and visual noise without strengthening the core loop.

---

# 20. Main Screens

## 20.1 Start

```text
Challenge Tree

[ New Learning Tree ]

Continue
- Transformer
- Emergency Medicine
- Music Theory

[ Import Save ]

Codex ● Connected
```

---

## 20.2 New Tree

```text
What do you want to learn?

[_______________________________]

What do you want to be able to understand or explain?

[_______________________________]

Research:
(●) Japanese
( ) Global

[ Research & Generate Trees ]
```

---

## 20.3 Proposal Selection

Three cards.

Each shows:

- structure,
- focus,
- top branches,
- advantages,
- tradeoffs.

Action:

`Choose this tree`

---

## 20.4 Tree View

Main screen.

Contains:

- graph canvas,
- project title,
- XP / level,
- current node,
- search,
- progress summary,
- connector status.

Clicking a node opens Node Panel.

---

## 20.5 Node Panel

Sections:

### Goal

What the learner should be able to explain.

### Resource Guide

Exact relevant sources and sections.

### Challenge

Current prompt.

### Answer Box

Free-form text.

### Submit

Sends answer to Codex.

---

## 20.6 Grade Result

Shows:

- grade,
- feedback,
- correct,
- missing,
- misconception,
- next recommendation,
- XP animation,
- newly unlocked nodes.

Actions:

- Retry
- Next recommended
- Return to tree

---

# 21. Save System

## 21.1 Primary storage

Browser IndexedDB.

No server account required.

---

## 21.2 Export

Every project can be exported as:

```text
<project-name>.challenge-tree.json
```

MIME:

```text
application/json
```

A future custom extension may be:

```text
.challenge-tree
```

but v0.1 should remain plain JSON for transparency.

---

## 21.3 Import

Import must:

1. validate schema,
2. validate format version,
3. migrate if supported,
4. reject malformed / future incompatible data safely,
5. never execute arbitrary content.

---

# 22. Canonical Save Schema

Top-level draft:

```json
{
  "formatVersion": 1,
  "appVersion": "0.1.0",
  "project": {},
  "tree": {},
  "challenges": [],
  "attempts": [],
  "resources": [],
  "research": {},
  "settings": {},
  "stats": {}
}
```

---

# 23. Project Schema

```json
{
  "id": "uuid",
  "title": "Transformer",
  "topic": "Transformer",
  "goal": "...",
  "researchMode": "global",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

---

# 24. Node Schema

```json
{
  "id": "attention",
  "title": "Attention",
  "description": "Understand the core attention mechanism.",
  "goal": "Explain what attention computes and why it is useful.",

  "status": "unlocked",

  "xp": 90,
  "masteryState": "developing",

  "prerequisites": ["linear-algebra-basics"],
  "children": ["qkv", "scaled-dot-product", "masking"],

  "resourceIds": ["res_001", "res_002"],
  "challengeIds": ["ch_001"],

  "position": {
    "x": 420,
    "y": 180
  },

  "createdAt": "...",
  "updatedAt": "..."
}
```

Allowed status:

```text
hidden
discovered
unlocked
in_progress
cleared
mastered
```

---

# 25. Resource Schema

```json
{
  "id": "res_001",

  "title": "Attention Is All You Need",
  "url": "https://...",

  "language": "en",

  "type": "primary_paper",

  "authorityTier": "A",

  "locator": {
    "kind": "section",
    "value": "3.2.1"
  },

  "guidance": "Focus on the paragraph explaining scaling by sqrt(d_k).",

  "supports": [
    "scaled-dot-product"
  ],

  "verifiedAt": "..."
}
```

Possible resource types:

```text
primary_paper
official_docs
government
university
textbook
course
technical_docs
article
video
community
other
```

---

# 26. Challenge Schema

```json
{
  "id": "ch_001",

  "nodeId": "scaled-dot-product",

  "promptStyle": "why",

  "difficulty": 2,

  "prompt": "Explain why scaled dot-product attention divides by sqrt(d_k).",

  "expectedConcepts": [
    "dot product variance grows with dimension",
    "large logits saturate softmax",
    "saturated softmax produces small gradients"
  ],

  "modelAnswer": "...",

  "rubric": [
    {
      "criterion": "dimension and variance",
      "required": true
    },
    {
      "criterion": "softmax saturation",
      "required": true
    },
    {
      "criterion": "gradient consequence",
      "required": false
    }
  ],

  "commonMisconceptions": [
    "Scaling is primarily for numerical overflow prevention."
  ],

  "resourceIds": [
    "res_001"
  ],

  "createdAt": "..."
}
```

---

# 27. Attempt Schema

```json
{
  "id": "attempt_001",

  "challengeId": "ch_001",
  "nodeId": "scaled-dot-product",

  "answer": "...",

  "grade": 2,

  "feedback": {
    "summary": "...",

    "correct": [
      "..."
    ],

    "missing": [
      "..."
    ],

    "misconceptions": [
      "..."
    ],

    "nuance": [
      "..."
    ],

    "nextStep": "..."
  },

  "xpAwarded": 50,

  "createdAt": "..."
}
```

---

# 28. Tree Schema

```json
{
  "rootNodeId": "transformer",

  "nodes": {
    "transformer": {},
    "attention": {}
  },

  "edges": [
    {
      "from": "transformer",
      "to": "attention",
      "type": "dependency"
    }
  ]
}
```

Edge types:

```text
dependency
recommended
related
```

Only `dependency` affects unlocking.

---

# 29. Research Record Schema

Store enough provenance to avoid losing why a node/resource exists.

```json
{
  "id": "research_001",

  "query": "...",

  "mode": "global",

  "createdAt": "...",

  "summary": "...",

  "resourceIds": [
    "res_001",
    "res_002"
  ],

  "generatedNodeIds": [
    "attention"
  ]
}
```

Raw hidden chain-of-thought must never be stored.

Only concise research outputs / provenance.

---

# 30. Codex Operations

The application should expose a very small internal AI contract.

Initial operations:

```text
TREE_PROPOSE
NODE_EXPAND
CHALLENGE_CREATE
ANSWER_GRADE
```

Optional:

```text
TREE_REPAIR
RESOURCE_REFRESH
```

---

# 31. TREE_PROPOSE

Input:

```json
{
  "topic": "...",
  "goal": "...",
  "researchMode": "global",
  "priorKnowledge": "auto"
}
```

Codex:

1. performs web research,
2. identifies domain structure,
3. returns three distinct proposals.

Output:

```json
{
  "proposals": [
    {
      "id": "A",
      "title": "...",
      "philosophy": "...",
      "tradeoffs": "...",
      "root": {},
      "initialNodes": [],
      "initialEdges": []
    }
  ]
}
```

---

# 32. NODE_EXPAND

Input:

- current node,
- nearby tree context,
- user goal,
- mastery state,
- research mode,
- existing resources.

Codex:

1. determines useful children,
2. researches if necessary,
3. creates resources,
4. creates challenges,
5. returns bounded expansion.

Hard limits:

```text
new child nodes <= 4
new resources <= 8
new challenges per node <= 3
```

---

# 33. CHALLENGE_CREATE

Input:

- node,
- mastery,
- past attempts,
- sources.

Output:

- one challenge,
- hidden answer,
- rubric,
- misconception list.

Avoid repeating essentially identical prompts unless intentionally retrying.

---

# 34. ANSWER_GRADE

Input:

- challenge,
- rubric,
- source context,
- user answer,
- recent attempts.

Output:

```json
{
  "grade": 0,
  "summary": "...",
  "correct": [],
  "missing": [],
  "misconceptions": [],
  "nuance": [],
  "recommendedAction": "retry|deepen|repair|branch",
  "recommendedNodeIds": []
}
```

---

# 35. Luna Optimization Rules

Challenge Tree assumes a lightweight Codex model.

Therefore:

## Do

- use strict structured output,
- keep local context small,
- provide only nearby nodes,
- provide source extracts / summaries relevant to the current task,
- use fixed schemas,
- use deterministic app-side progression logic,
- bound research and expansion.

## Do not

- send entire project history every turn,
- regenerate entire trees,
- ask Codex to calculate XP,
- ask Codex to manage save state,
- ask Codex to decide UI behavior,
- use free-form agent loops for simple grading.

The model provides intelligence.

The application owns state and rules.

---

# 36. Architecture

```text
┌──────────────────────────────────────┐
│ Challenge Tree Web                  │
│ GitHub Pages / PWA                  │
│                                      │
│ React + TypeScript                  │
│                                      │
│ Skill Tree UI                       │
│ Challenge UI                        │
│ Progress logic                      │
│ IndexedDB                           │
│ JSON import/export                  │
│ Optional WASM core                  │
└──────────────────┬───────────────────┘
                   │ localhost
                   │ HTTP + SSE
                   ▼
┌──────────────────────────────────────┐
│ ChallengeTreeConnector              │
│ portable native executable          │
│                                      │
│ Origin validation                   │
│ session authorization               │
│ HTTP/SSE ↔ App Server bridge        │
│ process lifecycle                   │
└──────────────────┬───────────────────┘
                   │ stdio JSON-RPC
                   ▼
┌──────────────────────────────────────┐
│ Codex App Server                    │
│ User's own authentication/session   │
│ GPT-5.6 Luna                        │
└──────────────────────────────────────┘
```

---

# 37. Web Application

Recommended stack:

- Vite
- React
- TypeScript
- React Flow or equivalent graph library
- Dexie / IndexedDB
- Zod or JSON Schema validation
- optional Rust/WASM core

GitHub Pages hosts only static assets.

---

# 38. WASM Role

WASM is optional.

Good uses:

- graph validation,
- dependency calculations,
- unlock rules,
- save migration,
- schema validation,
- layout preprocessing,
- local search/indexing.

Do not attempt to port Codex App Server into WASM for the initial product.

---

# 39. Connector

Target UX:

```text
1. Open Challenge Tree website
2. Website detects connector
3. If absent:
   [Download Connector]
4. User starts portable executable
5. Connector starts / discovers Codex App Server
6. User authenticates using Codex flow if needed
7. Website shows:
   ● Codex Connected
```

No installer is required.

The connector should be as stateless as possible.

---

# 40. Connector Responsibilities

Only:

1. launch or connect to Codex App Server,
2. translate browser requests to App Server protocol,
3. stream events back,
4. handle authentication state,
5. enforce security boundaries,
6. shut down cleanly.

Do not place Challenge Tree business logic inside the connector.

---

# 41. Browser ↔ Connector API

Example:

```text
GET /v1/status
POST /v1/jobs
GET /v1/jobs/{id}/events
POST /v1/jobs/{id}/cancel
```

Potential job actions:

```text
tree_propose
node_expand
challenge_create
answer_grade
```

Streaming:

- SSE preferred for simplicity.
- WebSocket may be added later.

---

# 42. Connector Security

Critical.

The connector must not expose unrestricted Codex access to arbitrary web pages.

Required protections:

## Origin allowlist

Production default:

```text
https://kokuren333.github.io
```

Development origins explicitly configurable.

## Session token

Connector creates a random ephemeral session token.

Browser must present it on privileged requests.

## Minimal API

Do not expose arbitrary:

```text
run shell
write arbitrary file
execute arbitrary tool
```

unless Challenge Tree genuinely needs them.

The browser should request high-level Challenge Tree operations, not raw arbitrary Codex commands.

## Localhost only

Bind only to:

```text
127.0.0.1
::1
```

Never `0.0.0.0` by default.

---

# 43. Authentication

Challenge Tree itself should not store:

- OpenAI credentials,
- ChatGPT cookies,
- API keys.

Authentication belongs to Codex / App Server through the local connector.

The web app should only receive status such as:

```json
{
  "connected": true,
  "authenticated": true,
  "model": "gpt-5.6-luna"
}
```

---

# 44. Offline Behavior

Without connector:

Available:

- browse existing trees,
- inspect resources,
- read past feedback,
- view progress,
- export/import,
- answer locally without submission,
- edit local project metadata.

Unavailable:

- web research,
- tree generation,
- dynamic node expansion,
- AI challenge creation,
- AI grading.

---

# 45. Web Research Behavior

Research should be purposeful.

Do not:

> research everything about topic X.

Instead:

> find enough authoritative information to define and evaluate node Y.

This keeps cost manageable.

Research should occur:

- initial tree proposal,
- first expansion into a new area,
- resource refresh,
- when grading needs verification of uncertain claims.

---

# 46. Citation / Provenance UX

Every resource should remain clickable.

Feedback may reference:

```text
Based on:
- Resource A §3.2.1
- Resource B "KV cache" section
```

Do not pretend generated model answers are independent authority.

For high-stakes domains, present sources prominently.

---

# 47. High-Stakes Domains

Challenge Tree may be used for medicine, law, finance, etc.

The system should clearly distinguish:

- learning exercises,
- real-world professional advice.

For medicine, for example:

> This project is for learning and knowledge assessment, not patient-specific clinical decision support.

Do not allow the game UI to imply professional certification.

---

# 48. Error Handling

## Resource dead link

Mark unavailable and allow refresh.

## Connector disconnected

Preserve user draft answer locally.

## Codex failure

Retry manually.

Never discard answer text.

## Invalid AI structured output

Schema validation fails → request repair once.

If still invalid → show recoverable error.

## Tree corruption

Keep automatic local snapshots.

---

# 49. Autosave

Save after:

- text answer edits,
- challenge submission,
- grading result,
- node unlock,
- tree expansion,
- settings change.

Use debounce for text input.

---

# 50. Local Backups

Maintain limited rotating snapshots in IndexedDB.

Example:

```text
latest
before-last-expansion
before-last-import
```

Not visible unless restore is needed.

---

# 51. Import Safety

Imported JSON must never:

- execute JS,
- render arbitrary HTML unsanitized,
- issue network requests automatically,
- auto-run Codex operations.

URLs are data only until clicked or explicitly researched.

---

# 52. Search

Tree-local search should support:

- node title,
- description,
- resource title,
- challenge text.

No semantic vector database required for MVP.

---

# 53. Statistics

Minimal useful stats:

- nodes cleared,
- nodes mastered,
- total challenges,
- grade distribution,
- current session XP,
- branch progress.

Avoid dashboard bloat.

---

# 54. Session Summary

Optional but valuable.

On exit or request:

```text
This session:
8 challenges
5 nodes cleared
2 misconceptions corrected

New branches discovered:
- RoPE
- KV Cache
- Context Scaling
```

No daily calendar framing.

---

# 55. Accessibility

Required:

- keyboard navigation,
- screen-reader labels,
- node states not color-only,
- scalable typography,
- reduced-motion option,
- high-contrast-friendly design.

---

# 56. Responsive Design

Desktop is primary.

Tablet usable.

Mobile should support:

- answering challenges,
- inspecting nodes,
- resource reading,
- simplified tree navigation.

Do not optimize complex graph editing for small screens initially.

---

# 57. Performance

Initial desired limits:

- 500 nodes per project without severe degradation,
- lazy render distant tree areas,
- avoid storing huge webpage contents,
- store structured research summaries rather than full scraped pages.

---

# 58. Privacy

Default:

- saves remain local,
- user answers remain local except when intentionally sent to Codex for grading,
- no analytics required for core product.

If analytics are later introduced, make them transparent and minimal.

---

# 59. Repository Structure

Suggested monorepo:

```text
challenge-tree/
├─ apps/
│  └─ web/
│
├─ crates/
│  ├─ connector/
│  └─ core/
│
├─ packages/
│  ├─ schemas/
│  ├─ ai-contract/
│  └─ ui/
│
├─ specs/
│  ├─ schemas/
│  └─ prompts/
│
├─ public/
│  └─ assets/
│
├─ SPEC.md
└─ README.md
```

Alternative: keep connector separate if release tooling becomes easier.

---

# 60. Schema Files

Canonical machine-readable schemas:

```text
schemas/
├─ challenge-tree.schema.json
├─ project.schema.json
├─ tree.schema.json
├─ node.schema.json
├─ resource.schema.json
├─ challenge.schema.json
├─ attempt.schema.json
├─ grade.schema.json
└─ ai-operation.schema.json
```

JSON Schema Draft 2020-12 recommended.

---

# 61. Versioning

Use separate versions:

```text
appVersion
formatVersion
schemaVersion
connectorProtocolVersion
```

Never tie save compatibility directly to app semantic version.

---

# 62. Save Migration

Example:

```text
formatVersion 1 → 2
```

Migration must be deterministic and local.

Always preserve an automatic pre-migration backup.

---

# 63. Prompt / Skill Packaging

Codex behavior should be defined by small reusable instructions.

Suggested files:

```text
ai/
├─ system.md
├─ source-policy.md
├─ tree-propose.md
├─ node-expand.md
├─ challenge-create.md
└─ answer-grade.md
```

Avoid one giant prompt.

---

# 64. AI System Principles

Codex should be instructed to:

1. prioritize accuracy over impressive breadth,
2. use web research when factual grounding is needed,
3. distinguish established facts from interpretation,
4. prefer good existing teaching resources,
5. generate concise challenge material,
6. detect misconceptions explicitly,
7. avoid unnecessary tree expansion,
8. respect user's research language mode,
9. return schema-valid output.

---

# 65. AI Must Not

- invent URLs,
- fabricate citations,
- generate huge textbooks,
- award XP,
- modify state directly,
- silently rewrite earlier user progress,
- infer professional competence from game progress,
- expose private chain-of-thought.

---

# 66. Tree Quality Heuristics

A good tree should:

- have meaningful prerequisites,
- avoid redundant sibling nodes,
- separate foundational vs advanced concepts,
- keep branch depth understandable,
- allow multiple paths,
- align to user's stated goal.

A bad tree looks like an encyclopedia category list.

---

# 67. Node Quality Heuristics

A node should satisfy:

```text
Can one reasonably ask:
"Can the learner explain this?"
```

If not, split or merge the node.

---

# 68. Challenge Quality Heuristics

A challenge should:

- test understanding rather than trivia,
- be answerable from listed resources,
- have identifiable expected concepts,
- allow grading without arbitrary stylistic judgment,
- target the current node,
- avoid leaking the model answer.

---

# 69. Research Modes Contract

Enum:

```text
ja
global
```

### ja

Japanese-first discovery.

### global

No language restriction for sources.

Output UI language remains a separate setting.

Future:

```text
sourceLanguageMode
uiLanguage
```

must remain distinct concepts.

---

# 70. Difficulty

Keep simple.

```text
1 foundational
2 standard
3 advanced
4 synthesis
```

Difficulty affects prompt depth, not arbitrary enemy HP.

---

# 71. Recommendation Logic

App-side rule + AI suggestion.

Example:

```text
If grade <= 1:
  favor retry / prerequisite

If grade == 2:
  allow retry or child

If grade == 3:
  favor unlock / deepen
```

AI may recommend, but application enforces state transitions.

---

# 72. Unlock Logic

Default:

A node unlocks when all required prerequisites are `cleared`.

Optional future rules:

- any N of prerequisites,
- boss prerequisite,
- manual unlock.

MVP uses all-required only.

---

# 73. Tree Editing

MVP:

No full manual graph editor.

Allow:

- rename project,
- hide/archive unwanted node,
- ask Codex to repair branch.

Later:

- manual node creation,
- manual edge editing.

Avoid turning product into graph-authoring software.

---

# 74. Reset / Replay

A user may:

- retry challenges,
- reset node progress,
- duplicate project.

Do not destroy historical attempts unless explicitly requested.

---

# 75. Project Duplication

Useful for experimenting with alternate learning paths.

```text
Duplicate Project
→ new project ID
→ copy current state
```

---

# 76. Multi-Tree Strategy

Each learning subject is an independent project.

Do not create one global mega-tree in MVP.

This avoids schema complexity and cross-domain dependencies.

---

# 77. Global Library

Future optional feature:

A local list of all projects.

No universal cross-project skill ontology initially.

---

# 78. Sharing

Initial sharing mechanism:

```text
Export .challenge-tree.json
```

Anyone can import it.

This enables community-created starter trees without building a server.

Future:

- static downloadable tree packs,
- GitHub-hosted templates.

---

# 79. Template Trees

Potential later feature:

A repository can host curated starter tree JSON files.

Example:

```text
templates/
├─ transformer-basics.json
├─ linux-kernel-basics.json
└─ jazz-theory.json
```

On import, Codex can refresh stale resource links.

---

# 80. Community Potential

The strongest future network effect is not social feeds.

It is:

> People sharing good tree structures and challenge packs.

The product can remain local-first while enabling a GitHub ecosystem.

---

# 81. Minimal Viable Product

## v0.1

Must include:

1. GitHub Pages web app
2. Portable connector
3. Codex connection status
4. New project
5. Japanese / Global mode
6. TREE_PROPOSE
7. Three proposal selection UI
8. Tree visualization
9. Node detail panel
10. Resource guide
11. One active challenge per node
12. Free-text answer
13. ANSWER_GRADE
14. XP
15. clear/unlock transitions
16. NODE_EXPAND
17. IndexedDB save
18. JSON export/import
19. schema validation
20. basic connector security

Nothing else is required to validate the concept.

---

# 82. v0.2

Candidate additions:

- retry-aware challenge generation,
- boss nodes,
- research refresh,
- session summary,
- tree search,
- project duplication,
- local snapshots,
- improved visualization.

---

# 83. v1.0

A reasonable v1.0 definition:

- stable save format,
- Windows/macOS/Linux connector,
- robust Codex authentication flow,
- polished tree UX,
- high-quality resource provenance,
- adaptive branch repair,
- reliable import/export,
- strong schema migrations,
- PWA support,
- accessibility baseline,
- starter template ecosystem.

---

# 84. Explicit Non-Goals Before v1.0

- cloud sync,
- Challenge Tree user accounts,
- subscription billing,
- multiplayer,
- leaderboards,
- social feed,
- mobile native apps,
- teacher dashboards,
- generated video courses,
- vector RAG database,
- arbitrary code execution challenges,
- full flashcard system.

---

# 85. Success Metrics

The primary metric should reflect the core fantasy.

Best qualitative question:

> **"After clearing a node, did you want to open another one?"**

Possible quantitative proxies:

- challenges per session,
- nodes cleared per session,
- median session depth,
- percentage of sessions with multiple branch unlocks,
- project return rate,
- percentage of generated resources actually opened.

Avoid optimizing for daily streak.

---

# 86. Core Product Risks

## R1. AI-generated trees are shallow or arbitrary

Mitigation:
- require web research,
- three proposal choices,
- bounded expansion,
- branch repair.

## R2. Resources are poor

Mitigation:
- source quality policy,
- exact-section guidance,
- provenance,
- refresh action.

## R3. Grading is too generous

Mitigation:
- fixed rubric,
- expected concepts,
- misconception checks,
- coarse grading.

## R4. Tree becomes huge

Mitigation:
- lazy expansion,
- branch caps,
- local context only.

## R5. Luna struggles with complex tasks

Mitigation:
- narrow operation contracts,
- structured schemas,
- research and grading separated,
- state logic outside model.

## R6. Connector UX kills adoption

Mitigation:
- single portable executable,
- no Node/Python setup,
- auto-detect Codex,
- clear one-click status page.

---

# 87. Final Product Definition

Challenge Tree should be describable in one sentence:

> **A local-first learning game where solving AI-generated explanation challenges unlocks a research-grounded skill tree.**

And in one interaction loop:

```text
Research
→ Challenge
→ Explain
→ Grade
→ Unlock
→ Explore
```

If a proposed feature does not strengthen this loop, it should probably not be added.

---

# 88. Implementation North Star

The product is successful when:

- the AI does not feel like a chatbot,
- the learner does not feel like they are filling out homework,
- external resources feel curated rather than dumped,
- the skill tree feels alive but not chaotic,
- progression feels earned,
- each cleared node naturally creates curiosity about the next one.

The correct product feeling is:

> **"I came here to learn one thing and accidentally explored an entire branch."**
