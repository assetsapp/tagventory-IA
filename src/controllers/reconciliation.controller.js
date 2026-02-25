import { getTextEmbedding } from '../services/embedding.service.js';
import { normalizeText } from '../utils/embedding-text.js';
import { buildLocationMatch } from '../utils/location-filter.js';
import { getDb } from '../config/mongo.js';
import {
  createJob,
  processJob,
  getJobResults,
  saveDecision,
  listJobs,
  getJobAllRows,
  deleteJob,
} from '../services/reconciliation-job.service.js';
import { buildJobReportExcel } from '../services/report-export.service.js';

/**
 * POST /ai/reconciliation/suggestions
 *
 * MVP de conciliación con IA:
 * Compara la descripción SAP (texto libre) contra los activos de Tagventory
 * usando únicamente (name + brand + model) mediante embeddings y vector search.
 * Acepta filtro opcional por ubicación (locationFilter): solo devuelve activos en esa ubicación o hijas.
 */
export async function postReconciliationSuggestions(req, res) {
  try {
    const { sapDescription, limit, locationFilter } = req.body;

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

    const searchLimit = Math.max(1, Math.min(50, Number(limit) || 10));
    const locationMatch = buildLocationMatch(locationFilter);

    const pipeline = [
      {
        $vectorSearch: {
          index: 'assets_text_embedding_index',
          path: 'textEmbedding',
          queryVector: embedding,
          numCandidates: locationMatch ? 400 : 200,
          limit: locationMatch ? Math.min(100, searchLimit * 10) : searchLimit,
        },
      },
    ];
    if (locationMatch) {
      pipeline.push({ $match: locationMatch }, { $limit: searchLimit });
    }
    pipeline.push({
      $project: {
        _id: 1,
        name: 1,
        brand: 1,
        model: 1,
        fileExt: 1,
        score: { $meta: 'vectorSearchScore' },
      },
    });

    const results = await db.collection('assets').aggregate(pipeline).toArray();

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
    const { rows, locationFilter } = req.body;

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({
        status: 'error',
        message: 'El campo "rows" es requerido y debe ser un arreglo no vacío',
      });
    }

    const filter =
      locationFilter != null && String(locationFilter).trim() !== ''
        ? String(locationFilter).trim()
        : null;
    const { jobId, totalRows } = await createJob(rows, filter);
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
 * Inicia el procesamiento del job en segundo plano y retorna de inmediato.
 * El frontend debe hacer polling a GET /job/:jobId para ver progreso (processedRows/totalRows).
 */
export async function postProcessJob(req, res) {
  try {
    const { jobId } = req.params;
    processJob(jobId).catch((err) => {
      console.error('[reconciliation/job:process]', err.message);
    });
    res.json({ status: 'processing', jobId, message: 'Análisis iniciado. Consulta el estado con GET /job/:jobId' });
  } catch (err) {
    console.error('[reconciliation/job:process]', err.message);
    const status = err.message.includes('no encontrado') ? 404 : 500;
    res.status(status).json({
      status: 'error',
      message: err.message || 'Error al iniciar el procesamiento del job',
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
    const limit = Math.max(1, Math.min(2000, Number(req.query.limit) || 20));

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

// ──────────────────────────────────────────────
// Reportes (listado y export Excel)
// ──────────────────────────────────────────────

/**
 * GET /ai/reconciliation/jobs
 *
 * Lista jobs con filtro opcional por fechas.
 * Query: from (ISO date), to (ISO date).
 */
export async function getJobsList(req, res) {
  try {
    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;
    if (from && isNaN(from.getTime())) {
      return res.status(400).json({ status: 'error', message: 'Parámetro "from" debe ser una fecha válida' });
    }
    if (to && isNaN(to.getTime())) {
      return res.status(400).json({ status: 'error', message: 'Parámetro "to" debe ser una fecha válida' });
    }
    const jobs = await listJobs(from, to);
    res.json({ jobs });
  } catch (err) {
    console.error('[reconciliation/jobs:list]', err.message);
    res.status(500).json({
      status: 'error',
      message: 'Error al listar jobs',
    });
  }
}

/**
 * GET /ai/reconciliation/job/:jobId/export
 *
 * Descarga el reporte del job en Excel.
 * Columnas: Fila, Descripción SAP, Ubicación SAP, Estado (Match/Not found), Nombre, Marca, Modelo, EPC, Ubicación Tagventory.
 */
export async function getJobExport(req, res) {
  try {
    const { jobId } = req.params;
    const job = await getJobAllRows(jobId);
    const buffer = buildJobReportExcel(job);
    const filename = `reporte-conciliacion-${jobId}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    console.error('[reconciliation/job:export]', err.message);
    const status = err.message.includes('no encontrado') ? 404 : 500;
    res.status(status).json({
      status: 'error',
      message: err.message || 'Error al exportar reporte',
    });
  }
}

/**
 * DELETE /ai/reconciliation/job/:jobId
 *
 * Elimina un job de conciliación completo.
 */
export async function deleteJobController(req, res) {
  try {
    const { jobId } = req.params;
    await deleteJob(jobId);
    res.json({ success: true });
  } catch (err) {
    console.error('[reconciliation/job:delete]', err.message);
    const status = err.message.includes('no encontrado') ? 404 : 500;
    res.status(status).json({
      status: 'error',
      message: err.message || 'Error al eliminar job',
    });
  }
}
