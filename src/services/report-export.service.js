/**
 * Servicio de exportación de reportes de conciliación a Excel.
 * Genera un libro con: descripción SAP + datos del activo que hizo match, o "Not found".
 */

import * as XLSX from 'xlsx';

const NOT_FOUND = 'Not found';

/**
 * Para una fila del job, obtiene los datos del activo elegido (match) o null.
 * selectedAssetId puede venir como ObjectId o string desde MongoDB.
 */
function getMatchedSuggestion(row) {
  if (row.decision !== 'match' || !row.selectedAssetId) return null;
  const idStr = row.selectedAssetId?.toString?.() ?? String(row.selectedAssetId);
  const suggestions = row.suggestions || [];
  const found = suggestions.find((s) => (s.assetId?.toString?.() ?? String(s.assetId)) === idStr);
  return found || null;
}

/**
 * Genera la matriz de filas para la hoja Excel del reporte de un job.
 */
function buildSheetData(job) {
  const headers = [
    'Fila',
    'Descripción SAP',
    'Ubicación SAP',
    'Estado',
    'Nombre (activo)',
    'Marca',
    'Modelo',
    'EPC',
    'Ubicación (Tagventory)',
    'Probabilidad %',
  ];
  const rows = [headers];

  for (const row of job.rows || []) {
    const matched = getMatchedSuggestion(row);
    const state = matched ? 'Match' : NOT_FOUND;
    const nombre = matched ? (matched.name || '') : '';
    const marca = matched ? (matched.brand || '') : '';
    const modelo = matched ? (matched.model || '') : '';
    const epc = matched ? (matched.EPC || '') : '';
    const ubicacionTag = matched ? (matched.locationPath || '') : '';
    const probPct =
      matched && typeof matched.score === 'number'
        ? Math.round(Math.max(0, Math.min(1, matched.score)) * 100)
        : '';

    rows.push([
      row.rowNumber,
      row.sapDescription || '',
      row.sapLocation || '',
      state,
      nombre,
      marca,
      modelo,
      epc,
      ubicacionTag,
      probPct,
    ]);
  }

  return rows;
}

/**
 * Genera el buffer del archivo Excel para el reporte del job.
 * @param {object} job - Job con rows (getJobAllRows)
 * @returns {Buffer}
 */
export function buildJobReportExcel(job) {
  const data = buildSheetData(job);
  const ws = XLSX.utils.aoa_to_sheet(data);

  const colWidths = [
    { wch: 6 },
    { wch: 45 },
    { wch: 20 },
    { wch: 10 },
    { wch: 30 },
    { wch: 15 },
    { wch: 20 },
    { wch: 22 },
    { wch: 25 },
    { wch: 14 },
  ];
  ws['!cols'] = colWidths;

  const wb = XLSX.utils.book_new();
  const sheetName = `Reporte ${job.jobId?.toString?.()?.slice(-8) ?? 'job'}`;
  XLSX.utils.book_append_sheet(wb, ws, sheetName);

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return Buffer.from(buffer);
}
