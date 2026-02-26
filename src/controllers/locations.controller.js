/**
 * Controlador de ubicaciones.
 * Expone las ubicaciones (locationPath) de los activos para filtros padre-hijo.
 */

import { getDb } from '../config/mongo.js';

const ASSETS_COLLECTION = 'assets';

/**
 * GET /ai/locations
 *
 * Devuelve la lista de ubicaciones distintas (locationPath) de los activos,
 * ordenadas para poder usarlas en un selector (padre a hijo).
 * Incluye rutas completas y permite agrupar por jerarquía en el frontend.
 */
export async function getLocations(req, res) {
  try {
    const db = getDb();
    if (!db) throw new Error('MongoDB no conectado');

    const locations = await db
      .collection(ASSETS_COLLECTION)
      .distinct('locationPath', { locationPath: { $exists: true, $ne: '' } });

    const sorted = [...locations].filter(Boolean).sort((a, b) => a.localeCompare(b, 'es'));

    res.json({ locations: sorted });
  } catch (err) {
    console.error('[locations]', err.message);
    res.status(500).json({
      status: 'error',
      message: 'Error al obtener ubicaciones',
    });
  }
}
