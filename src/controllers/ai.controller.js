import { getTextEmbedding } from '../services/embedding.service.js';

export async function postEmbedding(req, res, next) {
  try {
    const { text } = req.body;

    if (!text || typeof text !== 'string' || text.trim() === '') {
      return res.status(400).json({
        status: 'error',
        message: 'El campo "text" es requerido y no puede estar vacío',
      });
    }

    const { embedding, dims } = await getTextEmbedding(text.trim());
    const preview = embedding.slice(0, 5);

    res.json({
      dims,
      preview,
    });
  } catch (err) {
    next(err);
  }
}
