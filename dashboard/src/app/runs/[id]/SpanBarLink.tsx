"use client";

/**
 * SpanBarLink — clickable span bar that opens the inspector.
 *
 * WHY NOT <Link> (Phase 4 inspector fix):
 *   Next.js 14 router cache can serve stale RSC payloads when only searchParams
 *   change on the same pathname. Using <Link onClick={router.refresh()}> fires
 *   refresh() BEFORE the Link navigation commits the new URL, so refresh() ends
 *   up re-fetching the OLD URL (without ?span=) and spanDetail stays null.
 *
 *   Fix: use router.push() + router.refresh() called synchronously. Both are
 *   queued in the same render cycle; the App Router processes push first (URL
 *   changes to the new ?span=), then refresh re-fetches that new URL so
 *   page.tsx re-runs getSpanDetail() with the correct span ID.
 *
 *   Data still flows through getSpanDetail() in halley-query/ — no API route.
 */

import { useRouter } from "next/navigation";
import { useTransition } from "react";

interface Props {
  href:      string;
  title:     string;
  className: string;
  style:     React.CSSProperties;
  children:  React.ReactNode;
}

export function SpanBarLink({ href, title, className, style, children }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <a
      href={href}
      title={title}
      className={[className, isPending ? "opacity-70" : ""].filter(Boolean).join(" ")}
      style={style}
      onClick={(e) => {
        e.preventDefault();
        startTransition(() => {
          router.push(href, { scroll: false });
          router.refresh();
        });
      }}
    >
      {children}
    </a>
  );
}
