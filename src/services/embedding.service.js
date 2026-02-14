import { openai } from '../config/openai.js';

const EMBEDDING_MODEL = 'text-embedding-3-small';

export async function getTextEmbedding(text) {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });

  const embedding = response.data[0].embedding;
  const dims = embedding.length;

  return { embedding, dims };
}
