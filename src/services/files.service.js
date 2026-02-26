/**
 * Excel Service
 * Lee archivos Excel (.xlsx, .xls) y devuelve un JSON con las columnas
 * necesarias para conciliación: rowNumber, sapDescription, sapLocation.
 * Soporta: hoja por nombre o índice, auto-detección de fila de cabecera,
 * y búsqueda dinámica de columna de descripción por nombre.
 */

import * as XLSX from 'xlsx';

// Nombres de cabecera que mapean a descripción (posición y nombre pueden variar)
const DESCRIPTION_KEYS = [
  'descripcion', 'descripción', 'descripcion del activo fijo', 'activo fijo', 'activo',
  'nombre', 'sap', 'texto', 'material', 'denominacion', 'description', 'name', 'asset',
  'sap description', 'descripcion activo',
];
const LOCATION_KEYS = [
  'ubicacion', 'ubicación', 'centro', 'location', 'lugar', 'sede', 'centro de costo', 'cebe',
  'centro de costos', 'nom ced', 'nom cecd',
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
 * Obtiene los nombres de las hojas del archivo Excel.
 */
export function getSheetNames(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  return workbook.SheetNames;
}

function getSheet(workbook, options) {
  const { sheetName, sheetIndex = 0 } = options;

  if (sheetName != null && String(sheetName).trim()) {
    const name = String(sheetName).trim();
    const found = workbook.SheetNames.find(
      (s) => normalizeHeader(s) === normalizeHeader(name)
    );
    if (found) return found;
  }

  const byIndex = workbook.SheetNames[sheetIndex];
  if (!byIndex) {
    throw new Error(`La hoja no existe (índice ${sheetIndex}). Hojas disponibles: ${workbook.SheetNames.join(', ')}`);
  }
  return byIndex;
}

function detectHeaderRow(raw, maxScan = 20) {
  for (let r = 0; r < Math.min(maxScan, raw.length); r++) {
    const row = raw[r];
    if (!Array.isArray(row)) continue;

    const headers = row.map((h) => (h != null ? String(h) : ''));
    if (findColumnIndex(headers, DESCRIPTION_KEYS) >= 0) {
      return r;
    }
  }
  return 0;
}

/**
 * Obtiene las columnas (cabeceras) de una hoja para que el usuario elija cuál usar.
 */
export function getSheetColumns(buffer, options = {}) {
  const { sheetIndex, sheetName, skipRows } = options;

  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const resolvedSheetName = getSheet(workbook, { sheetName, sheetIndex });

  const sheet = workbook.Sheets[resolvedSheetName];
  const raw = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
    raw: false,
  });

  if (!raw.length) {
    return { rawPreviewRows: [], maxCols: 0, sheetName: resolvedSheetName };
  }

  const maxCols = Math.max(...raw.filter(Array.isArray).map((r) => r.length), 1);
  const previewRowCount = 20;
  const rawPreviewRows = [];
  for (let i = 0; i < Math.min(previewRowCount, raw.length); i++) {
    const row = raw[i];
    if (Array.isArray(row)) {
      const cells = [];
      for (let c = 0; c < maxCols; c++) {
        cells.push(row[c] != null ? String(row[c]) : '');
      }
      rawPreviewRows.push(cells);
    }
  }

  return {
    sheetName: resolvedSheetName,
    rawPreviewRows,
    maxCols,
  };
}

function resolveDescriptionColumnIndex(headers, descriptionColumn) {
  if (descriptionColumn == null) return findColumnIndex(headers, DESCRIPTION_KEYS);

  const idx = Number(descriptionColumn);
  if (!Number.isNaN(idx) && idx >= 0 && idx < headers.length) return idx;

  const name = String(descriptionColumn).trim();
  const found = headers.findIndex((h) => normalizeHeader(String(h ?? '')) === normalizeHeader(name));
  return found >= 0 ? found : headers.findIndex((h) =>
    normalizeHeader(String(h ?? '')).includes(normalizeHeader(name))
  );
}

/**
 * Parsea un buffer de Excel y devuelve filas con columnas normalizadas.
 * @param {Buffer} buffer - Contenido del archivo Excel
 * @param {Object} options
 * @param {number} [options.sheetIndex=0] - Índice de la hoja (0-based)
 * @param {string} [options.sheetName] - Nombre de la hoja (prioridad sobre sheetIndex)
 * @param {number} [options.skipRows] - Filas a saltar hasta la cabecera. Si no se indica, se auto-detecta
 * @param {string|number} [options.descriptionColumn] - Nombre o índice de la columna de descripción (búsqueda)
 * @returns {{ rows, totalRows, sheetName, headerRowIndex }}
 */
export function readExcelToJson(buffer, options = {}) {
  const { sheetIndex, sheetName, skipRows, descriptionColumn } = options;

  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const resolvedSheetName = getSheet(workbook, { sheetName, sheetIndex });

  const sheet = workbook.Sheets[resolvedSheetName];
  const raw = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
    raw: false,
  });

  if (!raw.length) {
    return { rows: [], totalRows: 0, sheetName: resolvedSheetName };
  }

  // skipRows = índice de la fila seleccionada como encabezado (0-based). La fila siguiente es la primera de datos.
  const headerRowIndex =
    skipRows != null ? Math.min(Number(skipRows) || 0, raw.length - 1) : detectHeaderRow(raw);
  const headers = raw[headerRowIndex].map((h) => (h != null ? String(h) : ''));
  const dataStartIndex = headerRowIndex + 1; // primera fila de datos (rowNumber 1)

  const descIdx = resolveDescriptionColumnIndex(headers, descriptionColumn);
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
    sheetName: resolvedSheetName,
    headerRowIndex,
  };
}
