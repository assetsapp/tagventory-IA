/**
 * Script para generar embeddings solo de los assets de UNA ubicación y sus hijas/subhijas.
 *
 * Uso:
 *   node scripts/backfill-by-location.js --location=675a09bf7fecb101a9e86dd4
 *   node scripts/backfill-by-location.js --location=675a09bf7fecb101a9e86dd4 --batch=200
 *   node scripts/backfill-by-location.js --location=675a09bf7fecb101a9e86dd4 --dry-run
 *
 * Requiere:
 *   - Colección locationsReal con _id y parent (para expandir ubicación + descendientes).
 *   - Assets con campo location (ID de ubicación, string o ObjectId).
 *
 * Opcional --refresh: también regenera embeddings a assets que ya los tienen (reemplaza).
 */

import { MongoClient, ObjectId } from 'mongodb';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const LOCATIONS_REAL_COLLECTION = 'locationsReal';
const ASSETS_COLLECTION = 'assets';

// ── Config ──────────────────────────────────
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.DB_NAME;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-large';
const EMBEDDING_DIMENSIONS = process.env.EMBEDDING_DIMENSIONS
  ? Number(process.env.EMBEDDING_DIMENSIONS)
  : undefined;

const args = process.argv.slice(2);
const locationArg = args.find((a) => a.startsWith('--location='));
const LOCATION_ID = locationArg ? locationArg.split('=')[1]?.trim() : null;
const BATCH_SIZE = Number(args.find((a) => a.startsWith('--batch='))?.split('=')[1]) || 100;
const DRY_RUN = args.includes('--dry-run');
const REFRESH = args.includes('--refresh');

if (!LOCATION_ID) {
  console.error('[Error] Falta --location=<id>. Ejemplo: --location=675a09bf7fecb101a9e86dd4');
  process.exit(1);
}
if (!Number.isFinite(BATCH_SIZE) || BATCH_SIZE < 1) {
  console.error('[Error] --batch debe ser un número >= 1');
  process.exit(1);
}
if (BATCH_SIZE > 500) {
  console.warn('[Warn] Batch size > 500 puede causar errores/rate limits. Se recomienda <= 200.');
}

if (!MONGO_URI || !DB_NAME || !OPENAI_API_KEY) {
  console.error('[Error] Faltan variables de entorno: MONGO_URI, DB_NAME, OPENAI_API_KEY');
  process.exit(1);
}

console.log(`[Config] Ubicación: ${LOCATION_ID}`);
console.log(`[Config] Modelo: ${EMBEDDING_MODEL}${EMBEDDING_DIMENSIONS ? `, dimensiones: ${EMBEDDING_DIMENSIONS}` : ''}`);
console.log(`[Config] Batch: ${BATCH_SIZE}, dry-run: ${DRY_RUN}, refresh: ${REFRESH}`);

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ── Expandir ubicación + hijas/subhijas (misma lógica que location-filter) ──
function newLocationsRecursive(allLocations, parentIds, acc) {
  const next = allLocations
    .filter((loc) => parentIds.includes(String(loc.parent)))
    .map((loc) => String(loc._id));
  if (next.length === 0) return acc;
  return newLocationsRecursive(allLocations, next, [...acc, ...next]);
}

function callLocationsRecursive(allLocations, parentIds) {
  const parentIdsStr = parentIds.map((id) => String(id));
  const descendants = newLocationsRecursive(allLocations, parentIdsStr, []);
  return [...new Set([...parentIdsStr, ...descendants])];
}

async function getLocationIdsForScope(db) {
  const locations = await db.collection(LOCATIONS_REAL_COLLECTION).find({}).toArray();
  const ids = callLocationsRecursive(locations, [String(LOCATION_ID)]);
  if (ids.length === 0) {
    console.warn('[Warn] La ubicación no se encontró en locationsReal o no tiene descendientes. Se usará solo el ID indicado.');
    return [String(LOCATION_ID)];
  }
  return ids;
}

// ── Helpers (igual que backfill-all) ──
function isMeaningfulValue(v) {
  if (!v) return false;
  const s = String(v).trim().toLowerCase();
  if (!s) return false;
  const placeholders = new Set([
    's/m', 's\\m', 's.m', 's/n', 's\\n', 's.n', 'na', 'n/a', 'n.a.',
    'sin marca', 'sin modelo', 'no aplica', 'no aplica.', 'no aplica a',
    'sin dato', 'sd', '-', '--', '---', 'x',
  ]);
  if (placeholders.has(s)) return false;
  const compact = s.replace(/\s+/g, '');
  if (compact === 's/m' || compact === 's/n' || compact === 'sm' || compact === 'sn') return false;
  return true;
}

function buildEmbeddingText(asset) {
  const parts = [];
  if (isMeaningfulValue(asset.name)) parts.push(String(asset.name).trim());
  if (isMeaningfulValue(asset.brand)) parts.push(String(asset.brand).trim());
  if (isMeaningfulValue(asset.model)) parts.push(String(asset.model).trim());
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryable(err) {
  const status = err?.status || err?.response?.status;
  return status === 429 || (status >= 500 && status <= 599) || err?.code === 'ETIMEDOUT' || err?.code === 'ECONNRESET';
}

async function getEmbeddingsBatch(texts, { maxRetries = 5 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      const options = { model: EMBEDDING_MODEL, input: texts };
      if (Number.isFinite(EMBEDDING_DIMENSIONS) && EMBEDDING_DIMENSIONS > 0) {
        options.dimensions = EMBEDDING_DIMENSIONS;
      }
      const response = await openai.embeddings.create(options);
      return response.data.map((d) => d.embedding);
    } catch (err) {
      attempt++;
      if (!isRetryable(err) || attempt > maxRetries) throw err;
      const backoff = Math.min(30000, 1000 * Math.pow(2, attempt - 1));
      console.warn(`[Retry] OpenAI (attempt ${attempt}/${maxRetries}): ${err.message}. Backoff ${backoff}ms`);
      await sleep(backoff);
    }
  }
}

function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

async function main() {
  const client = new MongoClient(MONGO_URI);

  try {
    await client.connect();
    console.log('[MongoDB] Conectado');

    const db = client.db(DB_NAME);
    const collection = db.collection(ASSETS_COLLECTION);

    const locationIds = await getLocationIdsForScope(db);
    console.log(`[Info] Ubicaciones en alcance (padre + hijas): ${locationIds.length}`);

    // Assets con location en esa lista. Campo location puede ser string o ObjectId.
    const validOids = locationIds.filter((id) => /^[a-fA-F0-9]{24}$/.test(id)).map((id) => new ObjectId(id));
    const locationQuery =
      validOids.length > 0
        ? { $or: [{ location: { $in: locationIds } }, { location: { $in: validOids } }] }
        : { location: { $in: locationIds } };
    const pendingQuery = { ...locationQuery };
    if (!REFRESH) {
      pendingQuery.textEmbedding = { $exists: false };
      pendingQuery.embeddingSkipReason = { $exists: false };
    }

    const totalPending = await collection.countDocuments(pendingQuery);
    const totalInScope = await collection.countDocuments(locationQuery);

    console.log(`[Info] Assets en esta ubicación (y hijas): ${totalInScope}`);
    console.log(`[Info] Assets a procesar (sin embedding${REFRESH ? ' o todos si --refresh' : ''}): ${totalPending}`);
    console.log(`[Info] Batch size: ${BATCH_SIZE}`);

    if (DRY_RUN) {
      console.log('[Dry Run] No se realizarán cambios. Saliendo.');
      return;
    }

    if (totalPending === 0) {
      console.log('[Info] No hay assets pendientes en esta ubicación. Nada que hacer.');
      return;
    }

    const startTime = Date.now();
    let processed = 0;
    let errors = 0;
    let skipped = 0;
    let batchNumber = 0;

    while (true) {
      batchNumber++;
      const assets = await collection
        .find(pendingQuery, { projection: { _id: 1, name: 1, brand: 1, model: 1 } })
        .sort({ _id: 1 })
        .limit(BATCH_SIZE)
        .toArray();

      if (assets.length === 0) break;

      console.log(`\n── Batch ${batchNumber} (${assets.length} assets) ──`);

      const toEmbed = [];
      const toSkip = [];

      for (const asset of assets) {
        const embeddingText = buildEmbeddingText(asset);
        if (!isMeaningfulValue(asset.name)) {
          toSkip.push(asset);
        } else {
          toEmbed.push({ _id: asset._id, embeddingText });
        }
      }

      if (toSkip.length > 0) {
        const skipOps = toSkip.map((a) => ({
          updateOne: {
            filter: { _id: a._id },
            update: {
              $set: {
                embeddingSkipReason: 'missing_name',
                embeddingVersion: 1,
                embeddingUpdatedAt: new Date(),
              },
            },
          },
        }));
        await collection.bulkWrite(skipOps, { ordered: false });
        skipped += toSkip.length;
      }

      if (toEmbed.length === 0) continue;

      let embeddings;
      try {
        embeddings = await getEmbeddingsBatch(toEmbed.map((x) => x.embeddingText));
      } catch (err) {
        console.error(`[Error] OpenAI batch ${batchNumber}: ${err.message}`);
        errors += toEmbed.length;
        continue;
      }

      const now = new Date();
      const ops = toEmbed
        .map((item, i) => {
          const emb = embeddings[i];
          if (!emb) {
            errors++;
            return null;
          }
          return {
            updateOne: {
              filter: { _id: item._id },
              update: {
                $set: {
                  embeddingText: item.embeddingText,
                  textEmbedding: emb,
                  embeddingVersion: 1,
                  embeddingUpdatedAt: now,
                },
                $unset: { embeddingSkipReason: '' },
              },
            },
          };
        })
        .filter(Boolean);

      if (ops.length > 0) {
        await collection.bulkWrite(ops, { ordered: false });
        processed += ops.length;

        const elapsed = Date.now() - startTime;
        const rate = processed / Math.max(1, elapsed / 1000);
        const remaining = Math.max(0, totalPending - processed - skipped - errors);
        const eta = remaining > 0 ? formatTime((remaining / rate) * 1000) : '—';
        console.log(
          `  [Progreso] ${processed}/${totalPending} | ${errors} errores | ${skipped} omitidos | ${rate.toFixed(1)}/s | ETA: ${eta}`
        );
      }
    }

    const elapsed = Date.now() - startTime;
    console.log('\n════════════════════════════════════════');
    console.log(`  Completado en ${formatTime(elapsed)}`);
    console.log(`  Procesados: ${processed}`);
    console.log(`  Errores:    ${errors}`);
    console.log(`  Omitidos:   ${skipped}`);
    console.log('════════════════════════════════════════');
  } catch (err) {
    console.error('[Fatal]', err.message);
    process.exit(1);
  } finally {
    await client.close();
    console.log('[MongoDB] Conexión cerrada');
  }
}

main();
