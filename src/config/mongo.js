import { MongoClient } from 'mongodb';
import { env } from './env.js';

let client = null;
let db = null;

export async function connectMongo() {
  if (client) return { client, db };

  client = new MongoClient(env.MONGO_URI);
  await client.connect();
  db = client.db(env.DB_NAME);

  return { client, db };
}

export function getDb() {
  return db;
}

export function getClient() {
  return client;
}

export async function pingMongo() {
  if (!db) throw new Error('MongoDB no conectado');
  return db.command({ ping: 1 });
}
