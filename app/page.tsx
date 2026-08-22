import { redirect } from 'next/navigation';

// ---------------------------------------------------------------------
// `/` redirects to `/home`.
//
// The old root was the entire single-page terminal — `TradingSidebar` with ten
// collapsible groups mounting 31 operator panels. That file, and the four legacy
// routes it linked to (`/log`, `/log/[id]`, `/audit`, `/glassbox`, `/backtest`),
// are deleted: every panel they hosted is now mounted on the new route whose
// subject it belongs to, via `components/operator/`. Nothing was dropped —
// `components/operator/OperatorSection.tsx` records why they were relocated rather
// than reimplemented.
//
// A REDIRECT RATHER THAN A DELETION. Deleting `app/page.tsx` would make `/` a 404,
// and `/` is the URL people have bookmarked and the one a bare host name resolves
// to. `redirect()` is server-side, so it costs no client render and leaves no
// flash of an empty page.
// ---------------------------------------------------------------------

export default function RootPage() {
  redirect('/home');
}
