import { Router } from 'express';
import { analyticsHandler } from '@/handlers/analytics.handler';
import { requireAuth } from '@/middleware/auth';

const router = Router({ mergeParams: true });

router.use(requireAuth);

// GET /projects/:projectId/analytics/summary               — Pages / SEO Fixes / Schemas / Ranked cards
// GET /projects/:projectId/analytics/performance-overview   — aggregated clicks & impressions, ?days=14
// GET /projects/:projectId/analytics/top-movers             — keywords whose position improved, ?limit=5
// GET /projects/:projectId/analytics/keyword-performance     — latest ranking snapshot per keyword, ?page=1&limit=20
//
// NOTE: GEO metrics (Share of Voice / Citation Rate / Mention Rate) and
// the Rewrite Queue are NOT here — they already have working endpoints
// (geo.route.ts, optimization.route.ts respectively) that the frontend
// Analytics page calls directly. See analytics.service.ts's header
// comment for why this isn't a single monolithic "give me the whole
// page" endpoint.
router.get('/summary',                analyticsHandler.getSummaryCards);
router.get('/performance-overview',   analyticsHandler.getPerformanceOverview);
router.get('/top-movers',             analyticsHandler.getTopMovers);
router.get('/keyword-performance',    analyticsHandler.getKeywordPerformance);

export default router;
