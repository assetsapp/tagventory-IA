import express from 'express';
import { connectMongo } from './config/mongo.js';
import { env } from './config/env.js';
import healthRoutes from './routes/health.routes.js';
import aiRoutes from './routes/ai.routes.js';

const app = express();

app.use(express.json());

app.use('/health', healthRoutes);
app.use('/ai', aiRoutes);

app.use((err, req, res, next) => {
  const message = err.message || 'Error interno del servidor';
  const status = err.status || 500;

  if (status >= 500) {
    console.error('[Error]', message);
  }

  res.status(status).json({
    status: 'error',
    message,
  });
});

async function start() {
  try {
    await connectMongo();
    console.log('[MongoDB] Conectado correctamente');

    app.listen(env.PORT, () => {
      console.log(`[Server] Escuchando en http://localhost:${env.PORT}`);
    });
  } catch (err) {
    console.error('[Startup]', err.message);
    process.exit(1);
  }
}

start();
