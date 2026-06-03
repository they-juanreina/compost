import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import {
  type Answer,
  BM25Index,
  type Chunk,
  type ChunkerTranscript,
  chunkTranscript,
  type EvidenceSet,
  HybridRetriever,
  validateAnswer,
} from 'compost-retrieval'

export interface ChatCitation {
  utterance_id: string
  quote: string
  confidence: number
}

export interface ChatResult {
  answer: string
  citations: ChatCitation[]
  insufficient_evidence: boolean
  retrieved: number
}

/** Generates a candidate Answer from the question + retrieved context. The
 * command wires this to the LLM adapter; tests inject a fake. */
export type AnswerFn = (question: string, context: Chunk[]) => Promise<Answer>

export interface ChatDeps {
  answerFn: AnswerFn
  seed: string
  topK?: number
  now?: () => Date
  chatId?: string
}

/** Build an evidence set (utterance_id → {session_id, text}) from a seed's
 * session transcripts, used both to retrieve and to validate citations. */
function loadSeedUtterances(seedPath: string): {
  chunks: Chunk[]
  evidence: EvidenceSet
  seedName: string
} {
  const seedName = seedPath.split('/').pop() ?? 'seed'
  const sessionsDir = join(seedPath, 'sessions')
  const evidence: EvidenceSet = new Map()
  const allChunks: Chunk[] = []
  if (!existsSync(sessionsDir)) return { chunks: [], evidence, seedName }

  for (const entry of readdirSync(sessionsDir)) {
    if (entry.startsWith('.') || entry === '_inbox') continue
    const tPath = join(sessionsDir, entry, 'transcript.json')
    if (!existsSync(tPath) || !statSync(tPath).isFile()) continue
    const transcript = JSON.parse(readFileSync(tPath, 'utf8')) as ChunkerTranscript & {
      utterances: Array<{ id: string; text: string }>
    }
    for (const u of transcript.utterances) {
      evidence.set(u.id, { session_id: transcript.session_id, text: u.text })
    }
    allChunks.push(...chunkTranscript(transcript, { seed: seedName }))
  }
  return { chunks: allChunks, evidence, seedName }
}

export async function chat(
  seedPath: string,
  question: string,
  deps: ChatDeps,
): Promise<ChatResult> {
  const result = await answerQuestion(seedPath, question, deps)
  // Every turn is persisted — a conversation happened even when the answer was
  // "insufficient evidence".
  persistTurn(seedPath, deps, question, result)
  return result
}

async function answerQuestion(
  seedPath: string,
  question: string,
  deps: ChatDeps,
): Promise<ChatResult> {
  const { chunks, evidence } = loadSeedUtterances(seedPath)
  if (chunks.length === 0) return insufficient('No indexed sessions in this seed yet.', 0)

  const bm25 = new BM25Index()
  bm25.addAll(chunks)
  const retriever = new HybridRetriever(bm25)
  const retrieved = await retriever.retrieve(question, { topK: deps.topK ?? 8 })
  if (retrieved.length === 0) return insufficient('Nothing in the corpus matched the question.', 0)

  const raw = await deps.answerFn(question, retrieved)
  const validation = validateAnswer(raw, evidence)
  if (validation.ok && raw.insufficient_evidence !== true) {
    return {
      answer: raw.answer,
      citations: raw.claims.map((c) => ({
        utterance_id: c.utterance_id,
        quote: c.quote,
        confidence: c.confidence,
      })),
      insufficient_evidence: false,
      retrieved: retrieved.length,
    }
  }
  return insufficient(
    raw.insufficient_evidence === true ? raw.answer : 'Answer failed citation validation.',
    retrieved.length,
  )
}

function insufficient(answer: string, retrieved: number): ChatResult {
  return { answer, citations: [], insufficient_evidence: true, retrieved }
}

function persistTurn(seedPath: string, deps: ChatDeps, question: string, result: ChatResult): void {
  const now = (deps.now ?? (() => new Date()))()
  const chatId = deps.chatId ?? 'default'
  const dir = join(seedPath, '.compost', 'chats', deps.seed)
  mkdirSync(dir, { recursive: true })
  const line = JSON.stringify({ ts: now.toISOString(), question, ...result })
  appendFileSync(join(dir, `${chatId}.jsonl`), `${line}\n`, 'utf8')
}
