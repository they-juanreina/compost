import type { Command } from 'commander'

import type { Answer, Chunk } from 'compost-retrieval'

import { isCompostError } from '../errors.js'
import { ANSWER_JSON_SCHEMA } from '../lib/answerSchema.js'
import { chat } from '../lib/chat.js'
import { loadConfig } from '../lib/config.js'
import { resolveSeedPath } from '../lib/seedResolve.js'
import { LLMAdapter } from '../llm/adapter.js'
import { emit, emitError, getOutputOpts } from '../output.js'

interface ChatFlags {
  seed?: string
  chatId?: string
}

export function registerChat(program: Command): void {
  program
    .command('chat')
    .description('RAG-grounded chat with the seed — answers carry citations')
    .argument('<question>', 'The question to ask the seed')
    .option('--seed <name>', 'Seed (default: the only seed under ./Seeds)')
    .option('--chat-id <id>', 'Conversation id for persistence', 'default')
    .action(async (question: string, flags: ChatFlags, cmd: Command) => {
      const out = getOutputOpts(cmd)
      try {
        const seedPath = resolveSeedPath(process.cwd(), flags.seed)
        const seedName = seedPath.split('/').pop() ?? 'seed'
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
          const resp = await adapter.chat('synthesis', messages, { schema: ANSWER_JSON_SCHEMA })
          return JSON.parse(resp.text) as Answer
        }

        const result = await chat(seedPath, question, {
          answerFn,
          seed: seedName,
          ...(flags.chatId !== undefined ? { chatId: flags.chatId } : {}),
        })

        if (out.human) {
          process.stdout.write(`${result.answer}\n`)
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
