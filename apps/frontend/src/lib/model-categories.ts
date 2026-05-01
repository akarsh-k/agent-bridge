/**
 * Coarse model-family categorization used by the LLM provider page +
 * the agent model picker. Only OpenAI gets a meaningful family map —
 * for local providers (llama_cpp / ollama / openai_compatible) we
 * don't introspect names because the user picks model ids
 * arbitrarily.
 *
 * Two predicates hang off the categorizer:
 *   - `isChatCapable`   — safe to call via /v1/chat/completions
 *   - `isEmbeddingCapable` — safe to call via /v1/embeddings
 *
 * For local providers both predicates return `true` so we don't
 * pre-filter anything on those.
 */

import type { LlmProviderKind } from '@agent-bridge/shared'

/**
 * Bucket an OpenAI model id into a coarse family. Heuristic-only —
 * keeps the catalog scannable without us having to maintain an
 * exhaustive registry. Order matters: more-specific patterns must
 * check first (e.g. `gpt-4o-realtime-preview` matches both
 * `realtime` and `gpt-4` — we want it bucketed as Realtime).
 */
export function categorizeOpenAIModel(model: string): string {
  if (model.includes('moderation')) return 'Moderation'
  if (model.includes('realtime')) return 'Realtime'
  if (model.startsWith('whisper')) return 'Audio transcription'
  if (model.startsWith('tts-')) return 'Audio synthesis'
  if (model.startsWith('dall-e') || model.startsWith('gpt-image')) {
    return 'Image generation'
  }
  if (model.includes('embedding')) return 'Embeddings'
  if (model === 'babbage-002' || model === 'davinci-002') {
    return 'Legacy completions'
  }
  if (model.startsWith('gpt-4') || model.startsWith('chatgpt-')) {
    return 'GPT-4 family'
  }
  if (model.startsWith('gpt-3.5')) return 'GPT-3.5 family'
  if (/^o\d/.test(model)) return 'Reasoning (o-series)'
  return 'Other'
}

/** Categories that DON'T speak /v1/chat/completions. */
export const NON_CHAT_CATEGORIES = new Set([
  'Image generation',
  'Audio transcription',
  'Audio synthesis',
  'Moderation',
  'Realtime',
  'Legacy completions',
  'Embeddings',
])

/** Categories that DO speak /v1/embeddings. */
export const EMBEDDING_CATEGORIES = new Set(['Embeddings'])

/**
 * True if `model` looks chat-capable for `providerKind`. Local
 * providers always return `true` because their model ids are
 * arbitrary — we don't second-guess them.
 */
export function isChatCapable(
  model: string,
  providerKind: LlmProviderKind,
): boolean {
  if (providerKind !== 'openai') return true
  return !NON_CHAT_CATEGORIES.has(categorizeOpenAIModel(model))
}

/**
 * True if `model` looks embedding-capable for `providerKind`. Same
 * "no filtering on local" rule as `isChatCapable`.
 */
export function isEmbeddingCapable(
  model: string,
  providerKind: LlmProviderKind,
): boolean {
  if (providerKind !== 'openai') return true
  return EMBEDDING_CATEGORIES.has(categorizeOpenAIModel(model))
}
