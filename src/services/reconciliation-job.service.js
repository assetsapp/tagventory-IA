import { ObjectId } from 'mongodb';
import { getDb } from '../config/mongo.js';
import { getTextEmbedding } from './embedding.service.js';
import { normalizeText } from '../utils/embedding-text.js';

const COLLECTION = 'reconciliation_jobs';
const ASSETS_COLLECTION = 'assets';
const VECTOR_INDEX = 'assets_text_embedding_index';

/**
 * Crea un job de conciliación con las filas SAP recibidas.
 * No genera embeddings aún, solo persiste el job en estado "pending".
 */
export async function createJob(rows) {
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

      const suggestions = await db.collection(ASSETS_COLLECTION).aggregate([
        {
          $vectorSearch: {
            index: VECTOR_INDEX,
            path: 'textEmbedding',
            queryVector: embedding,
            numCandidates: 100,
            limit: 5,
          },
        },
        {
          $project: {
            _id: 1,
            name: 1,
            brand: 1,
            model: 1,
            EPC: 1,
            locationPath: 1,
            fileExt: 1,
            score: { $meta: 'vectorSearchScore' },
          },
        },
      ]).toArray();

      const formattedSuggestions = suggestions.map((s) => ({
        assetId: s._id,
        name: s.name || '',
        brand: s.brand || '',
        model: s.model || '',
        EPC: s.EPC || '',
        locationPath: s.locationPath || '',
        fileExt: s.fileExt || '',
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
    rows,
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

  const result = await collection.updateOne(
    { _id: objectId, 'rows.rowNumber': rowNumber },
    {
      $set: {
        'rows.$.decision': decision,
        'rows.$.selectedAssetId': selectedAssetId ? new ObjectId(selectedAssetId) : null,
        updatedAt: new Date(),
      },
    }
  );

  if (result.matchedCount === 0) {
    throw new Error('Job o fila no encontrados');
  }

  return { success: true };
}
