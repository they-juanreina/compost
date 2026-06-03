import type { ProviderConfig } from '../types.js'
import { OpenAICompatibleProvider } from './openai_compatible.js'

/** OpenAI cloud (default https://api.openai.com/v1). Requires an API key. */
export class OpenAIProvider extends OpenAICompatibleProvider {
  constructor(config: ProviderConfig) {
    super('openai', config)
  }
}
