import { getTextEmbedding } from '../services/embedding.service.js';
import { normalizeText } from '../utils/embedding-text.js';
import { getDb } from '../config/mongo.js';
import {
  createJob,
  processJob,
  getJobResults,
  saveDecision,
} from '../services/reconciliation-job.service.js';

/**
 * POST /ai/reconciliation/suggestions
 *
 * MVP de conciliación con IA:
 * Compara la descripción SAP (texto libre) contra los activos de Tagventory
 * usando únicamente (name + brand + model) mediante embeddings y vector search.
 * Sin filtros por ubicación, categoría ni reglas adicionales.
 */
export async function postReconciliationSuggestions(req, res) {
  try {
    const { sapDescription, limit } = req.body;

    if (!sapDescription || typeof sapDescription !== 'string' || sapDescription.trim() === '') {
      return res.status(400).json({
        status: 'error',
        message: 'El campo "sapDescription" es requerido y no puede estar vacío',
      });
    }

    const normalizedQuery = normalizeText(sapDescription);
    const { embedding } = await getTextEmbedding(normalizedQuery);

    const db = getDb();
    if (!db) throw new Error('MongoDB no conectado');

    const searchLimit = Math.max(1, Math.min(50, Number(limit) || 5));

    const results = await db.collection('assets').aggregate([
      {
        $vectorSearch: {
          index: 'assets_text_embedding_index',
          path: 'textEmbedding',
          queryVector: embedding,
          numCandidates: 200,
          limit: searchLimit,
        },
      },
      {
        $project: {
          _id: 1,
          name: 1,
          brand: 1,
          model: 1,
          score: { $meta: 'vectorSearchScore' },
        },
      },
    ]).toArray();

    res.json({
      query: normalizedQuery,
      results,
    });
  } catch (err) {
    console.error('[reconciliation/suggestions]', err.message);
    res.status(500).json({
      status: 'error',
      message: 'Error al generar sugerencias de conciliación',
    });
  }
}

// ──────────────────────────────────────────────
// Conciliación por lote (Jobs)
// ──────────────────────────────────────────────

/**
 * POST /ai/reconciliation/job
 *
 * Crea un job de conciliación por lote.
 * Recibe las filas SAP, las persiste con status "pending".
 * No genera embeddings en este paso.
 */
export async function postCreateJob(req, res) {
  try {
    const { rows } = req.body;

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({
        status: 'error',
        message: 'El campo "rows" es requerido y debe ser un arreglo no vacío',
      });
    }

    const { jobId, totalRows } = await createJob(rows);
    res.json({ jobId, totalRows });
  } catch (err) {
    console.error('[reconciliation/job:create]', err.message);
    res.status(500).json({
      status: 'error',
      message: 'Error al crear el job de conciliación',
    });
  }
}

/**
 * POST /ai/reconciliation/job/:jobId/process
 *
 * Procesa un job existente: genera embeddings y ejecuta vector search
 * para cada fila, en serie (una por una).
 */
export async function postProcessJob(req, res) {
  try {
    const { jobId } = req.params;
    const result = await processJob(jobId);
    res.json(result);
  } catch (err) {
    console.error('[reconciliation/job:process]', err.message);
    const status = err.message.includes('no encontrado') ? 404 : 500;
    res.status(status).json({
      status: 'error',
      message: err.message || 'Error al procesar el job de conciliación',
    });
  }
}

/**
 * GET /ai/reconciliation/job/:jobId
 *
 * Obtiene resultados paginados de un job.
 * Query params: offset (default 0), limit (default 20).
 */
export async function getJob(req, res) {
  try {
    const { jobId } = req.params;
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));

    const result = await getJobResults(jobId, offset, limit);
    res.json(result);
  } catch (err) {
    console.error('[reconciliation/job:get]', err.message);
    const status = err.message.includes('no encontrado') ? 404 : 500;
    res.status(status).json({
      status: 'error',
      message: err.message || 'Error al obtener el job',
    });
  }
}

/**
 * POST /ai/reconciliation/job/:jobId/decision
 *
 * Guarda la decisión del usuario para una fila del job.
 * Body: { rowNumber, decision: "match"|"no_match", selectedAssetId? }
 */
export async function postDecision(req, res) {
  try {
    const { jobId } = req.params;
    const { rowNumber, decision, selectedAssetId } = req.body;

    if (rowNumber == null) {
      return res.status(400).json({
        status: 'error',
        message: 'El campo "rowNumber" es requerido',
      });
    }

    const validDecisions = ['match', 'no_match', 'pending'];
    if (!validDecisions.includes(decision)) {
      return res.status(400).json({
        status: 'error',
        message: `"decision" debe ser uno de: ${validDecisions.join(', ')}`,
      });
    }

    if (decision === 'match' && !selectedAssetId) {
      return res.status(400).json({
        status: 'error',
        message: 'Si decision es "match", "selectedAssetId" es requerido',
      });
    }

    await saveDecision(jobId, rowNumber, decision, selectedAssetId || null);
    res.json({ success: true });
  } catch (err) {
    console.error('[reconciliation/job:decision]', err.message);
    const status = err.message.includes('no encontrado') ? 404 : 500;
    res.status(status).json({
      status: 'error',
      message: err.message || 'Error al guardar decisión',
    });
  }
}
