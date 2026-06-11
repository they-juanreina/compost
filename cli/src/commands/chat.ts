import type { Answer, Chunk } from '@they-juanreina/compost-retrieval'
import type { Command } from 'commander'

import { isCompostError } from '../errors.js'
import { ANSWER_JSON_SCHEMA } from '../lib/answerSchema.js'
import { chat } from '../lib/chat.js'
import { loadConfig } from '../lib/config.js'
import { resolveSeedPath, seedNameOf } from '../lib/seedResolve.js'
import { LLMAdapter } from '../llm/adapter.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface ChatFlags {
  seed?: string
  chatId?: string
  task?: string
}

/** Parse a model's answer JSON, tolerating a ```json fence (some local models
 * emit one despite the schema). Unparseable output → insufficient evidence
 * rather than a crash — important now that chat defaults to a local model. */
export function parseAnswer(text: string): Answer {
  const trimmed = text.trim()
  // Local models vary: bare JSON, a ```json fence, or JSON wrapped in prose.
  // Try each strategy; the last extracts the outermost {...} object.
  const candidates = [
    trimmed,
    trimmed
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim(),
    trimmed.match(/\{[\s\S]*\}/)?.[0] ?? '',
  ]
  for (const c of candidates) {
    if (!c) continue
    try {
      const v: unknown = JSON.parse(c)
      // Require an object — a bare primitive (e.g. `null`, `42`) is not an Answer.
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) return v as Answer
    } catch {
      // try the next strategy
    }
  }
  return {
    answer: 'The model returned an answer that could not be parsed.',
    claims: [],
    insufficient_evidence: true,
  }
}

export function registerChat(program: Command): void {
  program
    .command('chat')
    .description('RAG-grounded chat with the seed — answers carry citations')
    .argument('<question>', 'The question to ask the seed')
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .option('--chat-id <id>', 'Conversation id for persistence', 'default')
    .option(
      '--task <name>',
      "LLM task to answer with — local by default; use 'synthesis' for cloud quality (needs an API key)",
      'quick_chat',
    )
    .addHelpText(
      'after',
      '\nExamples:\n  $ compost chat "what did participants say about pricing?"\n  $ compost chat "summarize the onboarding pain points" --task synthesis',
    )
    .action(async (question: string, flags: ChatFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const seedName = seedNameOf(seedPath)
        const config = loadConfig(seedPath)
        const adapter = new LLMAdapter(config)

        const answerFn = async (q: string, context: Chunk[]): Promise<Answer> => {
          const contextText = context
            .map((c) => `[${c.metadata.session}:${c.id}] ${c.text}`)
            .join('\n')
          const messages = [
            {
              role: 'system' as const,
              content:
                'Answer ONLY from the provided context. Every claim must cite a real utterance_id with a verbatim quote. If the context is insufficient, set insufficient_evidence=true. Respond as JSON matching the answer schema.',
            },
            { role: 'user' as const, content: `Context:\n${contextText}\n\nQuestion: ${q}` },
          ]
          // Local task by default (no API key); override with --task synthesis.
          const resp = await adapter.chat(flags.task ?? 'quick_chat', messages, {
            schema: ANSWER_JSON_SCHEMA,
          })
          return parseAnswer(resp.text)
        }

        const result = await chat(seedPath, question, {
          answerFn,
          seed: seedName,
          ...(flags.chatId !== undefined ? { chatId: flags.chatId } : {}),
        })

        if (out.human) {
          process.stdout.write(`${result.answer || '(no answer — insufficient evidence)'}\n`)
          for (const c of result.citations) {
            process.stdout.write(`  — ${c.utterance_id}: "${c.quote}" (${c.confidence})\n`)
          }
        } else {
          emit(
            { answer: result.answer, citations: result.citations, retrieved: result.retrieved },
            out,
          )
        }
        // Insufficient evidence is never returned silently.
        if (result.insufficient_evidence) process.exit(3)
      } catch (err) {
        if (isCompostError(err)) emitError(err, out)
        throw err
      }
    })
}
