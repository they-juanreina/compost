import type { ProviderConfig } from '../types.js'
import { OpenAICompatibleProvider } from './openai_compatible.js'

/** LM Studio exposes an OpenAI-compatible server (default http://localhost:1234/v1). */
export class LMStudioProvider extends OpenAICompatibleProvider {
  constructor(config: ProviderConfig) {
    super('lmstudio', config)
  }
}
