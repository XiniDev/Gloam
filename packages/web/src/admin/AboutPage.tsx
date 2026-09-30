import { ChevronRight, Scale } from "lucide-react";
import { get } from "../net/http.ts";
import { LoadPanel, useLoad } from "../ui/Loadable.tsx";
import { Sparkle } from "../ui/ornaments.tsx";

interface About {
  version: string;
  node: string;
  srd: { attribution: string; pack: string; spells: number; matches: boolean };
  sources: { name: string; note: string; license: string; homepage: string }[];
  trademarks: string;
  fonts: { family: string; license: string; text: string }[];
  packages: { name: string; version: string; license: string; author?: string; homepage?: string }[];
  vendored: { name: string; version: string; license: string; author?: string; homepage?: string }[];
}

/**
 * Admin → About & Credits (SPEC §8.20, Appendix I; AC-ADM-05): the version, the SRD 5.2.1 attribution word for word,
 * the other sources the rules content came from, the fonts' licence texts, and every bundled library's licence.
 */
export function AboutPage() {
  const loaded = useLoad(() => get<About>("/api/admin/about"), []);
  const a = loaded.data ?? null;
  return (
    <div className="max-w-[880px]" data-testid="about-page">
      <header>
        <h1 className="flex items-center gap-3 text-36 text-bone">
          <Sparkle size={28} /> Gloam
        </h1>
        <p className="mt-1 text-14 text-muted">
          {a ? `Version ${a.version} · Node ${a.node}` : " "} · a self-hosted tabletop for your group.
        </p>
      </header>
      <LoadPanel load={loaded} what="the credits" />
      {a ? (
        <>
          <section className="panel mt-6 flex flex-col gap-4 p-5 sm:p-6" aria-label="Rules content">
            <h2 className="flex items-center gap-2 text-22 text-bone">
              <Scale size={20} aria-hidden /> Rules content
            </h2>
            <blockquote
              // (Its URLs break anywhere rather than run off a phone: the words stay exactly as the licence has them.)
              className="rounded-[var(--radius-control)] border-l-4 border-brass-deep bg-ink-900 px-4 py-3 text-16 leading-[var(--leading-body)] text-bone [overflow-wrap:anywhere]"
              data-testid="srd-attribution"
            >
              {a.srd.attribution}
            </blockquote>
            <p className="text-14 text-muted">{a.trademarks}</p>
            <ul className="flex flex-col gap-2">
              {a.sources.map((s) => (
                <li key={s.name} className="text-14 [overflow-wrap:anywhere]">
                  <span className="font-bold text-bone">{s.name}</span>{" "}
                  <span className="text-muted">
                    — {s.note} {s.license}.
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <section className="panel mt-6 flex flex-col gap-4 p-5 sm:p-6" aria-label="Fonts">
            <h2 className="text-22 text-bone">Fonts</h2>
            {a.fonts.map((f) => (
              <details
                key={f.family}
                className="group rounded-[var(--radius-control)] border border-line"
                data-testid="font-licence"
              >
                {/* Its own chevron (the browser's ▶ is gone), turning as it opens. */}
                <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-14 text-bone [&::-webkit-details-marker]:hidden">
                  <ChevronRight
                    size={15}
                    className="shrink-0 text-brass transition-transform duration-[var(--dur-fast)] group-open:rotate-90"
                    aria-hidden
                  />
                  <span className="font-bold">{f.family}</span>{" "}
                  <span className="text-muted">· SIL Open Font License 1.1</span>
                </summary>
                <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap border-t border-line px-4 py-3 font-ui text-12 text-muted">
                  {f.text}
                </pre>
              </details>
            ))}
          </section>
          <section className="panel mt-6 flex flex-col gap-3 p-5 sm:p-6" aria-label="Libraries">
            <h2 className="text-22 text-bone">Libraries</h2>
            <p className="text-14 text-muted">
              Gloam is built on these, each under its own licence — {a.packages.length + a.vendored.length} in
              all.
            </p>
            <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2" data-testid="library-licences">
              {[...a.vendored, ...a.packages].map((p) => (
                <li key={`${p.name}@${p.version}`} className="flex min-w-0 items-baseline gap-2 text-13">
                  <span className="truncate text-bone">{p.name}</span>
                  <span className="tabular shrink-0 text-faint">{p.version}</span>
                  <span className="ml-auto shrink-0 text-muted">{p.license}</span>
                </li>
              ))}
            </ul>
          </section>
        </>
      ) : null}
    </div>
  );
}
