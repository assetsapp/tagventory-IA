/**
 * Construye el texto de embedding de un activo para el MVP de conciliación.
 * Solo usa name + brand + model. El texto se normaliza: trim y colapso de espacios.
 */
export function buildAssetEmbeddingText(asset) {
  const raw = [
    asset.name || '',
    asset.brand || '',
    asset.model || '',
  ].join(' ');

  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * Normaliza un texto libre: trim y colapso de espacios múltiples.
 */
export function normalizeText(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}
