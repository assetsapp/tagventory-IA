/**
 * Controlador de ubicaciones.
 * GET /locations/tree: árbol desde locationsReal (ubicación + hijas y subhijas).
 */

import { getDb } from '../config/mongo.js';

const LOCATIONS_REAL_COLLECTION = 'locationsReal';

/**
 * GET /ai/locations/tree
 *
 * Devuelve ubicaciones desde la colección locationsReal (misma que la web).
 * Formato: { locations: [ { id, parentId, name, path } ] } para selector por ID.
 */
export async function getLocationsTree(req, res) {
  try {
    const db = getDb();
    if (!db) throw new Error('MongoDB no conectado');

    const raw = await db.collection(LOCATIONS_REAL_COLLECTION).find({}).toArray();
    const byId = new Map();
    raw.forEach((doc) => {
      byId.set(String(doc._id), {
        id: String(doc._id),
        parentId: doc.parent ? String(doc.parent) : null,
        name: doc.name || String(doc._id),
      });
    });

    function pathFor(id) {
      const node = byId.get(id);
      if (!node) return node?.name ?? id;
      if (!node.parentId || node.parentId === 'root') return node.name;
      const parentPath = pathFor(node.parentId);
      return parentPath ? `${parentPath} / ${node.name}` : node.name;
    }

    const locations = [...byId.values()].map((loc) => ({
      ...loc,
      path: pathFor(loc.id),
    }));

    locations.sort((a, b) => a.path.localeCompare(b.path, 'es'));

    res.json({ locations });
  } catch (err) {
    console.error('[locations/tree]', err.message);
    res.status(500).json({
      status: 'error',
      message: 'Error al obtener árbol de ubicaciones',
    });
  }
}
