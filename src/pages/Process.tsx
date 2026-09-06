import { Link } from "react-router-dom";
import { Icon } from "../components/Icon";
import { Heading, Reveal, Tag } from "../components/ui";
import { PROCESS, waLink } from "../data";
import EvidenceChain from "../components/EvidenceChain";
import { Redact } from "../components/Redact";
import { Seo } from "../components/Seo";

export default function Process() {
  return (
    <>
    <Seo route="/process" />
      <section className="relative pt-32 pb-24 lg:pt-40">
        <div className="pointer-events-none absolute inset-0 bg-grid opacity-50" />
        <div className="pointer-events-none absolute inset-0 bg-radial-navy" />
  
        <div className="relative mx-auto max-w-[1320px] px-5 lg:px-8">
          <nav className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide-2 text-mute">
            <Link to="/" className="hover:text-gold-2">Home</Link>
            <Icon name="chevron-right" size={12} className="text-gold-2/60" />
            <span className="text-gold-2">Our Process</span>
          </nav>
  
          <div className="mt-6 flex flex-col items-start justify-between gap-6 lg:flex-row lg:items-end">
            <Heading
              as="h1"
              eyebrow={`Methodology · ${PROCESS.length} stages`}
              title={<>The <Redact>investigation</Redact><br /><span className="italic text-gold-gradient">lifecycle.</span></>}
            />
            <Reveal delay={100}>
              <div className="flex items-center gap-3">
                <span className="font-mono text-[10px] uppercase tracking-wide-2 text-mute">
                  {PROCESS.length} stages · intake to reporting
                </span>
              </div>
            </Reveal>
          </div>
  
          <EvidenceChain />

        {/* Assurance banner */}
          <Reveal delay={100}>
            <div className="plate mt-14 grid items-center gap-6 overflow-hidden rounded-lg p-7 sm:grid-cols-[auto_1fr_auto] sm:p-8">
              <div className="grid h-24 w-24 place-items-center rounded-full border border-gold-2/50 bg-ink/60">
                <Icon name="gavel" size={46} className="text-gold-2" />
              </div>
              <p className="max-w-2xl text-stone">
                We deliver clear, credible and evidence-based reports that help you make <span className="text-gold-2">informed decisions</span> with confidence.
              </p>
              <a href={waLink()} target="_blank" rel="noreferrer" className="gold-btn sheen-host flex items-center gap-2 rounded-sm px-6 py-3 text-[12px] uppercase">
                How We Work <Icon name="arrow" size={16} />
              </a>
            </div>
          </Reveal>
  
          <Reveal delay={100}>
            <div className="mt-14 flex flex-wrap items-center justify-center gap-3">
              <Tag>Confidential</Tag><Tag>Evidence-led</Tag><Tag>Court-ready</Tag><Tag>End-to-end</Tag>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}
