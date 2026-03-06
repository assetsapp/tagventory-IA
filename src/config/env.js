import dotenv from 'dotenv';

dotenv.config();

const required = ['MONGO_URI', 'DB_NAME', 'OPENAI_API_KEY'];
const missing = required.filter((key) => !process.env[key]);

if (missing.length > 0) {
  console.error(`[env] Faltan variables requeridas: ${missing.join(', ')}`);
  process.exit(1);
}

export const env = {
  PORT: process.env.PORT || 3000,
  MONGO_URI: process.env.MONGO_URI,
  DB_NAME: process.env.DB_NAME,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  // Modelo de embeddings (por defecto, el de mayor calidad actual)
  EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || 'text-embedding-3-large',
  // Dimensiones del vector para el índice de MongoDB (por defecto 1536 para compatibilidad)
  EMBEDDING_DIMENSIONS: process.env.EMBEDDING_DIMENSIONS
    ? Number(process.env.EMBEDDING_DIMENSIONS)
    : 1536,
};
