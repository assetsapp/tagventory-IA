import { getTextEmbedding } from '../services/embedding.service.js';
import { backfillSampleAssets } from '../services/backfill.service.js';
import { getDb } from '../config/mongo.js';

export async function postEmbedding(req, res, next) {
  try {
    const { text } = req.body;

    if (!text || typeof text !== 'string' || text.trim() === '') {
      return res.status(400).json({
        status: 'error',
        message: 'El campo "text" es requerido y no puede estar vacío',
      });
    }

    const { embedding, dims } = await getTextEmbedding(text.trim());
    const preview = embedding.slice(0, 5);

    res.json({
      dims,
      preview,
    });
  } catch (err) {
    next(err);
  }
}

export async function postBackfillSample(req, res, next) {
  try {
    const rawLimit = req.body?.limit ?? 20;
    const limit = Math.max(1, Math.min(100, Number(rawLimit) || 20));
    const { updated } = await backfillSampleAssets(limit);
    res.json({ updated });
  } catch (err) {
    next(err);
  }
}

export async function postSearchAssets(req, res) {
  try {
    const { query, limit } = req.body;

    if (!query || typeof query !== 'string' || query.trim() === '') {
      return res.status(400).json({
        status: 'error',
        message: 'El campo "query" es requerido y no puede estar vacío',
      });
    }

    const { embedding } = await getTextEmbedding(query.trim());

    const db = getDb();
    if (!db) throw new Error('MongoDB no conectado');

    const results = await db.collection('assets').aggregate([
      {
        $vectorSearch: {
          index: 'assets_text_embedding_index',
          path: 'textEmbedding',
          queryVector: embedding,
          numCandidates: 200,
          limit: limit || 5,
        },
      },
      {
        $match: {
          isReconciled: { $ne: true },
        },
      },
      {
        $project: {
          _id: 1,
          name: 1,
          brand: 1,
          model: 1,
          locationPath: 1,
          serial: 1,
          EPC: 1,
          fileExt: 1,
          score: { $meta: 'vectorSearchScore' },
        },
      },
    ]).toArray();

    res.json({ results });
  } catch (err) {
    console.error('[postSearchAssets]', err.message);
    res.status(500).json({
      status: 'error',
      message: err.message || 'Error en búsqueda semántica',
    });
  }
}
