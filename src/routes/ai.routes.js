import { Router } from 'express';
import { postEmbedding, postBackfillSample, postSearchAssets } from '../controllers/ai.controller.js';
import {
  postReconciliationSuggestions,
  postCreateJob,
  postProcessJob,
  getJob,
  postDecision,
} from '../controllers/reconciliation.controller.js';

const router = Router();

router.post('/embedding', postEmbedding);
router.post('/assets/backfill-sample', postBackfillSample);
router.post('/search/assets', postSearchAssets);

// Conciliación
router.post('/reconciliation/suggestions', postReconciliationSuggestions);
router.post('/reconciliation/job', postCreateJob);
router.post('/reconciliation/job/:jobId/process', postProcessJob);
router.get('/reconciliation/job/:jobId', getJob);
router.post('/reconciliation/job/:jobId/decision', postDecision);

export default router;
