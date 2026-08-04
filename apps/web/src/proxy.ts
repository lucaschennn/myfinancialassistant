/**
 * Route protection (§9). Everything is private by default — a financial app
 * should not have an "oops, that page was public" failure mode — so the matcher
 * lists what is *open* rather than what is closed.
 *
 * This is a gate, not the isolation boundary. It decides whether a request is
 * signed in at all; `requireCtx()` decides whose data it may touch (§3).
 *
 * Named `proxy.ts`, not `middleware.ts`: Next 16 renamed the convention and
 * warns on the old filename. The export shape is unchanged.
 */

import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isPublicRoute = createRouteMatcher([
  '/sign-in(.*)',
  '/sign-up(.*)',
  // Plaid webhooks authenticate by signature, not by session (§9), so they
  // cannot carry a Clerk cookie. Verification happens inside the handler.
  '/api/plaid/webhook',
]);

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Skip Next internals and static files unless they appear in search params.
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
