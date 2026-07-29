import { Router } from 'express';
import { gscOAuthHandler } from '@/handlers/gsc-oauth.handler';

// No requireAuth — both routes are plain browser redirects that Google
// itself navigates the user through. /connect authenticates the JWT
// passed as a query param manually (see handler); /callback trusts the
// signed `state` param instead, since it comes straight from Google with
// no user-supplied auth at all.
const router = Router();

router.get('/connect',  gscOAuthHandler.start);
router.get('/callback', gscOAuthHandler.callback);

export default router;
