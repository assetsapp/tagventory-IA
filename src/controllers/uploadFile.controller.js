/**
 * Upload File Controller
 * Recibe archivos (Excel) por multipart/form-data, lee el contenido
 * y devuelve un JSON con las columnas necesarias para conciliación.
 */

import { readExcelToJson, getSheetNames, getSheetColumns } from '../services/files.service.js';

/**
 * POST /ai/files/upload/excel
 * Body: multipart/form-data con campo "file" (archivo .xlsx o .xls)
 * Opcionales: sheetName, sheetIndex, skipRows, descriptionColumn
 *   - descriptionColumn: nombre o índice de la columna para búsqueda (obligatorio si hay sheet)
 * Response: { rows, totalRows } | needSheetSelection | needColumnSelection
 */
export async function postUploadExcel(req, res) {
    try {
        const file = req.file;
        if (!file || !file.buffer) {
            return res.status(400).json({
                status: 'error',
                message: 'Se requiere un archivo Excel (campo "file")',
            });
        }

        const opts = req.body || req.query || {};
        const sheetName = opts.sheetName ?? opts.sheet_name;
        const sheetIndex = opts.sheetIndex != null ? Number(opts.sheetIndex) : undefined;
        const skipRows = opts.skipRows != null ? Number(opts.skipRows) : undefined;
        const descriptionColumn = opts.descriptionColumn ?? opts.description_column;

        const sheets = getSheetNames(file.buffer);

        if (sheets.length >= 2 && !sheetName && sheetIndex == null) {
            return res.json({
                status: 'ok',
                needSheetSelection: true,
                sheets,
                fileName: file.originalname,
            });
        }

        if (!descriptionColumn) {
            const { rawPreviewRows, maxCols, sheetName: resolvedSheet } = getSheetColumns(file.buffer, {
                sheetName: sheetName || undefined,
                sheetIndex,
            });
            return res.json({
                status: 'ok',
                needColumnSelection: true,
                rawPreviewRows,
                maxCols,
                sheetName: resolvedSheet,
                fileName: file.originalname,
            });
        }

        const result = readExcelToJson(file.buffer, {
            sheetName: sheetName || undefined,
            sheetIndex,
            skipRows,
            descriptionColumn: descriptionColumn || undefined,
        });

        res.json({
            status: 'ok',
            fileName: file.originalname,
            totalRows: result.totalRows,
            rows: result.rows,
            sheetName: result.sheetName,
            headerRowIndex: result.headerRowIndex,
        });
    } catch (error) {
        console.error('[upload/excel]', error.message);
        res.status(500).json({
            status: 'error',
            message: error.message || 'Error al leer el archivo Excel',
        });
    }
}
