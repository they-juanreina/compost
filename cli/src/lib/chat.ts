import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { type Answer, type Chunk, validateAnswer } from 'compost-retrieval'

import { buildDenseRetriever, retrieveChunks } from './retrieve.js'

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
  const dense = await buildDenseRetriever(seedPath)
  const { retrieved, corpus } = await retrieveChunks(seedPath, question, {
    topK: deps.topK ?? 8,
    dense,
  })
  if (corpus.chunks.length === 0) return insufficient('No indexed sessions in this seed yet.', 0)
  if (retrieved.length === 0) return insufficient('Nothing in the corpus matched the question.', 0)
  const evidence = corpus.evidence

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
