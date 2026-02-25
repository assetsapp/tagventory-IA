import { Router } from 'express';
import multer from 'multer';
import { postEmbedding, postBackfillSample, postSearchAssets } from '../controllers/ai.controller.js';
import {
  postReconciliationSuggestions,
  postCreateJob,
  postProcessJob,
  getJob,
  postDecision,
  getJobsList,
  getJobExport,
  deleteJobController,
} from '../controllers/reconciliation.controller.js';
import { getLocations } from '../controllers/locations.controller.js';
import { postUploadExcel } from '../controllers/uploadFile.controller.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// Todas las rutas de /ai requieren JWT
router.use(authMiddleware);

router.post('/embedding', postEmbedding);
router.post('/assets/backfill-sample', postBackfillSample);
router.post('/search/assets', postSearchAssets);
router.get('/locations', getLocations);

// Conciliación
router.post('/reconciliation/suggestions', postReconciliationSuggestions);
router.post('/reconciliation/job', postCreateJob);
router.post('/reconciliation/job/:jobId/process', postProcessJob);
router.get('/reconciliation/job/:jobId', getJob);
router.post('/reconciliation/job/:jobId/decision', postDecision);
router.get('/reconciliation/jobs', getJobsList);
router.get('/reconciliation/job/:jobId/export', getJobExport);
router.delete('/reconciliation/job/:jobId', deleteJobController);

// files
router.post('/files/upload/excel', upload.single('file'), postUploadExcel);

export default router;
