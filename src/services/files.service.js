/**
 * Excel Service
 * Lee archivos Excel (.xlsx, .xls) y devuelve un JSON con las columnas
 * necesarias para conciliación: rowNumber, sapDescription, sapLocation.
 */

import * as XLSX from 'xlsx';

// Nombres de cabecera (sin acentos, minúsculas) que mapean a cada campo
const DESCRIPTION_KEYS = [
  'descripcion', 'descripción', 'activo', 'nombre', 'sap', 'texto', 'material', 'denominacion',
  'description', 'name', 'asset', 'sap description'
];
const LOCATION_KEYS = [
  'ubicacion', 'ubicación', 'centro', 'location', 'lugar', 'sede', 'centro de costo', 'cebe'
];

function normalizeHeader(str) {
  if (typeof str !== 'string') return '';
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/\u0300/g, '')
    .trim();
}

function findColumnIndex(headers, keys) {
  for (let i = 0; i < headers.length; i++) {
    const h = normalizeHeader(String(headers[i] ?? ''));
    if (keys.some((k) => h.includes(k) || k.includes(h))) return i;
  }
  return -1;
}

/**
 * Parsea un buffer de Excel y devuelve filas con columnas normalizadas.
 * @param {Buffer} buffer - Contenido del archivo Excel
 * @param {Object} options - { sheetIndex: 0, skipRows: 0 }
 * @returns {{ rows: Array<{ rowNumber: number, sapDescription: string, sapLocation: string }>, totalRows: number }}
 */
export function readExcelToJson(buffer, options = {}) {
  const { sheetIndex = 0, skipRows = 0 } = options;

  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[sheetIndex];
  if (!sheetName) {
    throw new Error('La hoja del Excel no existe');
  }

  const sheet = workbook.Sheets[sheetName];
  const raw = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
    raw: false,
  });

  if (!raw.length) {
    return { rows: [], totalRows: 0 };
  }

  const headerRowIndex = Math.min(skipRows, raw.length - 1);
  const headers = raw[headerRowIndex].map((h) => (h != null ? String(h) : ''));
  const dataStartIndex = headerRowIndex + 1;

  const descIdx = findColumnIndex(headers, DESCRIPTION_KEYS);
  const locIdx = findColumnIndex(headers, LOCATION_KEYS);

  const rows = [];
  for (let i = dataStartIndex; i < raw.length; i++) {
    const row = raw[i];
    if (!Array.isArray(row)) continue;

    const sapDescription = descIdx >= 0 && row[descIdx] != null ? String(row[descIdx]).trim() : '';
    const sapLocation = locIdx >= 0 && row[locIdx] != null ? String(row[locIdx]).trim() : '';

    rows.push({
      rowNumber: i - dataStartIndex + 1,
      sapDescription,
      sapLocation,
    });
  }

  return {
    rows,
    totalRows: rows.length,
  };
}
