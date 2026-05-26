"use client";

/**
 * SpanBarLink — thin Client Component wrapper for the clickable span bar.
 *
 * WHY THIS EXISTS (Phase 4 Day 1 inspector fix):
 *   Next.js 14 router cache (RSC payload cache) serves stale payloads when
 *   only searchParams change on the same pathname. Clicking a span bar updates
 *   ?span=<hex> but the router cache intercepts the navigation and returns the
 *   cached Server Component payload where spanDetail is still null.
 *
 *   Fix: call router.refresh() in the onClick handler. This invalidates the
 *   RSC cache for the current route and triggers a fresh server re-render,
 *   so page.tsx re-runs getSpanDetail() and spanDetail is populated.
 *
 *   NOT an API route — the data still flows through getSpanDetail() in
 *   halley-query/ (D-12). The Link href and all other behaviour are unchanged.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";

interface Props {
  href:      string;
  title:     string;
  className: string;
  style:     React.CSSProperties;
  children:  React.ReactNode;
}

export function SpanBarLink({ href, title, className, style, children }: Props) {
  const router = useRouter();

  return (
    <Link
      href={href}
      title={title}
      className={className}
      style={style}
      onClick={() => router.refresh()}
    >
      {children}
    </Link>
  );
}
