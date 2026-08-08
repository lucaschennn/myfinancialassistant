'use client';

/**
 * Primary navigation (§8 Phase 1.5-C).
 *
 * Until now one page held the dashboard, chat, and settings, which left nowhere
 * to put net worth history, per-account detail, or goals — all of which the
 * backend has been computing or storing without a surface to show them on.
 *
 * A client component only because the active link needs the current path.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Summary' },
  { href: '/history', label: 'History' },
  { href: '/accounts', label: 'Accounts' },
  { href: '/goals', label: 'Goals' },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="nav">
      {LINKS.map((link) => {
        // `/` would otherwise match every path.
        const active = link.href === '/' ? pathname === '/' : pathname.startsWith(link.href);
        return (
          <Link className={active ? 'nav-link active' : 'nav-link'} href={link.href} key={link.href}>
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
