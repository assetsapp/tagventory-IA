/**
 * Concilia un archivo Excel completo: crea un job, lo procesa, hace conciliación automática y deja los resultados.
 *
 * Uso:
 *   node scripts/reconcile-excel.js "/ruta/al/archivo.xlsx"
 *   node scripts/reconcile-excel.js "/ruta/al/archivo.xlsx" --sheet=0
 *   node scripts/reconcile-excel.js "/ruta/al/archivo.xlsx" --location=675a09bf7fecb101a9e86dd4
 *   node scripts/reconcile-excel.js "/ruta/al/archivo.xlsx" --min-score=0.85
 *   node scripts/reconcile-excel.js "/ruta/al/archivo.xlsx" --no-auto   # solo sugerencias, sin conciliación automática
 *
 * Requisitos:
 *   - .env con MONGO_URI, DB_NAME, OPENAI_API_KEY (y opcional EMBEDDING_MODEL, EMBEDDING_DIMENSIONS)
 *   - El Excel debe tener una columna de descripción (auto-detectada o primera columna)
 *
 * Al terminar imprime el jobId para ver/exportar en la app o GET /ai/reconciliation/job/:jobId/export
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const args = process.argv.slice(2);
const filePath = args.find((a) => !a.startsWith('--'));
const sheetArg = args.find((a) => a.startsWith('--sheet='));
const locationArg = args.find((a) => a.startsWith('--location='));
const descriptionColArg = args.find((a) => a.startsWith('--description-column='));
const minScoreArg = args.find((a) => a.startsWith('--min-score='));
const noAuto = args.includes('--no-auto');

if (!filePath || !filePath.trim()) {
  console.error('Uso: node scripts/reconcile-excel.js "/ruta/al/archivo.xlsx" [--sheet=0] [--location=ID] [--description-column=nombre] [--min-score=0.70] [--no-auto]');
  process.exit(1);
}

const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
if (!fs.existsSync(resolvedPath)) {
  console.error('[Error] Archivo no encontrado:', resolvedPath);
  process.exit(1);
}

const sheetIndex = sheetArg != null ? Number(sheetArg.split('=')[1]) : undefined;
const locationId = locationArg ? locationArg.split('=')[1]?.trim() : null;
const descriptionColumn = descriptionColArg ? descriptionColArg.split('=')[1]?.trim() : undefined;
const DEFAULT_MIN_SCORE = 0.7; // más recall para conciliación automática por defecto
const minScore = minScoreArg != null
  ? Math.max(0, Math.min(1, Number(minScoreArg.split('=')[1]) || DEFAULT_MIN_SCORE))
  : DEFAULT_MIN_SCORE;

async function main() {
  // Importaciones dinámicas para que dotenv ya haya cargado
  const { connectMongo } = await import('../src/config/mongo.js');
  const { readExcelToJson } = await import('../src/services/files.service.js');
  const { createJob, processJob, autoReconcileJob, getJobAllRows } = await import('../src/services/reconciliation-job.service.js');

  console.log('[1/5] Conectando a MongoDB...');
  await connectMongo();

  console.log('[2/5] Leyendo Excel:', resolvedPath);
  const buffer = fs.readFileSync(resolvedPath);
  const { rows, totalRows, sheetName } = readExcelToJson(buffer, {
    sheetIndex,
    descriptionColumn: descriptionColumn || undefined,
  });

  if (!rows.length) {
    console.error('[Error] No se encontraron filas en el Excel. Revisa la hoja o la columna de descripción.');
    process.exit(1);
  }

  console.log(`      Filas leídas: ${totalRows} (hoja: ${sheetName})`);

  const locationFilterIds = locationId ? [locationId] : null;
  if (locationFilterIds) console.log('      Filtro ubicación:', locationId);

  console.log('[3/5] Creando job de conciliación...');
  const { jobId, totalRows: jobTotal } = await createJob(rows, locationFilterIds);
  console.log(`      Job creado: ${jobId} (${jobTotal} filas)`);

  console.log('[4/5] Procesando job (sugerencias por fila; puede tardar varios minutos)...');
  const start = Date.now();
  await processJob(jobId);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`      Procesado en ${elapsed}s`);

  let autoMatched = 0;
  if (!noAuto) {
    console.log(`[5/5] Conciliación automática (umbral ≥ ${(minScore * 100).toFixed(0)}%)...`);
    const result = await autoReconcileJob(jobId, minScore);
    autoMatched = result.autoMatched ?? 0;
    console.log(`      Filas conciliadas automáticamente: ${autoMatched}`);
  } else {
    console.log('[5/5] Omitido (--no-auto). Solo se generaron sugerencias.');
  }

  const job = await getJobAllRows(jobId);
  const withSuggestions = (job.rows || []).filter((r) => r.suggestions?.length > 0).length;
  const withMatch = (job.rows || []).filter((r) => r.decision === 'match').length;
  console.log('\n════════════════════════════════════════');
  console.log('  Job completado');
  console.log('  jobId:', jobId);
  console.log('  Filas con sugerencias:', withSuggestions, '/', job.totalRows);
  console.log('  Filas con match:', withMatch);
  if (!noAuto) console.log('  Conciliación automática:', autoMatched, 'filas');
  console.log('  Ver en la app o: GET /ai/reconciliation/job/' + jobId);
  console.log('  Export Excel: GET /ai/reconciliation/job/' + jobId + '/export');
  console.log('════════════════════════════════════════\n');

  const { getClient } = await import('../src/config/mongo.js');
  const client = getClient();
  if (client) await client.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('[Fatal]', err.message);
  process.exit(1);
});
