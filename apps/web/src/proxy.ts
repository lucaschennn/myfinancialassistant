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

export default clerkMiddleware(
  async (auth, request) => {
    if (!isPublicRoute(request)) {
      await auth.protect();
    }
  },
  {
    /**
     * Clerk's default tolerance between its clock and ours is 5s. A machine
     * whose clock has drifted further than that rejects every token Clerk
     * issues with `token-iat-in-the-future`, and because the rejection triggers
     * a refresh that issues another equally-future token, the sign-in turns
     * into an infinite redirect loop. Clerk's own second error message blames
     * mismatched instance keys, which is a red herring — the keys are fine.
     *
     * The tell is that a manual reload fixes it: by then enough wall-clock time
     * has passed for the cookie's `iat` to no longer be ahead of us.
     *
     * Widening the window is not the real fix — a drifted clock should be
     * corrected at the OS (see docs/STATE.md) — but a dev machine that has
     * skipped an NTP sync should degrade into a slightly stale token rather
     * than into an unrecoverable loop on first load. 30s is chosen to absorb
     * ordinary drift while staying far short of the session token's own
     * lifetime, so the extra grace this grants an *expired* token is
     * immaterial.
     */
    clockSkewInMs: 30_000,
  },
);

export const config = {
  matcher: [
    // Skip Next internals and static files unless they appear in search params.
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
