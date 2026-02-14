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
};
