/**
 * Upload File Controller
 * Recibe archivos (Excel) por multipart/form-data, lee el contenido
 * y devuelve un JSON con las columnas necesarias para conciliación.
 */

import { readExcelToJson } from '../services/files.service.js';

/**
 * POST /ai/files/upload/excel
 * Body: multipart/form-data con campo "file" (archivo .xlsx o .xls)
 * Response: { rows: [{ rowNumber, sapDescription, sapLocation }], totalRows }
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

        const result = readExcelToJson(file.buffer, {
            sheetIndex: 0,
            skipRows: 0,
        });

        res.json({
            status: 'ok',
            fileName: file.originalname,
            totalRows: result.totalRows,
            rows: result.rows,
        });
    } catch (error) {
        console.error('[upload/excel]', error.message);
        res.status(500).json({
            status: 'error',
            message: error.message || 'Error al leer el archivo Excel',
        });
    }
}
