import { pingMongo, getDb } from '../config/mongo.js';
import { env } from '../config/env.js';

export async function getHealth(req, res, next) {
  try {
    await pingMongo();
    const db = getDb();
    const dbName = db?.databaseName || env.DB_NAME;

    res.json({
      status: 'ok',
      mongo: 'ok',
      dbName,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      mongo: 'fail',
      message: err.message || 'Error al conectar con MongoDB',
    });
  }
}
