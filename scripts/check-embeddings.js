/**
 * Diagnóstico: verifica que haya embeddings y que el índice/alcance coincidan.
 * Uso: node scripts/check-embeddings.js [--location=675a09bf7fecb101a9e86dd4]
 */

import { MongoClient, ObjectId } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.DB_NAME;
const ASSETS_COLLECTION = 'assets';
const LOCATIONS_REAL_COLLECTION = 'locationsReal';

const args = process.argv.slice(2);
const locationArg = args.find((a) => a.startsWith('--location='));
const LOCATION_ID = locationArg ? locationArg.split('=')[1]?.trim() : null;

if (!MONGO_URI || !DB_NAME) {
  console.error('[Error] MONGO_URI y DB_NAME en .env');
  process.exit(1);
}

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

async function main() {
  const client = new MongoClient(MONGO_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const assets = db.collection(ASSETS_COLLECTION);

    const totalAssets = await assets.countDocuments({});
    const withEmbedding = await assets.countDocuments({ textEmbedding: { $exists: true } });
    const withLocation = await assets.countDocuments({ location: { $exists: true, $ne: null } });

    console.log('\n=== Colección assets ===');
    console.log('  Total documentos:', totalAssets);
    console.log('  Con textEmbedding:', withEmbedding);
    console.log('  Con location no vacía:', withLocation);

    if (withEmbedding > 0) {
      const sample = await assets.findOne({ textEmbedding: { $exists: true } }, { projection: { textEmbedding: 1 } });
      const dims = sample?.textEmbedding?.length;
      console.log('  Dimensiones del vector (muestra):', dims ?? 'N/A');
    }

    if (LOCATION_ID) {
      const locations = await db.collection(LOCATIONS_REAL_COLLECTION).find({}).toArray();
      const locationIds = callLocationsRecursive(locations, [String(LOCATION_ID)]);
      console.log('\n=== Alcance ubicación', LOCATION_ID, '===');
      console.log('  IDs en árbol (padre + hijas):', locationIds.length);

      const validOids = locationIds.filter((id) => /^[a-fA-F0-9]{24}$/.test(id)).map((id) => new ObjectId(id));
      const locationQuery =
        validOids.length > 0
          ? { $or: [{ location: { $in: locationIds } }, { location: { $in: validOids } }] }
          : { location: { $in: locationIds } };

      const inScope = await assets.countDocuments(locationQuery);
      const inScopeWithEmbedding = await assets.countDocuments({
        ...locationQuery,
        textEmbedding: { $exists: true },
      });
      console.log('  Assets en esta ubicación (y hijas):', inScope);
      console.log('  De esos, con textEmbedding:', inScopeWithEmbedding);
    }

    console.log('\n=== Índice vectorial (Atlas) ===');
    console.log('  Nombre esperado: assets_text_embedding_index');
    console.log('  path: textEmbedding, numDimensions debe coincidir con EMBEDDING_DIMENSIONS en .env (ej. 1536)');
    console.log('  Si restauraste la DB, recrea el índice en Atlas Search si no existe.\n');
  } catch (err) {
    console.error('[Fatal]', err.message);
    process.exit(1);
  } finally {
    await client.close();
  }
}

main();
