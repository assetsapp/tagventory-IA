import { Router } from 'express';
import { postEmbedding } from '../controllers/ai.controller.js';

const router = Router();

router.post('/embedding', postEmbedding);

export default router;
