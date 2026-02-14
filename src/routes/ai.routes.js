import { Router } from 'express';
import { postEmbedding, postBackfillSample, postSearchAssets } from '../controllers/ai.controller.js';

const router = Router();

router.post('/embedding', postEmbedding);
router.post('/assets/backfill-sample', postBackfillSample);
router.post('/search/assets', postSearchAssets);

export default router;
