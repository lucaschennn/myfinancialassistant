import type { Metadata } from 'next';
// Clerk 7 replaced <SignedIn>/<SignedOut> with a single <Show when=…>.
import { ClerkProvider, Show, UserButton } from '@clerk/nextjs';
import './globals.css';

export const metadata: Metadata = {
  title: 'Personal Finance Guru',
  description: 'Transparent, grounded financial guidance over your real accounts.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>
          <div className="shell">
            <header className="topbar">
              <div className="brand">
                Jolly <span>personal finance guru</span>
              </div>
              <Show when="signed-in">
                <UserButton />
              </Show>
            </header>
            {children}
            {/*
              The §6 standing disclaimer. It lives in the layout rather than in
              any prompt so it cannot be talked out of existence by a model, and
              it is present on every page for the same reason.
            */}
            <p className="disclaimer">
              Jolly is an educational tool, not a licensed financial advisor. It explains and
              contextualises your own data; it does not give personalised financial advice.
            </p>
          </div>
        </body>
      </html>
    </ClerkProvider>
  );
}
