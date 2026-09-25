import PDFDocument from "pdfkit";
import { formatAmount, formatDate, type CasePack } from "@cac/core";
import type { CompanyDetails } from "./invoice-pdf";

/**
 * The case preparation pack as a PDF.
 *
 * This is the document somebody takes into a meeting, and the way it is arranged is the
 * whole argument of Phase 11:
 *
 * **The gaps are in the body, not an appendix.** What is missing and what contradicts
 * itself come after the inventory and before the signature, on the same footing as
 * everything else. A pack that showed only the complete parts would read as a finished
 * matter, and somebody would act on it.
 *
 * **Every figure names its basis and its source, and every requirement names the rule and
 * the authority behind it.** A reader who wants to know where RM 480,000 came from, or why
 * a land title search is on the list, can read it off the page rather than asking.
 *
 * **The caveats are printed on it**, not put in a covering email that gets detached. In
 * particular: a short checklist means no approved rule covers the point, not that nothing
 * is required.
 *
 * Built-in Helvetica only, so nothing depends on fonts being installed, and laid out in
 * points from the top with an explicit page-break check before each block — a table that
 * reflows is a table that overlaps its own footer.
 */

const PAGE_MARGIN = 48;
const PAGE_WIDTH = 595.28; // A4 portrait
const PAGE_HEIGHT = 841.89;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const BOTTOM = PAGE_HEIGHT - PAGE_MARGIN - 40;

export async function renderCasePackPdf(
  pack: CasePack,
  company: CompanyDetails,
): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  let y = PAGE_MARGIN;

  /** Moves to a new page when the next block would not fit. */
  const room = (needed: number) => {
    if (y + needed > BOTTOM) {
      doc.addPage();
      y = PAGE_MARGIN;
    }
  };

  const heading = (text: string) => {
    room(34);
    y += 10;
    doc.fontSize(11).font("Helvetica-Bold").fillColor("#0f172a").text(text, PAGE_MARGIN, y);
    y += 15;
    doc
      .moveTo(PAGE_MARGIN, y)
      .lineTo(PAGE_WIDTH - PAGE_MARGIN, y)
      .lineWidth(0.6)
      .strokeColor("#c9ced6")
      .stroke();
    y += 8;
  };

  const paragraph = (text: string, options: { size?: number; colour?: string; gap?: number } = {}) => {
    const size = options.size ?? 9;
    const height = doc.fontSize(size).font("Helvetica").heightOfString(text, { width: CONTENT_WIDTH });
    room(height + 4);
    doc.fillColor(options.colour ?? "#22272f").text(text, PAGE_MARGIN, y, { width: CONTENT_WIDTH });
    y += height + (options.gap ?? 3);
  };

  const line = (
    label: string,
    value: string,
    options: { note?: string | null; strong?: boolean } = {},
  ) => {
    const labelWidth = 150;
    const valueWidth = CONTENT_WIDTH - labelWidth;
    const height = Math.max(
      doc.fontSize(9).font("Helvetica").heightOfString(value || "—", { width: valueWidth }),
      11,
    );
    room(height + (options.note ? 12 : 0) + 4);

    doc.fontSize(9).font("Helvetica").fillColor("#5b6472").text(label, PAGE_MARGIN, y, {
      width: labelWidth - 8,
    });
    doc
      .font(options.strong ? "Helvetica-Bold" : "Helvetica")
      .fillColor("#22272f")
      .text(value || "—", PAGE_MARGIN + labelWidth, y, { width: valueWidth });
    y += height + 1;

    if (options.note) {
      const noteHeight = doc
        .fontSize(8)
        .font("Helvetica")
        .heightOfString(options.note, { width: valueWidth });
      doc.fillColor("#7a838f").text(options.note, PAGE_MARGIN + labelWidth, y, {
        width: valueWidth,
      });
      y += noteHeight + 2;
    }
    y += 2;
  };

  // ---- Header ---------------------------------------------------------------
  doc.fontSize(14).font("Helvetica-Bold").fillColor("#0f172a").text(company.name, PAGE_MARGIN, y);
  y += 18;
  if (company.address) {
    doc.fontSize(8).font("Helvetica").fillColor("#5b6472").text(company.address, PAGE_MARGIN, y, {
      width: CONTENT_WIDTH * 0.6,
    });
    y += 22;
  }

  doc.fontSize(16).font("Helvetica-Bold").fillColor("#0f172a").text("Case preparation pack", PAGE_MARGIN, y);
  y += 22;
  doc
    .fontSize(9)
    .font("Helvetica")
    .fillColor("#5b6472")
    .text(
      `${pack.caseNo} · prepared ${formatDate(pack.preparedOn)} by ${pack.preparedBy}`,
      PAGE_MARGIN,
      y,
    );
  y += 18;

  // ---- What this is, and is not --------------------------------------------
  heading("What this document is");
  for (const caveat of pack.caveats) {
    paragraph(`• ${caveat}`, { size: 8, colour: "#5b6472" });
  }

  // ---- The matter -----------------------------------------------------------
  heading("The matter");
  line("Title", pack.title);
  line("Kind of matter", pack.matterType);
  line("Status", pack.status);
  line("Deceased", pack.deceasedName);
  line("Date of death", pack.dateOfDeath ? formatDate(pack.dateOfDeath) : "not recorded");
  line("Court reference", pack.courtReference ?? "none recorded");

  // ---- The people -----------------------------------------------------------
  heading(`The people in the matter (${pack.parties.length})`);
  if (pack.parties.length === 0) {
    paragraph("Nobody is recorded.", { colour: "#8a5a00" });
  }
  for (const party of pack.parties) {
    line(party.role, `${party.name}${party.relationship ? ` — ${party.relationship}` : ""}`, {
      note:
        (party.share ? `Stated entitlement: ${party.share} (per ${party.shareSource})` : null) ??
        (party.status === "verified" ? "verified" : "as reported, not verified"),
    });
  }

  // ---- The inventory --------------------------------------------------------
  heading(`What the estate holds (${pack.assets.length})`);
  if (pack.assets.length === 0) paragraph("No assets are recorded.", { colour: "#8a5a00" });
  for (const asset of pack.assets) {
    line(
      asset.category,
      `${asset.description}${asset.figure ? ` — RM ${asset.figure}` : " — no figure"}`,
      {
        note: asset.basis
          ? `${asset.basis}; from ${asset.source}. ${asset.status === "verified" ? "Verified." : "As reported."}`
          : asset.status === "verified"
            ? "Verified; no figure recorded."
            : "As reported; no figure recorded.",
      },
    );
  }

  heading(`What the estate owes (${pack.liabilities.length})`);
  if (pack.liabilities.length === 0) {
    paragraph("No liabilities are recorded. Worth confirming rather than assuming.", {
      colour: "#8a5a00",
    });
  }
  for (const liability of pack.liabilities) {
    line(
      liability.category,
      `${liability.creditor}${liability.figure ? ` — RM ${liability.figure}` : " — no figure"}`,
      {
        note: liability.basis
          ? `${liability.basis}; from ${liability.source}. ${
              liability.status === "verified" ? "Verified." : "As reported."
            }`
          : "No figure recorded.",
      },
    );
  }

  heading("The position, so far");
  line("Assets recorded", `RM ${formatAmount(pack.position.assetTotal)}`, { strong: true });
  line("Liabilities recorded", `RM ${formatAmount(pack.position.liabilityTotal)}`, { strong: true });
  line("Net", `RM ${formatAmount(pack.position.net)}`, { strong: true });
  paragraph(pack.positionNote, {
    size: 8,
    colour: pack.position.incomplete ? "#8a5a00" : "#5b6472",
  });

  // ---- The checklist --------------------------------------------------------
  heading(`What the matter requires (${pack.requirements.length})`);
  if (pack.requirements.length === 0) {
    paragraph(
      "Nothing. No requirement rule has been approved that covers this kind of matter, so no checklist has been produced. That is an absence of rules, not an absence of requirements.",
      { colour: "#8a5a00" },
    );
  }
  for (const item of pack.requirements) {
    line(item.status, item.title, {
      note: [
        item.rule ? `From rule ${item.rule}` : "Added by hand; no authority recorded",
        item.authority ? `authority: ${item.authority}` : null,
        item.note,
        item.undecided.length > 0
          ? `Cannot be decided until: ${item.undecided.join(", ")}`
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }

  // ---- The gaps -------------------------------------------------------------
  heading(`What is missing (${pack.gaps.length})`);
  if (pack.gaps.length === 0) paragraph("Nothing the platform can see.");
  for (const gap of pack.gaps) {
    line(gap.severity.replace(/_/g, " "), gap.what, {
      note: gap.blocks ? `Holds up: ${gap.blocks}` : null,
    });
  }

  heading(`What to check (${pack.contradictions.length})`);
  if (pack.contradictions.length === 0) {
    paragraph("Nothing recorded contradicts anything else recorded.");
  }
  for (const contradiction of pack.contradictions) {
    line("check", contradiction.what, { note: contradiction.check });
  }

  if (pack.openQuestions.length > 0) {
    heading(`Still to ask (${pack.openQuestions.length})`);
    for (const question of pack.openQuestions) {
      line(
        question.blocks > 0 ? `blocks ${question.blocks}` : "no rule waiting",
        question.label,
      );
    }
  }

  // ---- Footer on every page -------------------------------------------------
  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    doc
      .fontSize(7)
      .font("Helvetica")
      .fillColor("#7a838f")
      .text(
        `${pack.caseNo} — case preparation pack — prepared ${formatDate(pack.preparedOn)} — ` +
          `CAC internal working document, not advice and not a filing — ` +
          `page ${index - range.start + 1} of ${range.count}`,
        PAGE_MARGIN,
        PAGE_HEIGHT - PAGE_MARGIN - 18,
        { width: CONTENT_WIDTH, align: "center" },
      );
  }

  doc.end();
  return finished;
}
