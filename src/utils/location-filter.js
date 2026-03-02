/**
 * Filtro de ubicación: ubicación seleccionada + todas las hijas y subhijas
 * (colección locationsReal, campo location en assets; mismo criterio que la web/Baas).
 */

const LOCATIONS_REAL_COLLECTION = 'locationsReal';
const ASSETS_LOCATION_FIELD = 'location';

/**
 * Expande IDs de ubicación padre a padre + todos los descendientes.
 * @param {Array<{ _id: any, parent?: string }>} allLocations - Documentos de locationsReal
 * @param {string[]} parentIds - IDs de ubicaciones raíz a expandir
 * @param {string[]} acc - Acumulador (uso interno)
 * @returns {string[]} parentIds + todos los descendientes (sin duplicados)
 */
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

/**
 * Filtro MongoDB por IDs de ubicación (padre + todas las hijas y subhijas).
 * @param {import('mongodb').Db} db - Conexión a la base (misma que assets)
 * @param {string[]} locationFilterIds - IDs de ubicación seleccionados (padres)
 * @returns {Promise<object|null>} { [ASSETS_LOCATION_FIELD]: { $in: ids } } o null
 */
export async function getLocationMatchFromIds(db, locationFilterIds) {
  if (!db || !Array.isArray(locationFilterIds) || locationFilterIds.length === 0) return null;
  const ids = locationFilterIds.map((id) => String(id)).filter(Boolean);
  if (ids.length === 0) return null;

  const locations = await db.collection(LOCATIONS_REAL_COLLECTION).find({}).toArray();
  const locationIdsToFetch = callLocationsRecursive(locations, ids);
  if (locationIdsToFetch.length === 0) return null;

  return { [ASSETS_LOCATION_FIELD]: { $in: locationIdsToFetch } };
}
