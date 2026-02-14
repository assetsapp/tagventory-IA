import { getDb } from '../config/mongo.js';
import { getTextEmbedding } from './embedding.service.js';

const ASSETS_COLLECTION = 'assets';
const FIELDS_FOR_EMBEDDING = ['name', 'brand', 'model', 'locationPath', 'serial', 'notes'];

function buildEmbeddingText(asset) {
  const parts = FIELDS_FOR_EMBEDDING
    .map((field) => asset[field])
    .filter((val) => val != null && String(val).trim() !== '');

  return parts.join(' ').trim();
}

export async function backfillSampleAssets(limit = 20) {
  const db = getDb();
  if (!db) throw new Error('MongoDB no conectado');

  const collection = db.collection(ASSETS_COLLECTION);

  const cursor = collection.find(
    { textEmbedding: { $exists: false } },
    { limit }
  );

  const assets = await cursor.toArray();
  let updated = 0;

  for (const asset of assets) {
    const embeddingText = buildEmbeddingText(asset);

    if (!embeddingText) {
      continue;
    }

    const { embedding } = await getTextEmbedding(embeddingText);

    await collection.updateOne(
      { _id: asset._id },
      {
        $set: {
          embeddingText,
          textEmbedding: embedding,
          embeddingVersion: 1,
          embeddingUpdatedAt: new Date(),
        },
      }
    );

    updated++;
  }

  return { updated };
}
