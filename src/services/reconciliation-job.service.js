import { ObjectId } from 'mongodb';
import { getDb } from '../config/mongo.js';
import { normalizeText } from '../utils/embedding-text.js';
import { getLocationMatchFromIds } from '../utils/location-filter.js';
import { hybridSearchAssets } from './hybrid-search.service.js';

const COLLECTION = 'reconciliation_jobs';
const SUGGESTIONS_COLLECTION = 'reconciliation_job_suggestions';
const ASSETS_COLLECTION = 'assets';
const VECTOR_INDEX = 'assets_text_embedding_index';
// Sugerencias por fila: se guardan en colección separada (no en el documento del job)
// para no superar el límite de 16 MB. Con 40, si hay 20 ítems iguales (ej. 20 sillas),
// todos pueden aparecer y la auto-conciliación puede asignar uno por fila.
const JOB_SUGGESTION_LIMIT = 40;

/**
 * Crea un job de conciliación con las filas SAP recibidas.
 * No genera embeddings aún, solo persiste el job en estado "pending".
 * @param {Array} rows - Filas SAP
 * @param {string[]} [locationFilterIds] - IDs de ubicación (ubicación + hijas y subhijas)
 */
export async function createJob(rows, locationFilterIds = null) {
  const db = getDb();
  if (!db) throw new Error('MongoDB no conectado');

  const jobRows = rows.map((r) => ({
    rowNumber: r.rowNumber,
    sapDescription: r.sapDescription || '',
    sapLocation: r.sapLocation || '',
    suggestions: [],
    decision: 'pending',
    selectedAssetId: null,
  }));

  const idsFilter =
    Array.isArray(locationFilterIds) && locationFilterIds.length > 0
      ? locationFilterIds.map((id) => String(id)).filter(Boolean)
      : null;

  const doc = {
    status: 'pending',
    totalRows: jobRows.length,
    processedRows: 0,
    locationFilterIds: idsFilter,
    createdAt: new Date(),
    updatedAt: new Date(),
    rows: jobRows,
  };

  const result = await db.collection(COLLECTION).insertOne(doc);
  return { jobId: result.insertedId, totalRows: doc.totalRows };
}

/**
 * Carga sugerencias desde la colección separada para un job (y opcionalmente filas concretas).
 * @param {import('mongodb').Db} db
 * @param {import('mongodb').ObjectId} jobId
 * @param {number[]} [rowNumbers] - Si se pasa, solo se cargan esas filas; si no, todas del job.
 * @returns {Promise<Map<number, Array>>} Map rowNumber -> suggestions
 */
async function loadSuggestionsForJob(db, jobId, rowNumbers = null) {
  const filter = { jobId };
  if (Array.isArray(rowNumbers) && rowNumbers.length > 0) {
    filter.rowNumber = { $in: rowNumbers };
  }
  const docs = await db
    .collection(SUGGESTIONS_COLLECTION)
    .find(filter)
    .project({ rowNumber: 1, suggestions: 1 })
    .toArray();
  const map = new Map();
  for (const d of docs) {
    map.set(d.rowNumber, Array.isArray(d.suggestions) ? d.suggestions : []);
  }
  return map;
}

/**
 * Procesa un job: genera embeddings y ejecuta búsqueda híbrida fila por fila (en serie).
 */
export async function processJob(jobId) {
  const db = getDb();
  if (!db) throw new Error('MongoDB no conectado');

  const collection = db.collection(COLLECTION);
  const objectId = new ObjectId(jobId);

  const job = await collection.findOne({ _id: objectId });
  if (!job) throw new Error('Job no encontrado');
  if (job.status === 'completed') throw new Error('Job ya fue procesado');

  await collection.updateOne(
    { _id: objectId },
    { $set: { status: 'processing', updatedAt: new Date() } }
  );

  let processedRows = 0;

  for (let i = 0; i < job.rows.length; i++) {
    const row = job.rows[i];

    try {
      const normalizedDesc = normalizeText(row.sapDescription);
      if (!normalizedDesc) continue;

      const locationMatch =
        job.locationFilterIds && job.locationFilterIds.length > 0
          ? await getLocationMatchFromIds(db, job.locationFilterIds)
          : null;

      const suggestions = await hybridSearchAssets({
        query: normalizedDesc,
        locationMatch,
        limit: JOB_SUGGESTION_LIMIT,
      });

      const formattedSuggestions = suggestions.map((s) => ({
        assetId: s._id,
        name: s.name || '',
        brand: s.brand || '',
        model: s.model || '',
        EPC: s.EPC || '',
        locationPath: s.locationPath || '',
        fileExt: s.fileExt || '',
        isReconciled: Boolean(s.isReconciled),
        score: s.score,
        vectorScore: s.vectorScore ?? null,
        textScore: s.textScore ?? null,
      }));

      // Guardamos sugerencias en colección separada para no superar 16 MB del documento del job
      const suggestionsColl = db.collection(SUGGESTIONS_COLLECTION);
      await suggestionsColl.replaceOne(
        { jobId: objectId, rowNumber: row.rowNumber },
        { jobId: objectId, rowNumber: row.rowNumber, suggestions: formattedSuggestions },
        { upsert: true }
      );

      await collection.updateOne(
        { _id: objectId },
        {
          $set: {
            processedRows: processedRows + 1,
            updatedAt: new Date(),
          },
        }
      );

      processedRows++;
    } catch (err) {
      console.error(`[reconciliation-job] Error procesando fila ${row.rowNumber}:`, err.message);
    }
  }

  await collection.updateOne(
    { _id: objectId },
    { $set: { status: 'completed', processedRows, updatedAt: new Date() } }
  );

  return { status: 'completed', processedRows };
}

/**
 * Obtiene un job con sus filas paginadas (sin devolver el campo embedding).
 */
export async function getJobResults(jobId, offset = 0, limit = 20) {
  const db = getDb();
  if (!db) throw new Error('MongoDB no conectado');

  const objectId = new ObjectId(jobId);

  const job = await db.collection(COLLECTION).findOne(
    { _id: objectId },
    {
      projection: {
        status: 1,
        totalRows: 1,
        processedRows: 1,
        locationFilterIds: 1,
        createdAt: 1,
        updatedAt: 1,
        rows: { $slice: [offset, limit] },
      },
    }
  );

  if (!job) throw new Error('Job no encontrado');

  const jobRows = job.rows || [];
  const rowNumbers = jobRows.map((r) => r.rowNumber);
  const suggestionsMap = await loadSuggestionsForJob(db, objectId, rowNumbers);

  const rows = jobRows.map((r) => ({
    rowNumber: r.rowNumber,
    sapDescription: r.sapDescription,
    sapLocation: r.sapLocation,
    suggestions: suggestionsMap.get(r.rowNumber) ?? r.suggestions ?? [],
    decision: r.decision,
    selectedAssetId: r.selectedAssetId,
  }));

  return {
    jobId: job._id,
    status: job.status,
    totalRows: job.totalRows,
    processedRows: job.processedRows,
    locationFilterIds: job.locationFilterIds ?? null,
    rows,
  };
}

/**
 * Lista jobs por rango de fechas (por createdAt).
 * @param {Date} [fromDate] - Inicio (inclusive)
 * @param {Date} [toDate] - Fin (inclusive); se considera hasta end of day
 */
export async function listJobs(fromDate = null, toDate = null) {
  const db = getDb();
  if (!db) throw new Error('MongoDB no conectado');

  const filter = {};
  if (fromDate) {
    filter.createdAt = filter.createdAt || {};
    filter.createdAt.$gte = new Date(fromDate);
  }
  if (toDate) {
    const end = new Date(toDate);
    end.setHours(23, 59, 59, 999);
    filter.createdAt = filter.createdAt || {};
    filter.createdAt.$lte = end;
  }

  const jobs = await db
    .collection(COLLECTION)
    .find(filter, {
      projection: {
        _id: 1,
        status: 1,
        totalRows: 1,
        processedRows: 1,
        locationFilterIds: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    })
    .sort({ createdAt: -1 })
    .toArray();

  return jobs.map((j) => ({
    jobId: j._id,
    status: j.status,
    totalRows: j.totalRows,
    processedRows: j.processedRows,
    locationFilterIds: j.locationFilterIds ?? null,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
  }));
}

/**
 * Obtiene un job con todas sus filas (para export).
 */
export async function getJobAllRows(jobId) {
  const db = getDb();
  if (!db) throw new Error('MongoDB no conectado');

  const objectId = new ObjectId(jobId);
  const job = await db.collection(COLLECTION).findOne(
    { _id: objectId },
    {
      projection: {
        _id: 1,
        status: 1,
        totalRows: 1,
        processedRows: 1,
        locationFilterIds: 1,
        createdAt: 1,
        rows: 1,
      },
    }
  );

  if (!job) throw new Error('Job no encontrado');

  const suggestionsMap = await loadSuggestionsForJob(db, objectId);
  const rows = (job.rows || []).map((r) => ({
    ...r,
    suggestions: suggestionsMap.get(r.rowNumber) ?? r.suggestions ?? [],
  }));

  return {
    jobId: job._id,
    status: job.status,
    totalRows: job.totalRows,
    processedRows: job.processedRows,
    locationFilterIds: job.locationFilterIds ?? null,
    createdAt: job.createdAt,
    rows,
  };
}

/**
 * Conciliación automática de un job:
 * - Para cada fila pendiente, toma la mejor sugerencia con score >= minScore
 * - No reutiliza el mismo asset en varias filas del mismo job
 * - Respeta filas ya marcadas como match / no_match
 */
export async function autoReconcileJob(jobId, minScore = 0.8) {
  const db = getDb();
  if (!db) throw new Error('MongoDB no conectado');

  const objectId = new ObjectId(jobId);
  const job = await db.collection(COLLECTION).findOne(
    { _id: objectId },
    {
      projection: {
        rows: 1,
      },
    }
  );

  if (!job) throw new Error('Job no encontrado');

  const suggestionsMap = await loadSuggestionsForJob(db, objectId);
  const rows = (job.rows || []).map((r) => ({
    ...r,
    suggestions: suggestionsMap.get(r.rowNumber) ?? r.suggestions ?? [],
  }));
  const assignedIds = new Set();

  // Semilla con los assets ya conciliados en este job
  for (const row of rows) {
    if (row.decision === 'match' && row.selectedAssetId) {
      assignedIds.add(row.selectedAssetId.toString());
    }
  }

  // Preparamos las filas pendientes y su mejor score, para procesar primero las más claras.
  const pendingRowsWithScore = rows
    .filter((row) => row && row.decision !== 'match' && row.decision !== 'no_match')
    .map((row) => {
      const suggestions = Array.isArray(row.suggestions) ? row.suggestions : [];
      const bestScore = suggestions.length
        ? Math.max(...suggestions.map((s) => Number(s.score) || 0))
        : 0;
      return { row, bestScore };
    })
    .sort((a, b) => (b.bestScore || 0) - (a.bestScore || 0));

  let autoMatched = 0;

  for (const { row } of pendingRowsWithScore) {
    const suggestions = Array.isArray(row.suggestions) ? row.suggestions : [];
    if (!suggestions.length) continue;

    const sorted = [...suggestions].sort(
      (a, b) => (Number(b.score) || 0) - (Number(a.score) || 0)
    );

    const candidate = sorted.find((s) => {
      const assetIdStr = s.assetId?.toString?.() ?? String(s.assetId);
      const scoreNum = Number(s.score) || 0;
      if (!assetIdStr) return false;
      if (scoreNum < minScore) return false;
      if (assignedIds.has(assetIdStr)) return false;
      if (s.isReconciled) return false;
      return true;
    });

    if (!candidate) continue;

    const assetIdStr = candidate.assetId?.toString?.() ?? String(candidate.assetId);
    await saveDecision(jobId, row.rowNumber, 'match', assetIdStr);
    assignedIds.add(assetIdStr);
    autoMatched++;
  }

  return {
    autoMatched,
    totalRows: rows.length,
  };
}

/**
 * Guarda la decisión del usuario sobre una fila del job.
 */
export async function saveDecision(jobId, rowNumber, decision, selectedAssetId) {
  const db = getDb();
  if (!db) throw new Error('MongoDB no conectado');

  const objectId = new ObjectId(jobId);
  const collection = db.collection(COLLECTION);

  const update = {
    'rows.$.decision': decision,
    'rows.$.selectedAssetId': selectedAssetId ? new ObjectId(selectedAssetId) : null,
    updatedAt: new Date(),
  };

  // Si el usuario marca "no_match", limpiamos las sugerencias de esa fila en la colección separada.
  if (decision === 'no_match') {
    await db.collection(SUGGESTIONS_COLLECTION).replaceOne(
      { jobId: objectId, rowNumber },
      { jobId: objectId, rowNumber, suggestions: [] },
      { upsert: true }
    );
  }

  const result = await collection.updateOne(
    { _id: objectId, 'rows.rowNumber': rowNumber },
    { $set: update }
  );

  if (result.matchedCount === 0) {
    throw new Error('Job o fila no encontrados');
  }

  // Si el usuario confirma un match, marcamos el activo como conciliado
  if (decision === 'match' && selectedAssetId) {
    await db.collection(ASSETS_COLLECTION).updateOne(
      { _id: new ObjectId(selectedAssetId) },
      {
        $set: {
          isReconciled: true,
          reconciledAt: new Date(),
          reconciledJobId: objectId,
          reconciledRowNumber: rowNumber,
        },
      }
    );
  }

  return { success: true };
}

/**
 * Elimina un job de conciliación completo.
 */
export async function deleteJob(jobId) {
  const db = getDb();
  if (!db) throw new Error('MongoDB no conectado');

  const objectId = new ObjectId(jobId);
  const result = await db.collection(COLLECTION).deleteOne({ _id: objectId });

  if (result.deletedCount === 0) {
    throw new Error('Job no encontrado');
  }

  await db.collection(SUGGESTIONS_COLLECTION).deleteMany({ jobId: objectId });

  return { success: true };
}
