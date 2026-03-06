import { openai } from '../config/openai.js';
import { env } from '../config/env.js';

const EMBEDDING_MODEL = env.EMBEDDING_MODEL;
const EMBEDDING_DIMENSIONS = Number.isFinite(env.EMBEDDING_DIMENSIONS)
  ? env.EMBEDDING_DIMENSIONS
  : undefined;

export async function getTextEmbedding(text) {
  const options = {
    model: EMBEDDING_MODEL,
    input: text,
  };

  if (EMBEDDING_DIMENSIONS && Number.isFinite(EMBEDDING_DIMENSIONS)) {
    options.dimensions = EMBEDDING_DIMENSIONS;
  }

  const response = await openai.embeddings.create(options);

  const embedding = response.data[0].embedding;
  const dims = embedding.length;

  return { embedding, dims };
}
