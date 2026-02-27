import { ObjectId } from 'mongodb';
import { getDb } from '../config/mongo.js';
import { getTextEmbedding } from './embedding.service.js';
import { normalizeText } from '../utils/embedding-text.js';
import { buildLocationMatch } from '../utils/location-filter.js';

const COLLECTION = 'reconciliation_jobs';
const ASSETS_COLLECTION = 'assets';
const VECTOR_INDEX = 'assets_text_embedding_index';

/**
 * Crea un job de conciliación con las filas SAP recibidas.
 * No genera embeddings aún, solo persiste el job en estado "pending".
 * @param {Array} rows - Filas SAP
 * @param {string} [locationFilter] - Ubicación opcional para filtrar coincidencias (padre e hijos)
 */
export async function createJob(rows, locationFilter = null) {
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

  const doc = {
    status: 'pending',
    totalRows: jobRows.length,
    processedRows: 0,
    locationFilter: locationFilter && String(locationFilter).trim() ? String(locationFilter).trim() : null,
    createdAt: new Date(),
    updatedAt: new Date(),
    rows: jobRows,
  };

  const result = await db.collection(COLLECTION).insertOne(doc);
  return { jobId: result.insertedId, totalRows: doc.totalRows };
}

/**
 * Procesa un job: genera embeddings y ejecuta vector search fila por fila (en serie).
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

      const { embedding } = await getTextEmbedding(normalizedDesc);

      const locationMatch = job.locationFilter ? buildLocationMatch(job.locationFilter) : null;
      const pipeline = [
        {
          $vectorSearch: {
            index: VECTOR_INDEX,
            path: 'textEmbedding',
            queryVector: embedding,
            numCandidates: locationMatch ? 400 : 200,
            limit: locationMatch ? 80 : 10,
          },
        },
      ];
      const baseMatch = { isReconciled: { $ne: true } };
      if (locationMatch) {
        pipeline.push(
          { $match: { $and: [locationMatch, baseMatch] } },
          { $limit: 10 }
        );
      } else {
        pipeline.push({ $match: baseMatch }, { $limit: 10 });
      }
      pipeline.push({
        $project: {
          _id: 1,
          name: 1,
          brand: 1,
          model: 1,
          EPC: 1,
          locationPath: 1,
          fileExt: 1,
          isReconciled: 1,
          score: { $meta: 'vectorSearchScore' },
        },
      });

      const suggestions = await db.collection(ASSETS_COLLECTION).aggregate(pipeline).toArray();

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
      }));

      // No guardamos el embedding (evita superar límite 16MB de MongoDB)
      await collection.updateOne(
        { _id: objectId },
        {
          $set: {
            [`rows.${i}.suggestions`]: formattedSuggestions,
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
        locationFilter: 1,
        createdAt: 1,
        updatedAt: 1,
        rows: { $slice: [offset, limit] },
      },
    }
  );

  if (!job) throw new Error('Job no encontrado');

  const rows = (job.rows || []).map((r) => ({
    rowNumber: r.rowNumber,
    sapDescription: r.sapDescription,
    sapLocation: r.sapLocation,
    suggestions: r.suggestions || [],
    decision: r.decision,
    selectedAssetId: r.selectedAssetId,
  }));

  return {
    jobId: job._id,
    status: job.status,
    totalRows: job.totalRows,
    processedRows: job.processedRows,
    locationFilter: job.locationFilter ?? null,
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
        locationFilter: 1,
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
    locationFilter: j.locationFilter ?? null,
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
        locationFilter: 1,
        createdAt: 1,
        rows: 1,
      },
    }
  );

  if (!job) throw new Error('Job no encontrado');

  return {
    jobId: job._id,
    status: job.status,
    totalRows: job.totalRows,
    processedRows: job.processedRows,
    locationFilter: job.locationFilter ?? null,
    createdAt: job.createdAt,
    rows: job.rows || [],
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

  const rows = job.rows || [];
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

  // Si el usuario marca "no_match", limpiamos también las sugerencias de esa fila
  // para que no vuelvan a mostrarse en vistas posteriores (conciliación/reportes).
  if (decision === 'no_match') {
    update['rows.$.suggestions'] = [];
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

  return { success: true };
}
