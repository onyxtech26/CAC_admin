// Central content database for CAC — all copy, figures and records are verbatim per brief.

export const CONTACT = {
  company: "Conglomerate Appraisal Consultancy",
  short: "CAC",
  sub: "PROPERTY FORENSIC CONSULTATION",
  address: "85-01, Jalan Wira 2, Taman Tan Sri Yaacob, 81300 Skudai, Johor, Malaysia",
  email: "admin@conglomerate4u.com",
  phoneDisplay: "+60 11-5960 1300",
  phoneRaw: "601159601300",
  officePhoneDisplay: "+607 335 0256",
  officePhoneRaw: "6073350256",
  tiktokUrl: "https://www.tiktok.com/@conglomerate41?_r=1&_t=ZS-99btRZ6IaFc",
  site: "www.conglomerate4u.com",
  consultant: "Mr Mohaan",
  consultantRole: "Director",
  techPartner: "Onyxx Tech",
  techPartnerUrl: "https://onyxx-tech.vercel.app/",
  waText:
    "Hello%20CAC%2C%20I%20would%20like%20to%20schedule%20a%20forensic%20consultation%20regarding%20property%20matters%20%2F%20legal%20%2F%20court%20matters%20%2F%20LA%2F%20PROBET%2F%20JKPTG",
};

export const waLink = (extra?: string) =>
  `https://wa.me/${CONTACT.phoneRaw}${extra ? `?text=${encodeURIComponent(extra)}` : `?text=${CONTACT.waText}`}`;

// Consultant roster shown on /contact. `blurb` renders under the name — one
// <p> per entry, so a multi-paragraph bio stays readable instead of running
// together into a single block.
// Leave `phoneDisplay`/`phoneRaw`/`email` off a member to fall back to the consultancy's
// main channels in CONTACT above.
export type TeamMember = {
  name: string;
  role: string;
  img: string;
  blurb: string[];
  phoneDisplay?: string;
  phoneRaw?: string;
  email?: string;
};

export const TEAM: TeamMember[] = [
  {
    name: "Mr Mohaan",
    role: "Director",
    img: "/assets/mohaan-profile.webp",
    blurb: [
      "Our Director holds a Bachelor of Science in Human Development, majoring in Human Resource Management, from University Putra Malaysia (UPM). He has gained diverse professional experience in shipping and logistics, network marketing, business development, and people-oriented services.",
      "Throughout his career, he has worked with people from diverse backgrounds, helping them overcome challenges and achieve their goals. His passion for problem-solving, analytical thinking, and resolving complex issues eventually led him into the field of Property Forensic Investigation.",
    ],
  },
  {
    name: "Mr Shiva",
    role: "Managing Director",
    img: "/assets/team-03.webp",
    blurb: [
      "Our Managing Director holds a qualification in Electro-Mechanical Engineering from Singapore and has extensive experience across various professional fields. Throughout his career, he has developed strong expertise in human relationships, communication, negotiation, and problem-solving.",
      "His involvement in complex family disputes, inheritance matters, and property-related conflicts led him to specialise in Property Forensic Investigation. With 26 years of experience in the field, he has assisted clients in resolving various property and inheritance disputes through investigation, analysis, and practical solutions.",
    ],
  },
  {
    name: "Mr Goku",
    role: "Executive Consultant",
    img: "/assets/team-02.webp",
    blurb: [
      "Our Executive Consultant brings a unique analytical background developed through previous experience in blockchain technology and digital asset intelligence. His expertise includes analysing token white papers, assessing platform legitimacy, examining transaction histories, tracing digital asset movements, and evaluating business structures and portfolios. This experience naturally extends into property forensic investigation, where the same analytical methodology is applied to property ownership, asset tracing, historical transactions, corporate relationships, missing documentation, and complex estate or family property disputes.",
    ],
  },
];

export const TAGLINES = [
  "Uncover The Truth. Protect Your Legacy.",
  "Turning Intelligence Into Evidence",
  "Uncovering Truth. Protecting Legacies. Creating Value.",
  "Discovering the Past • Protecting the Present • Securing the Future",
  "Uncovering the Past. Protecting the Future.",
];

// Descriptor that sits under the PROPERTY FORENSIC heading in the client brief.
export const STRAPLINE = "Discovering the Truth Behind Property Ownership";

export const HERO_STATS = [
  { label: "Years Established", value: 17, suffix: "+", note: "Since 2009", glyph: "clock" },
  { label: "Cases Completed", value: 227, suffix: "+", note: "Closed & delivered", glyph: "doc-seal" },
];

export const PRINCIPLES_HOME = [
  { k: "Documentary Truth", d: "Every conclusion anchored to registry records, colonial grants and court archives — never assumption." },
  { k: "Legacy Protection", d: "We safeguard family estates, heir entitlements and pioneer ownership against erosion and fraud." },
  { k: "Legal Utility", d: "Findings compiled as court-ready evidence portfolios that travel cleanly into litigation and arbitration." },
];

export const WHY_PRINCIPLES = [
  { k: "Evidence First", d: "We lead with documents, not narratives. Each claim is traceable to a registry folio, a probate file or a surveyor cadastral." },
  { k: "Independent & Objective", d: "CAC acts for the truth of the record. No vested interest in the outcome — only in the integrity of the evidence." },
  { k: "Confidential & Professional", d: "Estate matters are intimate. Engagements run under strict confidentiality with disciplined, counsel-grade handling." },
  { k: "End-to-End Support", d: "From the first briefing to the final land-office registration, we remain on the file until the matter is closed." },
];

export const VISION =
  "To become the leading property forensic investigation consultancy, recognised for integrity, accuracy and excellence in resolving property ownership disputes — the consultancy courts, counsel and families call first when ownership must be proven rather than merely asserted.";

export const MISSION =
  "To preserve family legacies, protect property rights, and provide reliable investigative findings that support informed legal and financial decisions.";

// The six mission commitments from the client brief. The final three are marked
// "must add" in the client's own hand and are not optional.
export const MISSION_POINTS = [
  { k: "Protect legitimate property ownership",
    d: "Where a title is contested, we establish who the record actually supports — and give the rightful owner the documentary basis to defend it." },
  { k: "Preserve family inheritance",
    d: "Estates fragment across generations. We reconstruct the line of succession so what a family built is passed on intact rather than lost to ambiguity." },
  { k: "Recover hidden or forgotten assets",
    d: "Parcels lost to acquisition, dormant holdings and undisclosed transfers are traced back to the estate they belong to." },
  { k: "Support courts and legal professionals with reliable evidence",
    d: "Findings are compiled as structured evidence portfolios counsel can work from directly, each claim sourced to the folio, grant or probate file it came from." },
  { k: "Promote transparency in estate administration",
    d: "Every beneficiary sees the same verified record, so distribution proceeds on documented fact rather than on the account of whoever holds the papers." },
  { k: "Deliver independent forensic investigations based on facts",
    d: "We hold no stake in the outcome. Where the record contradicts what a client hoped to find, the report says so." },
];

// Frequently asked questions, per the client brief. The court-admissibility
// answer keeps the brief's hedging deliberately — it is a legal qualification,
// not marketing copy, and should not be strengthened.
export const FAQ = [
  { q: "What is property forensic?",
    a: "Property forensic is the investigation of ownership, legal history and assets relating to land, buildings and estates. It reconstructs how a property came to be held as it is today — through registry entries, historical grants, survey plans, probate files and transfer records — and establishes what the documentary record can, and cannot, support." },
  { q: "Can you investigate missing inherited property?",
    a: "Yes. We trace historical records and ownership changes to identify properties that may have been overlooked or transferred. Ancestral parcels commonly drop out of family knowledge through township development, compulsory acquisition, or an undocumented transfer a generation ago — the registry usually still remembers what the family no longer does." },
  { q: "Can you investigate old land titles?",
    a: "Yes. We research historical records, archived documents and ownership histories where available — including colonial-era grant books, superseded title series and land-office folios that predate computerised records. Where an archive is incomplete, we state that plainly rather than infer around the gap." },
  { q: "Can your reports be used in court?",
    a: "Our reports are prepared to professional standards and may assist legal advisers and courts, subject to the applicable rules of evidence in the relevant jurisdiction. We compile findings with their source documents attached so counsel can put them to the test — but admissibility remains a matter for the court and for the lawyers conducting the matter." },
];

// Client types served, per the client brief.
export const INDUSTRIES = [
  { k: "Law Firms", d: "Registry reconstruction and evidence portfolios for counsel running probate, land and inheritance matters.", g: "scales" },
  { k: "Estate Administrators", d: "Asset identification and beneficiary verification, so an estate is administered on a complete picture.", g: "clipboard-check" },
  { k: "Executors", d: "Independent confirmation of what an estate actually holds before distribution is executed.", g: "doc-seal" },
  { k: "Trustees", d: "Documentary support for trust property, including holdings the trust instrument records only in outline.", g: "shield-alert" },
  { k: "Families", d: "Discreet investigation where inheritance is disputed, undocumented, or has quietly gone missing.", g: "family" },
  { k: "Financial Institutions", d: "Title and ownership verification supporting lending, recovery and collateral review.", g: "coins-stack" },
  { k: "Property Developers", d: "Chain-of-title and encumbrance checks before an acquisition commits capital.", g: "building-uplift" },
  { k: "Corporate Organisations", d: "Verification of corporate landholdings, subsidiary assets and historical transfers.", g: "network" },
  { k: "Government Agencies", d: "Historical ownership research supporting acquisition, compensation and land administration.", g: "map-pin-grid" },
  { k: "Private Clients", d: "Confidential enquiries on a single family home or a multi-property estate, handled end to end.", g: "key-house" },
];

export type Service = {
  id: string;
  no: string;
  title: string;
  short: string;
  scope: string;
  deliverables: string[];
  glyph: string;
  img: string;
  accent: string;
};

export const SERVICES: Service[] = [
  {
    id: "family-estate", no: "01", title: "Family Estate Investigation",
    glyph: "family", img: "/assets/service-family-estate.webp", accent: "ESTATE RECOVERY",
    short: "Resolving complex estate disputes among heirs by tracing hidden assets, verifying beneficiaries, and clarifying distribution paths.",
    scope: "When family estates are contested or lack clear administration, our agents step in. We research family genealogies, identify all lawful beneficiaries (including missing or unnotified heirs), uncover undisclosed or hidden inherited assets, and provide administration support for probate filings.",
    deliverables: [
      "Small estates — single-property matters resolved end to end",
      "Large estates — multi-property, multi-jurisdiction holdings mapped in full",
      "Multiple beneficiaries — entitlements clarified where several parties claim",
      "Missing heirs — lawful beneficiaries traced and formally identified",
      "Disputed ownership — competing claims tested against the documentary record",
      "Estate asset identification — a verified inventory of what the estate holds",
      "Hidden inheritance — undisclosed or forgotten assets brought back into the estate",
      "Estate administration support — probate and distribution filings compiled",
    ],
  },
  {
    id: "property-forensic", no: "02", title: "Property Ownership Investigation",
    glyph: "magnifier-house", img: "/assets/service-ill-forensic.webp", accent: "CORE DISCIPLINE",
    short: "Systematic analysis of land titles, deeds, and historical records to establish true, pioneer ownership and trace succession lines.",
    scope: "We conduct independent property forensic audits by researching historical registry books, colonial grants, surveyor cadastrals, and local archives. Our findings map succession chains, clarify heir validity, and compile evidence packages designed to stand up in judicial and state arbitration processes.",
    deliverables: [
      "Ownership verification — establishing who the current record actually supports",
      "Chain of ownership reconstruction — every transfer from pioneer grant to present folio",
      "Historical ownership research — archived series, superseded titles and grant books",
      "Pioneer ownership investigation — tracing the earliest recorded holder of the land",
      "Land registry searches — certified extracts from the relevant land office",
      "Property transfer verification — confirming each conveyance was validly executed",
      "Boundary investigation — survey plans and cadastrals reconciled against the title",
      "Encroachment investigation — identifying where occupation departs from the record",
    ],
  },
  {
    id: "missing-property", no: "03", title: "Missing Property Investigation",
    glyph: "compass-pin", img: "/assets/case-tower-B50q7XNj.webp", accent: "LOST PARCELS",
    short: "Locating properties lost due to township developments, compulsory government acquisition, or historical zoning changes.",
    scope: "Valuable ancestral land often gets lost in government acquisitions, highway constructions, or township consolidation projects. We trace lost coordinates, audit replacement land allocations, and determine if outstanding compensation funds remain unclaimed by the rightful heirs.",
    deliverables: [
      "Missing land — parcels a family knows of but can no longer locate on any title",
      "Forgotten properties — holdings dropped from family knowledge across generations",
      "Unregistered ownership — entitlement never carried onto the register",
      "Redeveloped land — parcels absorbed into later schemes and re-titled",
      "Government acquisition — compulsory takings traced and documented",
      "Township development — land consolidated into master-planned schemes",
      "Compensation entitlement — unclaimed awards identified and evidenced",
      "Replacement land — substitute allocations located and verified",
    ],
  },
  {
    id: "title-investigation", no: "04", title: "Title and Document Investigation",
    glyph: "doc-seal", img: "/assets/icon-legal.webp", accent: "RECORD RETRIEVAL",
    short: "Locating and verifying missing land titles, Deeds of Gift, wills, court orders, and land registry records.",
    scope: "When original documents are lost, misplaced, or withheld, we retrieve certified copies, explore registry files, search court probate records, and locate legal agreements (SPAs, Wills, Deeds of Gift) to establish formal chains of custody and legal security.",
    deliverables: [
      "Land Titles — lost, damaged or withheld titles located and certified",
      "Deeds of Gift — validity and execution of gifted transfers examined",
      "Wills — testamentary documents retrieved and authenticated",
      "Probate documents — grants and administration files obtained from the court",
      "Sale and Purchase Agreements — recovered and checked against the register",
      "Survey Plans — cadastral plans matched to the title description",
      "Trust documents — instruments governing property held on trust",
      "Court Orders — orders affecting title traced and produced",
    ],
  },
  {
    id: "fraud-investigation", no: "05", title: "Fraud Investigation",
    glyph: "shield-alert", img: "/assets/illustration-forensic.webp", accent: "FORGERY DETECTION",
    short: "Exposing forged signatures, fake deeds, invalid powers of attorney, and fraudulent claims to family properties.",
    scope: "We conduct forensic analyses of questionable property transfers. Our team investigates fraudulent signatures, unauthorized powers of attorney, fake registry entries, and illegal sales, delivering an independent factual report for legal action.",
    deliverables: [
      "Forged land transfers — transfers executed without lawful authority",
      "Fraudulent ownership claims — asserted interests tested against the record",
      "Fake documents — fabricated titles, agreements and supporting papers",
      "Forged signatures — execution examined against known specimens",
      "Illegal property sales — disposals made without the owner's authority",
      "Hidden beneficiaries — parties concealed from the distribution",
      "Asset concealment — holdings deliberately kept off the estate inventory",
      "Misappropriation of estate assets — value diverted from rightful heirs",
    ],
  },
  {
    id: "asset-tracing", no: "06", title: "Asset Tracing",
    glyph: "coins-stack", img: "/assets/illustration-estate.webp", accent: "PORTFOLIO MAPPING",
    short: "Identifying and mapping residential, commercial, agricultural, corporate, and vehicle assets held under small or large estates.",
    scope: "We trace assets from single residential homes to sprawling agricultural plantations, corporate shareholdings, bank funds, and international holdings. Our investigations map out current assets, identify unauthorized transfers, and verify hidden ownership structures.",
    deliverables: [
      "Residential property — homes held directly or through nominees",
      "Commercial buildings — shoplots, offices and income-producing units",
      "Agricultural land — smallholdings and titled agricultural lots",
      "Plantations — estate acreage and associated planting rights",
      "Companies — corporate vehicles holding property on the estate's behalf",
      "Shares — registered shareholdings and beneficial interests",
      "Bank accounts (subject to legal authority) — pursued only where lawfully permitted",
      "Vehicles — registered vehicles and transferable equipment",
      "Luxury assets — high-value chattels forming part of the estate",
      "Investment portfolios — managed holdings and instruments held at death",
    ],
  },
];

export type ProcessStep = {
  no: string; title: string; sub: string; details: string; outputs: string[]; glyph: string; img: string;
  /** Which edge to keep when the panel crops the image. Images with the CAC
   *  wordmark baked into the top-left use "left" so the logo is never trimmed. */
  imgFocus?: "left" | "center";
};

export const PROCESS: ProcessStep[] = [
  { no: "01", title: "Initial Consultation", sub: "Case Briefing", glyph: "chat-user", img: "/assets/process-01-consultation.webp", imgFocus: "left",
    details: "We begin by understanding the client's concerns and reviewing the documents already in hand — establishing the exact scope of property, assets and individuals to be investigated before any work is committed.",
    outputs: [
      "Client concerns understood and case objectives agreed",
      "Available documents reviewed and gaps identified",
      "Confidentiality and engagement terms executed",
    ] },
  { no: "02", title: "Evidence Collection", sub: "Document Gathering", glyph: "clipboard-check", img: "/assets/process-02-evidence.webp", imgFocus: "left",
    details: "We gather relevant records from public authorities, land registries, archives and other lawful sources — deeds, historical maps, wills, probate files and registry entries.",
    outputs: [
      "Land office register searches and title extraction",
      "High Court probate and administration registry records",
      "Historical surveyor maps and boundary records obtained",
    ] },
  { no: "03", title: "Historical Research", sub: "Chain Reconstruction", glyph: "magnifier-fingerprint", img: "/assets/service-ill-forensic.webp",
    details: "We reconstruct the property's ownership history from the earliest available records, tracing back to pioneer owners and checking every transition — sale, inheritance or gift — for validity.",
    outputs: [
      "Pioneer ownership records and original grants verified",
      "Complete chronology of ownership transfers compiled",
      "Subdivision and acquisition history reconstructed",
    ] },
  { no: "04", title: "Verification", sub: "Authenticity Testing", glyph: "doc-seal", img: "/assets/service-forensic-title.webp",
    details: "We verify the authenticity of documents and ownership information, testing each instrument against the issuing authority's record rather than accepting it at face value.",
    outputs: [
      "Document authenticity confirmed against source records",
      "Ownership information cross-checked with the land office",
      "Discrepancies between copy and register flagged",
    ] },
  { no: "05", title: "Asset Tracing", sub: "Estate Mapping", glyph: "coins-stack", img: "/assets/illustration-estate.webp",
    details: "We locate missing or undisclosed assets connected to the estate — from residential and commercial property to plantations, shareholdings, vehicles and investment portfolios.",
    outputs: [
      "Undisclosed and missing assets located",
      "Corporate, plantation and portfolio holdings mapped",
      "Verified estate asset inventory produced",
    ] },
  { no: "06", title: "Forensic Analysis", sub: "Findings Review", glyph: "chart-doc", img: "/assets/case-gavel-bRvLoHQ5.webp",
    details: "We analyse all findings, identify inconsistencies and prepare a chronological timeline — exposing forged documents, unauthorised sales, hidden beneficiaries and irregularities in distribution.",
    outputs: [
      "Signatures, wills and deeds examined for indicators of forgery",
      "Transfer timelines audited for inconsistency",
      "Chronological timeline of the matter prepared",
    ] },
  { no: "07", title: "Reporting", sub: "Evidence Synthesis", glyph: "doc-pen", img: "/assets/cac-building-logo.webp",
    details: "We deliver a detailed investigation report with findings, supporting evidence and recommendations, structured so that legal advisers can work from it directly.",
    outputs: [
      "Detailed investigation report delivered",
      "Evidence binder with certified copies of deeds and titles",
      "Formal findings and recommendations for resolution",
    ] },
];

// Kept in step with SERVICES above — the six blocks in the client's brief.
export const SERVICE_OPTIONS = [
  "Family Estate Investigation",
  "Property Ownership Investigation",
  "Missing Property Investigation",
  "Title and Document Investigation",
  "Fraud Investigation",
  "Asset Tracing",
];

export const NAV = [
  { label: "About Us", to: "/about" },
  { label: "Services", to: "/services" },
  { label: "Our Process", to: "/process" },
  { label: "Why CAC", to: "/why-cac" },
  { label: "Contact", to: "/contact" },
];
