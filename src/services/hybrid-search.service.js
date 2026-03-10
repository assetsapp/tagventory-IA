import { getDb } from '../config/mongo.js';
import { getTextEmbedding } from './embedding.service.js';

const ASSETS_COLLECTION = 'assets';
const VECTOR_INDEX = 'assets_text_embedding_index';
const TEXT_INDEX = 'assets_text_search_index';

// Pesos para combinar scores (ajusta según resultados reales)
const VECTOR_WEIGHT = 0.6;
const TEXT_WEIGHT = 0.4;

/**
 * Búsqueda híbrida: Vector Search (semántico) + Atlas Search (texto).
 * Devuelve una lista unificada ordenada por score combinado.
 *
 * @param {object} opts
 * @param {string} opts.query - texto ya normalizado
 * @param {object|null} [opts.locationMatch] - filtro de ubicación (match Mongo) o null
 * @param {number} [opts.limit=10] - número máximo de resultados combinados
 */
export async function hybridSearchAssets({ query, locationMatch = null, limit = 10 }) {
  const db = getDb();
  if (!db) throw new Error('MongoDB no conectado');

  // 1) Embedding de la query (para Vector Search)
  const { embedding } = await getTextEmbedding(query);

  const baseMatch = { isReconciled: { $ne: true } };
  const matchStage = locationMatch
    ? { $match: { $and: [locationMatch, baseMatch] } }
    : { $match: baseMatch };

  // 2) Vector Search
  const vectorPipeline = [
    {
      $vectorSearch: {
        index: VECTOR_INDEX,
        path: 'textEmbedding',
        queryVector: embedding,
        numCandidates: locationMatch ? 400 : 200,
        limit: limit * 3,
      },
    },
    matchStage,
    { $limit: limit * 3 },
    {
      $project: {
        _id: 1,
        name: 1,
        brand: 1,
        model: 1,
        EPC: 1,
        locationPath: 1,
        fileExt: 1,
        isReconciled: 1,
        vectorScore: { $meta: 'vectorSearchScore' },
      },
    },
  ];

  // 3) Atlas Search (texto)
  const textPipeline = [
    {
      $search: {
        index: TEXT_INDEX,
        text: {
          query,
          path: ['name', 'brand', 'model', 'EPC'],
          fuzzy: { maxEdits: 2 },
        },
      },
    },
    matchStage,
    { $limit: limit * 3 },
    {
      $project: {
        _id: 1,
        name: 1,
        brand: 1,
        model: 1,
        EPC: 1,
        locationPath: 1,
        fileExt: 1,
        isReconciled: 1,
        textScore: { $meta: 'searchScore' },
      },
    },
  ];

  const [vectorRes, textRes] = await Promise.all([
    db.collection(ASSETS_COLLECTION).aggregate(vectorPipeline).toArray(),
    db.collection(ASSETS_COLLECTION).aggregate(textPipeline).toArray(),
  ]);

  // 4) Combinar resultados por _id
  const byId = new Map();

  for (const v of vectorRes) {
    const id = v._id.toString();
    byId.set(id, {
      _id: v._id,
      name: v.name,
      brand: v.brand,
      model: v.model,
      EPC: v.EPC,
      locationPath: v.locationPath,
      fileExt: v.fileExt,
      isReconciled: v.isReconciled,
      vectorScore: Number(v.vectorScore) || 0,
      textScore: 0,
    });
  }

  let maxText = 0;
  for (const t of textRes) {
    const id = t._id.toString();
    const existing =
      byId.get(id) ||
      {
        _id: t._id,
        name: t.name,
        brand: t.brand,
        model: t.model,
        EPC: t.EPC,
        locationPath: t.locationPath,
        fileExt: t.fileExt,
        isReconciled: t.isReconciled,
        vectorScore: 0,
        textScore: 0,
      };
    const currentTextScore = Number(t.textScore) || 0;
    if (currentTextScore > existing.textScore) {
      existing.textScore = currentTextScore;
    }
    maxText = Math.max(maxText, existing.textScore);
    byId.set(id, existing);
  }

  // 5) Normalizar y calcular score combinado
  const combined = Array.from(byId.values()).map((doc) => {
    const vScore = Number(doc.vectorScore) || 0;
    const tRaw = Number(doc.textScore) || 0;
    const tNorm = maxText > 0 ? tRaw / maxText : 0;
    const hybridScore = VECTOR_WEIGHT * vScore + TEXT_WEIGHT * tNorm;
    return {
      ...doc,
      score: hybridScore,
      textScore: tNorm,
    };
  });

  combined.sort((a, b) => (b.score || 0) - (a.score || 0));

  return combined.slice(0, limit);
}

