import { getDb } from '../config/mongo.js';
import { getTextEmbedding } from './embedding.service.js';

const ASSETS_COLLECTION = 'assets';
const VECTOR_INDEX = 'assets_text_embedding_index';
const TEXT_INDEX = 'assets_text_search_index';

// Configuración de fusión híbrida (score final en rango 0..1)
const VECTOR_WEIGHT = 0.55;
const TEXT_WEIGHT = 0.35;
const RRF_WEIGHT = 0.1; // estabiliza ranking cuando los scores crudos difieren
const CROSS_MODAL_BONUS = 0.05; // premio si aparece en ambos: vector + texto
const RRF_K = 60;
const FETCH_MULTIPLIER = 6;
const MAX_ATLAS_QUERY_TOKENS = 10;
const MAX_ATLAS_QUERY_CHARS = 120;

function rrfFromRank(rank) {
  if (!Number.isFinite(rank) || rank <= 0) return 0;
  return 1 / (RRF_K + rank);
}

function normalizeByMax(value, max) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (!Number.isFinite(max) || max <= 0) return 0;
  return Math.max(0, Math.min(1, value / max));
}

function safeToArray(cursorPromise, label) {
  return cursorPromise.catch((err) => {
    console.warn(`[hybrid-search] ${label} falló: ${err.message}`);
    return [];
  });
}

function sanitizeAtlasQuery(raw) {
  const normalized = String(raw || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s\-./]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return '';
  const tokens = normalized.split(' ').filter(Boolean).slice(0, MAX_ATLAS_QUERY_TOKENS);
  return tokens.join(' ').slice(0, MAX_ATLAS_QUERY_CHARS).trim();
}

function buildTextPipeline({ query, matchStage, fetchLimit, fuzzyEnabled = true, includeEpc = true }) {
  const textPaths = includeEpc ? ['name', 'brand', 'model', 'EPC'] : ['name', 'brand', 'model'];
  const should = [
    {
      phrase: {
        query,
        path: ['name', 'brand', 'model'],
        slop: 2,
        score: { boost: { value: 5 } },
      },
    },
    {
      text: {
        query,
        path: textPaths,
        score: { boost: { value: 3 } },
      },
    },
  ];

  if (fuzzyEnabled) {
    should.push({
      text: {
        query,
        path: textPaths,
        fuzzy: { maxEdits: 1, maxExpansions: 30, prefixLength: 2 },
        score: { boost: { value: 1.5 } },
      },
    });
  }

  return [
    {
      $search: {
        index: TEXT_INDEX,
        compound: {
          should,
          minimumShouldMatch: 1,
        },
      },
    },
    matchStage,
    { $limit: fetchLimit },
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
}

function isClauseOverflowError(err) {
  const msg = String(err?.message || '').toLowerCase();
  return msg.includes('maxclausecount') || msg.includes('too many nested clauses');
}

async function runTextSearch(collection, { query, matchStage, fetchLimit }) {
  const compactQuery = sanitizeAtlasQuery(query);
  if (!compactQuery) return [];

  const primaryPipeline = buildTextPipeline({
    query: compactQuery,
    matchStage,
    fetchLimit,
    fuzzyEnabled: true,
    includeEpc: true,
  });

  try {
    return await collection.aggregate(primaryPipeline).toArray();
  } catch (err) {
    if (!isClauseOverflowError(err)) {
      console.warn(`[hybrid-search] atlasSearch falló: ${err.message}`);
      return [];
    }

    const fallbackQuery = compactQuery.split(' ').slice(0, 6).join(' ');
    const fallbackPipeline = buildTextPipeline({
      query: fallbackQuery,
      matchStage,
      fetchLimit,
      fuzzyEnabled: false,
      includeEpc: false,
    });

    try {
      console.warn('[hybrid-search] atlasSearch excedió maxClauseCount; reintentando en modo conservador');
      return await collection.aggregate(fallbackPipeline).toArray();
    } catch (retryErr) {
      console.warn(`[hybrid-search] atlasSearch fallback falló: ${retryErr.message}`);
      return [];
    }
  }
}

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
  const searchLimit = Math.max(1, Number(limit) || 10);
  const fetchLimit = searchLimit * FETCH_MULTIPLIER;

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
        numCandidates: locationMatch ? 800 : 400,
        limit: fetchLimit,
      },
    },
    matchStage,
    { $limit: fetchLimit },
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

  const assets = db.collection(ASSETS_COLLECTION);

  const [vectorRes, textRes] = await Promise.all([
    safeToArray(assets.aggregate(vectorPipeline).toArray(), 'vectorSearch'),
    runTextSearch(assets, { query, matchStage, fetchLimit }),
  ]);
  if (!vectorRes.length && !textRes.length) return [];

  // 4) Combinar resultados por _id
  const byId = new Map();
  const vectorRankById = new Map();
  const textRankById = new Map();

  for (let i = 0; i < vectorRes.length; i++) {
    const v = vectorRes[i];
    const id = v._id.toString();
    vectorRankById.set(id, i + 1);
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

  let maxVector = 0;
  for (const v of vectorRes) {
    maxVector = Math.max(maxVector, Number(v.vectorScore) || 0);
  }

  let maxText = 0;
  for (let i = 0; i < textRes.length; i++) {
    const t = textRes[i];
    const id = t._id.toString();
    textRankById.set(id, i + 1);
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
  const maxRrf = rrfFromRank(1);
  const combined = Array.from(byId.values()).map((doc) => {
    const id = doc._id.toString();
    const vRaw = Number(doc.vectorScore) || 0;
    const tRaw = Number(doc.textScore) || 0;
    const vNorm = normalizeByMax(vRaw, maxVector);
    const tNorm = normalizeByMax(tRaw, maxText);
    const vRank = vectorRankById.get(id);
    const tRank = textRankById.get(id);
    const vRrf = normalizeByMax(rrfFromRank(vRank), maxRrf);
    const tRrf = normalizeByMax(rrfFromRank(tRank), maxRrf);
    const crossBonus = vRank && tRank ? CROSS_MODAL_BONUS : 0;
    const hybridScore =
      VECTOR_WEIGHT * vNorm +
      TEXT_WEIGHT * tNorm +
      RRF_WEIGHT * ((vRrf + tRrf) / 2) +
      crossBonus;

    return {
      ...doc,
      score: Math.max(0, Math.min(1, hybridScore)),
      textScore: tNorm,
      vectorScoreNorm: vNorm,
    };
  });

  combined.sort((a, b) => (b.score || 0) - (a.score || 0));

  return combined.slice(0, searchLimit);
}
