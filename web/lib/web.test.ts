import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { linkCitations } from './citations.js'
import { anchorFrame } from './frameAnchor.js'
import { deleteTerm, inlineTermSpans, upsertTerm } from './glossary.js'
import { extendToWord, highlightFromSelection } from './highlight.js'
import { emptyPalette, paletteReducer } from './palette.js'
import { activeCues, activeUtterance, frameStrip } from './player.js'
import { applyDecision, badge, type Event, lineageChain } from './provenance.js'

describe('#33 player', () => {
  const cues = [{ id: 'c1', kind: 'laughter', start_ms: 1000, end_ms: 2000 }]
  it('reports cues active at the playhead', () => {
    assert.equal(activeCues(1500, cues).length, 1)
    assert.equal(activeCues(2000, cues).length, 0)
  })
  it('finds the active utterance', () => {
    const u = activeUtterance(1500, [{ id: 'U-1', start_ms: 1000, end_ms: 2000 }])
    assert.equal(u?.id, 'U-1')
  })
  it('marks the frame at/just before the playhead active', () => {
    const strip = frameStrip(2500, [
      { id: 'f1', at_ms: 1000, path: 'a' },
      { id: 'f2', at_ms: 2000, path: 'b' },
      { id: 'f3', at_ms: 3000, path: 'c' },
    ])
    assert.equal(strip.find((f) => f.active)?.id, 'f2')
  })
})

describe('#34 highlight', () => {
  const u = { id: 'U-1', text: 'no sé si confiar' }
  it('builds a clamped, normalized highlight from a selection', () => {
    assert.deepEqual(highlightFromSelection(u, 6, 0)?.span, [0, 6])
    assert.equal(highlightFromSelection(u, 0, 5)?.text, 'no sé')
  })
  it('returns null for an empty selection', () => {
    assert.equal(highlightFromSelection(u, 3, 3), null)
  })
  it('extends to the next word boundary', () => {
    assert.equal(extendToWord('no sé si', 0), 2)
  })
})

describe('#35 palette', () => {
  it('assigns + unassigns codes and groups codes on theme boards', () => {
    let s = paletteReducer(emptyPalette, { type: 'assignCode', highlightId: 'H1', codeId: 'C1' })
    s = paletteReducer(s, { type: 'assignCode', highlightId: 'H1', codeId: 'C1' }) // dedupe
    assert.deepEqual(s.codesByHighlight.H1, ['C1'])
    s = paletteReducer(s, { type: 'dropCodeOnTheme', themeId: 'T1', codeId: 'C1' })
    assert.deepEqual(s.themeBoards.T1, ['C1'])
    s = paletteReducer(s, { type: 'unassignCode', highlightId: 'H1', codeId: 'C1' })
    assert.deepEqual(s.codesByHighlight.H1, [])
  })
})

describe('#36 provenance', () => {
  it('formats badges per actor + approval', () => {
    assert.equal(badge({ actor_type: 'ai' } as Event, false), '[ai] [draft]')
    assert.equal(badge({ actor_type: 'ai' } as Event, true), '[ai] [endorsed]')
    assert.match(
      badge({ actor_type: 'agent', agent_name: 's', agent_version: '0.1' } as Event, false),
      /agent: s@0\.1/,
    )
  })
  it('orders a lineage chain root-first via parent_event', () => {
    const evs: Event[] = [
      {
        id: 'b',
        ts: '2',
        action: 'endorse',
        actor_type: 'researcher',
        actor_id: 'j',
        parent_event: 'a',
      },
      { id: 'a', ts: '1', action: 'create', actor_type: 'ai', actor_id: 'm', parent_event: null },
    ]
    assert.deepEqual(
      lineageChain(evs).map((e) => e.id),
      ['a', 'b'],
    )
  })
  it('endorse sets approved, reject clears it', () => {
    assert.equal(applyDecision(false, 'endorse'), true)
    assert.equal(applyDecision(true, 'reject'), false)
  })
})

describe('#37 citations', () => {
  it('links citations to timeline positions', () => {
    const links = linkCitations(
      [{ utterance_id: 'U-1', quote: 'q', confidence: 0.9 }],
      [{ id: 'U-1', start_ms: 5000, end_ms: 7000 }],
    )
    assert.equal(links[0]?.start_ms, 5000)
  })
  it('keeps citations whose utterance is missing (null position)', () => {
    const links = linkCitations([{ utterance_id: 'U-9', quote: 'q', confidence: 1 }], [])
    assert.equal(links[0]?.start_ms, null)
  })
})

describe('#38 glossary', () => {
  it('matches longest phrase first, non-overlapping', () => {
    const spans = inlineTermSpans('the data hub is data', [
      { term_id: 'T-data', phrase: 'data' },
      { term_id: 'T-data-hub', phrase: 'data hub' },
    ])
    assert.equal(spans[0]?.term_id, 'T-data-hub')
    assert.equal(spans.length, 2) // "data hub" + the standalone "data"
  })
  it('upserts and deletes terms', () => {
    let terms = upsertTerm([], { term_id: 'T-x', phrase: 'x' })
    terms = upsertTerm(terms, { term_id: 'T-x', phrase: 'x', definition: 'def' })
    assert.equal(terms.length, 1)
    assert.equal(terms[0]?.definition, 'def')
    assert.equal(deleteTerm(terms, 'T-x').length, 0)
  })
})

describe('#39 frameAnchor', () => {
  it('anchors to the nearest frame within the window', () => {
    const frames = [
      { id: 'f1', at_ms: 1000 },
      { id: 'f2', at_ms: 5000 },
    ]
    assert.equal(anchorFrame(4500, frames, 2000)?.id, 'f2')
  })
  it('returns null when no frame is within the window', () => {
    assert.equal(anchorFrame(20000, [{ id: 'f1', at_ms: 1000 }], 2000), null)
  })
})
