/**
 * Utilidad para filtro de ubicación (padre e hijos).
 * Si locationPath es "Sede/Edificio A/Piso 1", al elegir "Sede" se incluyen
 * "Sede", "Sede/Edificio A", "Sede/Edificio A/Piso 1", etc.
 */

function escapeRegex(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Construye el filtro MongoDB para ubicación (padre + hijos).
 * @param {string} locationFilter - Ubicación seleccionada
 * @returns {object|null} Condición $match o null si no hay filtro
 */
export function buildLocationMatch(locationFilter) {
  if (!locationFilter || typeof locationFilter !== 'string') return null;
  const trimmed = locationFilter.trim();
  if (!trimmed) return null;
  const escaped = escapeRegex(trimmed);
  return {
    $or: [
      { locationPath: trimmed },
      { locationPath: { $regex: `^${escaped}/` } },
    ],
  };
}
