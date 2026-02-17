/**
 * Script para generar embeddings de TODOS los assets que no los tengan.
 *
 * Uso:
 *   node scripts/backfill-all.js
 *   node scripts/backfill-all.js --batch=200
 *   node scripts/backfill-all.js --dry-run
 *
 * Características:
 *   - Procesa en batches configurables (default 100)
 *   - Reiniciable: solo toma assets sin textEmbedding
 *   - Muestra progreso en tiempo real
 *   - Reintenta una vez si OpenAI falla en un asset
 *   - Log de errores sin cortar el proceso
 *   - Cierra la conexión MongoDB al finalizar
 */

import { MongoClient } from 'mongodb';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

// ── Config ──────────────────────────────────
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.DB_NAME;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EMBEDDING_MODEL = 'text-embedding-3-small';
const COLLECTION = 'assets';

// Parse CLI args
const args = process.argv.slice(2);
const BATCH_SIZE = Number(args.find((a) => a.startsWith('--batch='))?.split('=')[1]) || 100;
const DRY_RUN = args.includes('--dry-run');

if (!Number.isFinite(BATCH_SIZE) || BATCH_SIZE < 1) {
  console.error('[Error] --batch debe ser un número >= 1');
  process.exit(1);
}
if (BATCH_SIZE > 500) {
  console.warn('[Warn] Batch size > 500 puede causar errores/rate limits. Se recomienda <= 200.');
}

if (!MONGO_URI || !DB_NAME || !OPENAI_API_KEY) {
  console.error('[Error] Faltan variables de entorno: MONGO_URI, DB_NAME, OPENAI_API_KEY');
  console.error('Asegúrate de tener un .env en la carpeta backend/');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });


function isMeaningfulValue(v) {
  if (!v) return false;
  const s = String(v).trim().toLowerCase();
  if (!s) return false;

  // Common placeholders in inventories
  const placeholders = new Set([
    's/m', 's\\m', 's.m',
    's/n', 's\\n', 's.n',
    'na', 'n/a', 'n.a.',
    'sin marca', 'sin modelo',
    'no aplica', 'no aplica.',
    'no aplica a',
    'sin dato', 'sd',
    '-', '--', '---',
    'x',
  ]);
  if (placeholders.has(s)) return false;

  // Also treat short variants like "s m" / "s n" as placeholders
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
  // OpenAI SDK may expose status on err.status
  return status === 429 || (status >= 500 && status <= 599) || err?.code === 'ETIMEDOUT' || err?.code === 'ECONNRESET';
}

async function getEmbeddingsBatch(texts, { maxRetries = 5 } = {}) {
  // texts: string[]
  let attempt = 0;
  while (true) {
    try {
      const response = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: texts,
      });
      // Ensure same order
      return response.data.map((d) => d.embedding);
    } catch (err) {
      attempt++;
      if (!isRetryable(err) || attempt > maxRetries) throw err;
      const backoff = Math.min(30000, 1000 * Math.pow(2, attempt - 1));
      console.warn(`[Retry] OpenAI batch failed (attempt ${attempt}/${maxRetries}): ${err.message}. Backoff ${backoff}ms`);
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
    const collection = db.collection(COLLECTION);

    const totalPending = await collection.countDocuments({ textEmbedding: { $exists: false } });
    const totalAll = await collection.countDocuments({});

    console.log(`[Info] Assets totales: ${totalAll}`);
    console.log(`[Info] Assets sin embedding: ${totalPending}`);
    console.log(`[Info] Batch size: ${BATCH_SIZE}`);

    if (DRY_RUN) {
      console.log('[Dry Run] No se realizarán cambios. Saliendo.');
      return;
    }

    if (totalPending === 0) {
      console.log('[Info] Todos los assets ya tienen embedding. Nada que hacer.');
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
        .find(
          { textEmbedding: { $exists: false }, embeddingSkipReason: { $exists: false } },
          { projection: { name: 1, brand: 1, model: 1 } }
        )
        .sort({ _id: 1 })
        .limit(BATCH_SIZE)
        .toArray();

      if (assets.length === 0) break;

      console.log(`\n── Batch ${batchNumber} (${assets.length} assets) ──`);

      // Build texts for embedding (only for assets with non-empty name string)
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

      // Mark skipped so we don't re-scan them forever
      if (toSkip.length > 0) {
        const skipOps = toSkip.map((a) => ({
          updateOne: {
            filter: { _id: a._id, textEmbedding: { $exists: false } },
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

      if (toEmbed.length === 0) {
        continue;
      }

      // Batch call to OpenAI (significantly faster than per-asset calls)
      let embeddings;
      try {
        embeddings = await getEmbeddingsBatch(toEmbed.map((x) => x.embeddingText));
      } catch (err) {
        console.error(`[Error] OpenAI batch failed for batch ${batchNumber}: ${err.message}`);
        errors += toEmbed.length;
        continue;
      }

      const now = new Date();
      const ops = [];

      for (let i = 0; i < toEmbed.length; i++) {
        const { _id, embeddingText } = toEmbed[i];
        const embedding = embeddings[i];

        if (!embedding) {
          errors++;
          continue;
        }

        ops.push({
          updateOne: {
            // Conditional filter makes this script safe to re-run and prevents race updates
            filter: { _id, textEmbedding: { $exists: false } },
            update: {
              $set: {
                embeddingText,
                textEmbedding: embedding,
                embeddingVersion: 1,
                embeddingUpdatedAt: now,
              },
              $unset: { embeddingSkipReason: '' },
            },
          },
        });
      }

      if (ops.length > 0) {
        const res = await collection.bulkWrite(ops, { ordered: false });
        const modified = res?.modifiedCount ?? 0;
        processed += modified;

        // progress every batch
        const elapsed = Date.now() - startTime;
        const rate = processed / Math.max(1, elapsed / 1000);
        const remaining = Math.max(0, totalPending - processed - skipped - errors);
        const eta = remaining > 0 ? formatTime((remaining / rate) * 1000) : '—';
        console.log(
          `  [Progreso] ${processed}/${totalPending} procesados | ` +
          `${errors} errores | ${skipped} omitidos | ` +
          `${rate.toFixed(1)} assets/s | ETA: ${eta}`
        );
      }
    }

    const elapsed = Date.now() - startTime;

    console.log('\n════════════════════════════════════════');
    console.log(`  Completado en ${formatTime(elapsed)}`);
    console.log(`  Procesados: ${processed}`);
    console.log(`  Errores:    ${errors}`);
    console.log(`  Omitidos:   ${skipped} (sin name; marcados con embeddingSkipReason)`);
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
