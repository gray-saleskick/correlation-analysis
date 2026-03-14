import type {
  AppSubmission,
  FinancialRecord,
  CallResultRecord,
  BookingRecord,
  ApplicationQuestion,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface BucketData {
  label: string;
  count: number;
  bookedCount: number;
  showedCount: number;
  closedCount: number;
  emails: string[];
}

export interface GradeBuckets {
  totalGrade: BucketData[];
  appGrade: BucketData[];
  finGrade: BucketData[];
  hasTotalGrade: boolean;
  hasAppGrade: boolean;
  hasFinGrade: boolean;
}

export interface QuestionCorrelation {
  questionTitle: string;
  questionType: string;
  stats: {
    answer: string;
    count: number;
    bookedCount: number;
    showedCount: number;
    closedCount: number;
    grades: number[];
    emails: string[];
  }[];
}

export interface ExportData {
  appTitle: string;
  exportFilename?: string;
  dedupedSubmissions: AppSubmission[];
  bookingByEmail: Map<string, CallResultRecord | BookingRecord>;
  financialByEmail: Map<string, FinancialRecord>;
  questions: ApplicationQuestion[];
  questionCorrelations: QuestionCorrelation[];
  gradeBuckets: GradeBuckets;
  // Summary buckets
  creditScoreBuckets: BucketData[];
  incomeBuckets: BucketData[];
  creditAccessBuckets: BucketData[];
  fundingBuckets: BucketData[];
  daysToBookingBuckets: BucketData[];
  // Granular buckets
  creditScoreBucketsGranular: BucketData[];
  incomeBucketsGranular: BucketData[];
  creditAccessBucketsGranular: BucketData[];
  fundingBucketsGranular: BucketData[];
  daysToBookingBucketsGranular: BucketData[];
  // Totals
  totalSubs: number;
  bookedCount: number;
  showedCount: number;
  closedCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function toDateOnly(dateStr: string): Date {
  const d = new Date(dateStr);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function pctStr(num: number, den: number): string {
  if (den === 0) return "0%";
  return `${Math.round((num / den) * 100)}%`;
}

// ─────────────────────────────────────────────────────────────────────────────
// XLSX Export — Styled with tables, section breaks, hidden gridlines
// ─────────────────────────────────────────────────────────────────────────────

interface SectionGroup {
  category: string;
  rows: { answer: string; count: number; booked: number; showed: number; closed: number }[];
}

function buildSectionGroups(data: ExportData, variant: "summary" | "granular"): SectionGroup[] {
  const groups: SectionGroup[] = [];

  for (const qc of data.questionCorrelations) {
    groups.push({
      category: qc.questionTitle,
      rows: qc.stats.map(s => ({
        answer: s.answer,
        count: s.count,
        booked: s.bookedCount,
        showed: s.showedCount,
        closed: s.closedCount,
      })),
    });
  }

  function addBucketGroup(category: string, buckets: BucketData[]) {
    if (buckets.length === 0) return;
    groups.push({
      category,
      rows: buckets.map(b => ({
        answer: b.label,
        count: b.count,
        booked: b.bookedCount,
        showed: b.showedCount,
        closed: b.closedCount,
      })),
    });
  }

  if (data.gradeBuckets.hasTotalGrade) addBucketGroup("Total Grade", data.gradeBuckets.totalGrade);
  if (data.gradeBuckets.hasAppGrade) addBucketGroup("App Grade", data.gradeBuckets.appGrade);
  if (data.gradeBuckets.hasFinGrade) addBucketGroup("Financial Grade", data.gradeBuckets.finGrade);

  if (variant === "summary") {
    addBucketGroup("Credit Score", data.creditScoreBuckets);
    addBucketGroup("Income", data.incomeBuckets);
    addBucketGroup("Credit Access", data.creditAccessBuckets);
    addBucketGroup("Funding", data.fundingBuckets);
    addBucketGroup("Days to Booking", data.daysToBookingBuckets);
  } else {
    addBucketGroup("Credit Score", data.creditScoreBucketsGranular);
    addBucketGroup("Income", data.incomeBucketsGranular);
    addBucketGroup("Credit Access", data.creditAccessBucketsGranular);
    addBucketGroup("Funding", data.fundingBucketsGranular);
    addBucketGroup("Days to Booking", data.daysToBookingBucketsGranular);
  }

  return groups;
}

function colLetter(idx: number): string {
  if (idx < 26) return String.fromCharCode(65 + idx);
  return String.fromCharCode(65 + Math.floor(idx / 26) - 1) + String.fromCharCode(65 + (idx % 26));
}

function cellRef(col: number, row: number): string {
  return `${colLetter(col)}${row + 1}`;
}

type CellStyle = {
  font?: { bold?: boolean; color?: { rgb: string }; sz?: number };
  fill?: { fgColor: { rgb: string } };
  border?: {
    top?: { style: string; color: { rgb: string } };
    bottom?: { style: string; color: { rgb: string } };
    left?: { style: string; color: { rgb: string } };
    right?: { style: string; color: { rgb: string } };
  };
  alignment?: { horizontal?: string; vertical?: string; wrapText?: boolean };
  numFmt?: string;
};

function setCell(
  ws: Record<string, unknown>,
  col: number,
  row: number,
  value: unknown,
  style?: CellStyle
) {
  const ref = cellRef(col, row);
  const cell: Record<string, unknown> = {};

  if (typeof value === "number") {
    cell.t = "n";
    cell.v = value;
  } else if (value === null || value === undefined || value === "") {
    cell.t = "s";
    cell.v = "";
  } else {
    cell.t = "s";
    cell.v = String(value);
  }

  if (style) {
    cell.s = style;
    if (style.numFmt) cell.z = style.numFmt;
  }
  ws[ref] = cell;
}

const BORDER_THIN = { style: "thin", color: { rgb: "D1D5DB" } };
const BORDER_ALL = { top: BORDER_THIN, bottom: BORDER_THIN, left: BORDER_THIN, right: BORDER_THIN };

const HEADER_STYLE: CellStyle = {
  font: { bold: true, color: { rgb: "FFFFFF" }, sz: 10 },
  fill: { fgColor: { rgb: "4F46E5" } },
  border: BORDER_ALL,
  alignment: { horizontal: "center", vertical: "center" },
};

const SECTION_HEADER_STYLE: CellStyle = {
  font: { bold: true, color: { rgb: "1E293B" }, sz: 11 },
  fill: { fgColor: { rgb: "E0E7FF" } },
  border: BORDER_ALL,
  alignment: { horizontal: "left" },
};

const DATA_STYLE: CellStyle = {
  font: { sz: 10 },
  border: BORDER_ALL,
  alignment: { vertical: "center" },
};

const DATA_STYLE_CENTER: CellStyle = {
  ...DATA_STYLE,
  alignment: { horizontal: "center", vertical: "center" },
};

const PCT_STYLE: CellStyle = {
  ...DATA_STYLE_CENTER,
  numFmt: "0.0%",
};

function setFormula(
  ws: Record<string, unknown>,
  col: number,
  row: number,
  formula: string,
  style?: CellStyle
) {
  const ref = cellRef(col, row);
  const cell: Record<string, unknown> = { t: "n", f: formula };
  if (style) {
    cell.s = style;
    if (style.numFmt) cell.z = style.numFmt;
  }
  ws[ref] = cell;
}

export async function exportXlsx(data: ExportData): Promise<void> {
  const XLSX = await import("xlsx-js-style");
  const wb = XLSX.utils.book_new();

  const subSheetName = "Submissions";

  // ── Tab 1: Submissions ──────────────────────────────────
  const questionTitles = data.questions.map(q => q.title);
  const subHeaders = [
    "Email", "Name", "Answer Grade", "Financial Grade", "Application Grade",
    "Booked", "Show", "Closed", "App Date", "Booking Date", "Days to Booking",
    "Credit Score", "Estimated Income", "Credit Access", "Access to Funding",
    ...questionTitles,
  ];

  const ws1: Record<string, unknown> = {};
  const totalCols1 = subHeaders.length;

  // Write headers
  for (let c = 0; c < totalCols1; c++) {
    setCell(ws1, c, 0, subHeaders[c], HEADER_STYLE);
  }

  // Write data
  let r1 = 1;
  for (const sub of data.dedupedSubmissions) {
    const email = (sub.respondent_email ?? "").toLowerCase();
    const booking = email ? data.bookingByEmail.get(email) : undefined;
    const fin = email ? data.financialByEmail.get(email) : undefined;

    let daysToBooking: number | string = "";
    if (sub.booking_date && sub.submitted_at) {
      const submitDate = toDateOnly(sub.submitted_at);
      const bookDate = toDateOnly(sub.booking_date);
      const days = Math.round((bookDate.getTime() - submitDate.getTime()) / (1000 * 60 * 60 * 24));
      if (days >= 0) daysToBooking = days;
    }

    const vals: unknown[] = [
      sub.respondent_email ?? "",
      sub.respondent_name ?? "",
      sub.grade?.answer_grade ?? "",
      fin?.financial_grade ?? sub.grade?.financial_grade ?? "",
      sub.grade?.final_grade ?? "",
      booking ? "Yes" : "No",
      booking?.showed ? "Yes" : "No",
      booking?.closed ? "Yes" : "No",
      sub.submitted_at ? new Date(sub.submitted_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "",
      sub.booking_date ?? "",
      daysToBooking,
      fin?.credit_score ?? "",
      fin?.estimated_income ?? "",
      fin?.credit_access ?? "",
      fin?.access_to_funding ?? "",
      ...questionTitles.map(title => {
        const ans = sub.answers.find(a => a.question_title.toLowerCase() === title.toLowerCase());
        return ans?.value ?? "";
      }),
    ];

    for (let c = 0; c < vals.length; c++) {
      setCell(ws1, c, r1, vals[c], DATA_STYLE);
    }
    r1++;
  }

  ws1["!ref"] = `A1:${colLetter(totalCols1 - 1)}${r1}`;
  ws1["!cols"] = [
    { wch: 30 }, { wch: 20 }, { wch: 13 }, { wch: 15 }, { wch: 17 },
    { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 14 }, { wch: 14 },
    { wch: 16 }, { wch: 12 }, { wch: 16 }, { wch: 14 }, { wch: 17 },
    ...Array(questionTitles.length).fill({ wch: 25 }),
  ];
  ws1["!sheetViews"] = [{ showGridLines: false }];
  ws1["!autofilter"] = { ref: `A1:${colLetter(totalCols1 - 1)}${r1}` };
  XLSX.utils.book_append_sheet(wb, ws1, subSheetName);

  // ── Column references for COUNTIFS in Submissions sheet ──
  const lastDataRow = r1; // 1-indexed (header is row 1, data ends at r1)
  const emailCol = "A";
  const bookedCol = "F";
  const showedCol = "G";
  const closedCol = "H";

  // Build column index lookup for questions
  const questionColMap: Record<string, string> = {};
  for (let qi = 0; qi < questionTitles.length; qi++) {
    questionColMap[questionTitles[qi].toLowerCase()] = colLetter(15 + qi);
  }

  // Financial columns
  const creditScoreCol = "L";
  const incomeCol = "M";
  const creditAccessCol = "N";
  const fundingCol = "O";
  const ansGradeCol = "C";
  const finGradeCol = "D";
  const appGradeCol = "E";

  const dataRange = `${subSheetName}!$2:$${lastDataRow}`;

  // ── Parse bucket labels into numeric range criteria ──
  // Returns { min, max, maxOp } where null means unbounded
  // maxOp: "<=" for inclusive upper bound (e.g. "600–649"), "<" for exclusive (e.g. "< 600")
  type RangeCriteria = { min: number | null; max: number | null; maxOp: "<=" | "<" } | null;

  function parseBucketRange(label: string, category: string): RangeCriteria {
    const cat = category.toLowerCase();

    // Days to booking: "1 day", "2 days", "5+ days"
    if (cat.includes("days")) {
      const plusMatch = label.match(/^(\d+)\+/);
      if (plusMatch) return { min: parseInt(plusMatch[1]), max: null, maxOp: "<=" };
      const numMatch = label.match(/^(\d+)\s*day/);
      if (numMatch) {
        const n = parseInt(numMatch[1]);
        // "1 day" includes 0 and 1
        if (n <= 1) return { min: 0, max: 1, maxOp: "<=" };
        return { min: n, max: n, maxOp: "<=" };
      }
      return null;
    }

    // Grade ranges: "0–25", "75–100", "Grade 1", "Grade 4"
    if (cat.includes("grade")) {
      const gradeNumMatch = label.match(/Grade\s+(\d+)/i);
      if (gradeNumMatch) {
        const g = parseInt(gradeNumMatch[1]);
        if (g === 1) return { min: 0, max: 1.5, maxOp: "<" };
        if (g === 2) return { min: 1.5, max: 2.5, maxOp: "<" };
        if (g === 3) return { min: 2.5, max: 3.5, maxOp: "<" };
        if (g === 4) return { min: 3.5, max: null, maxOp: "<=" };
        return null;
      }
      // Fall through to general range parsing (0–25, 25–50, etc.)
    }

    // General pattern: parse monetary amounts and ranges
    function parseNum(s: string): number {
      const n = s.replace(/[$,\s]/g, "");
      const kMatch = n.match(/^([\d.]+)k$/i);
      if (kMatch) return parseFloat(kMatch[1]) * 1000;
      return parseFloat(n);
    }

    // "< X" or "Below X" — exclusive upper bound
    const ltMatch = label.match(/^(?:<|Below)\s*(.+)$/i);
    if (ltMatch) return { min: null, max: parseNum(ltMatch[1]), maxOp: "<" };

    // "X+" or "> X"
    const gtMatch = label.match(/^(?:>|≥)?\s*(.+)\+$/) || label.match(/^>\s*(.+)$/);
    if (gtMatch) return { min: parseNum(gtMatch[1]), max: null, maxOp: "<=" };

    // "X–Y" or "X-Y" (range with en-dash or hyphen) — inclusive upper bound
    const rangeMatch = label.match(/^(.+?)\s*[–\-]\s*(.+)$/);
    if (rangeMatch) {
      const lo = parseNum(rangeMatch[1]);
      const hi = parseNum(rangeMatch[2]);
      if (!isNaN(lo) && !isNaN(hi)) return { min: lo, max: hi, maxOp: "<=" };
    }

    return null;
  }

  // Build COUNTIFS criteria string fragments for a range
  function rangeCountFormula(srcRange: string, range: RangeCriteria, extraCriteria?: string): string {
    if (!range) return "";
    const parts: string[] = [];
    if (range.min !== null && range.max !== null && range.min === range.max) {
      // Exact match
      parts.push(`${srcRange},${range.min}`);
    } else {
      if (range.min !== null) parts.push(`${srcRange},">=${range.min}"`);
      if (range.max !== null) {
        parts.push(`${srcRange},"${range.maxOp}${range.max}"`);
      }
    }
    if (extraCriteria) parts.push(extraCriteria);
    return `COUNTIFS(${parts.join(",")})`;
  }

  // Helper: build a formula-driven analysis sheet
  function buildAnalysisSheet(groups: SectionGroup[], sheetName: string) {
    const ws: Record<string, unknown> = {};
    const tableHeaders = ["Answer", "Apps", "Booked", "Showed", "Closed", "% of Apps", "% of Bookings", "Show Rate", "Close Rate"];
    const totalCols = tableHeaders.length;
    let row = 0;

    for (const group of groups) {
      // Section header
      for (let c = 0; c < totalCols; c++) {
        setCell(ws, c, row, c === 0 ? group.category : "", SECTION_HEADER_STYLE);
      }
      row++;

      // Table column headers
      for (let c = 0; c < totalCols; c++) {
        setCell(ws, c, row, tableHeaders[c], HEADER_STYLE);
      }
      const headerRow = row;
      row++;

      // Determine which Submissions column to COUNTIFS against
      let srcCol = "";
      let isNumericRange = false;
      const cat = group.category.toLowerCase();
      if (questionColMap[cat]) {
        srcCol = questionColMap[cat];
      } else if (cat.includes("credit score")) {
        srcCol = creditScoreCol;
        isNumericRange = true;
      } else if (cat.includes("income")) {
        srcCol = incomeCol;
        isNumericRange = true;
      } else if (cat.includes("credit access")) {
        srcCol = creditAccessCol;
        isNumericRange = true;
      } else if (cat.includes("funding")) {
        srcCol = fundingCol;
        isNumericRange = true;
      } else if (cat === "total grade" || cat === "final grade") {
        srcCol = appGradeCol;
        isNumericRange = true;
      } else if (cat === "app grade" || cat === "application grade") {
        srcCol = ansGradeCol;
        isNumericRange = true;
      } else if (cat === "financial grade") {
        srcCol = finGradeCol;
        isNumericRange = true;
      } else if (cat.includes("days")) {
        srcCol = colLetter(10); // K = Days to Booking
        isNumericRange = true;
      }

      const srcRange = srcCol ? `${subSheetName}!$${srcCol}$2:$${srcCol}$${lastDataRow}` : "";
      const bookedRange = `${subSheetName}!$${bookedCol}$2:$${bookedCol}$${lastDataRow}`;
      const showedRange = `${subSheetName}!$${showedCol}$2:$${showedCol}$${lastDataRow}`;
      const closedRange = `${subSheetName}!$${closedCol}$2:$${closedCol}$${lastDataRow}`;

      for (const r of group.rows) {
        const ansRef = cellRef(0, row); // A column for this row
        setCell(ws, 0, row, r.answer, DATA_STYLE);

        if (srcRange && isNumericRange) {
          // Parse the bucket label into min/max range
          const range = parseBucketRange(r.answer, group.category);
          if (range) {
            // Build COUNTIFS with numeric range criteria
            const appFormula = rangeCountFormula(srcRange, range);
            const bookedFormula = rangeCountFormula(srcRange, range, `${bookedRange},"Yes"`);
            const showedFormula = rangeCountFormula(srcRange, range, `${showedRange},"Yes"`);
            const closedFormula = rangeCountFormula(srcRange, range, `${closedRange},"Yes"`);
            setFormula(ws, 1, row, appFormula, DATA_STYLE_CENTER);
            setFormula(ws, 2, row, bookedFormula, DATA_STYLE_CENTER);
            setFormula(ws, 3, row, showedFormula, DATA_STYLE_CENTER);
            setFormula(ws, 4, row, closedFormula, DATA_STYLE_CENTER);
          } else {
            // Couldn't parse — fallback to static values
            setCell(ws, 1, row, r.count, DATA_STYLE_CENTER);
            setCell(ws, 2, row, r.booked, DATA_STYLE_CENTER);
            setCell(ws, 3, row, r.showed, DATA_STYLE_CENTER);
            setCell(ws, 4, row, r.closed, DATA_STYLE_CENTER);
          }
        } else if (srcRange) {
          // Question answer column exists — use formulas
          const questionDef = data.questions.find(q => q.title.toLowerCase() === cat);
          const isMultiSelect = questionDef?.allow_multiple_selection === true;
          const escapedAnswer = r.answer.replace(/"/g, '""');

          if (isMultiSelect) {
            // Multi-select: answers are stored as combined strings, use SEARCH for contains matching
            const appFormula = `SUMPRODUCT((ISNUMBER(SEARCH("${escapedAnswer}",${srcRange})))*1)`;
            const bookedFormula = `SUMPRODUCT((ISNUMBER(SEARCH("${escapedAnswer}",${srcRange})))*(${bookedRange}="Yes"))`;
            const showedFormula = `SUMPRODUCT((ISNUMBER(SEARCH("${escapedAnswer}",${srcRange})))*(${showedRange}="Yes"))`;
            const closedFormula = `SUMPRODUCT((ISNUMBER(SEARCH("${escapedAnswer}",${srcRange})))*(${closedRange}="Yes"))`;
            setFormula(ws, 1, row, appFormula, DATA_STYLE_CENTER);
            setFormula(ws, 2, row, bookedFormula, DATA_STYLE_CENTER);
            setFormula(ws, 3, row, showedFormula, DATA_STYLE_CENTER);
            setFormula(ws, 4, row, closedFormula, DATA_STYLE_CENTER);
          } else {
            // Single-select: exact match with COUNTIF
            const appFormula = `COUNTIF(${srcRange},"${escapedAnswer}")`;
            const bookedFormula = `COUNTIFS(${srcRange},"${escapedAnswer}",${bookedRange},"Yes")`;
            const showedFormula = `COUNTIFS(${srcRange},"${escapedAnswer}",${showedRange},"Yes")`;
            const closedFormula = `COUNTIFS(${srcRange},"${escapedAnswer}",${closedRange},"Yes")`;
            setFormula(ws, 1, row, appFormula, DATA_STYLE_CENTER);
            setFormula(ws, 2, row, bookedFormula, DATA_STYLE_CENTER);
            setFormula(ws, 3, row, showedFormula, DATA_STYLE_CENTER);
            setFormula(ws, 4, row, closedFormula, DATA_STYLE_CENTER);
          }
        } else {
          // No source column found — static fallback
          setCell(ws, 1, row, r.count, DATA_STYLE_CENTER);
          setCell(ws, 2, row, r.booked, DATA_STYLE_CENTER);
          setCell(ws, 3, row, r.showed, DATA_STYLE_CENTER);
          setCell(ws, 4, row, r.closed, DATA_STYLE_CENTER);
        }

        const bRef = cellRef(1, row);
        const cRef = cellRef(2, row);
        const dRef = cellRef(3, row);
        const eRef = cellRef(4, row);

        // % of Apps = Apps / total (COUNTA of email column minus header)
        setFormula(ws, 5, row, `IF(COUNTA(${subSheetName}!$A$2:$A$${lastDataRow})=0,0,${bRef}/COUNTA(${subSheetName}!$A$2:$A$${lastDataRow}))`, PCT_STYLE);
        // % of Bookings = Booked / total booked
        setFormula(ws, 6, row, `IF(COUNTIF(${bookedRange},"Yes")=0,0,${cRef}/COUNTIF(${bookedRange},"Yes"))`, PCT_STYLE);
        // Show Rate = Showed / Booked
        setFormula(ws, 7, row, `IF(${cRef}=0,0,${dRef}/${cRef})`, PCT_STYLE);
        // Close Rate = Closed / Showed
        setFormula(ws, 8, row, `IF(${dRef}=0,0,${eRef}/${dRef})`, PCT_STYLE);
        row++;
      }

      row++; // Empty row between sections
    }

    ws["!ref"] = `A1:${colLetter(totalCols - 1)}${Math.max(row, 1)}`;
    ws["!cols"] = [
      { wch: 35 }, { wch: 8 }, { wch: 9 }, { wch: 9 }, { wch: 9 },
      { wch: 12 }, { wch: 14 }, { wch: 11 }, { wch: 11 },
    ];
    ws["!sheetViews"] = [{ showGridLines: false }];
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }

  // Summary sheet — all groups
  const summaryGroups = buildSectionGroups(data, "summary");
  buildAnalysisSheet(summaryGroups, "Summary");

  // Granular sheet — only include categories that actually differ from summary
  const granularGroups = buildSectionGroups(data, "granular");
  // Filter to only groups that have granular data (different from summary)
  const summaryCategories = new Set(summaryGroups.map(g => g.category));
  const onlyGranularGroups = granularGroups.filter(g => {
    // Questions are always the same — skip them on granular
    if (summaryCategories.has(g.category)) {
      const summaryMatch = summaryGroups.find(sg => sg.category === g.category);
      if (summaryMatch && summaryMatch.rows.length === g.rows.length) {
        // Same row count = same buckets = not actually granular, skip
        return false;
      }
    }
    return g.rows.length > 0;
  });

  if (onlyGranularGroups.length > 0) {
    buildAnalysisSheet(onlyGranularGroups, "Granular");
  }

  const filename = data.exportFilename ?? `${data.appTitle} - Correlation Analysis.xlsx`;
  XLSX.writeFile(wb, filename);
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF Export — Programmatic vector PDF matching modern view style
// ─────────────────────────────────────────────────────────────────────────────

interface PdfContext {
  pdf: InstanceType<typeof import("jspdf").jsPDF>;
  y: number;
  pageW: number;
  pageH: number;
  margin: number;
  usableW: number;
  usableH: number;
}

function ensureSpace(ctx: PdfContext, needed: number): void {
  if (ctx.y + needed > ctx.pageH - ctx.margin - 8) {
    ctx.pdf.addPage();
    ctx.y = ctx.margin;
  }
}

function drawRoundedRect(
  pdf: PdfContext["pdf"],
  x: number, y: number, w: number, h: number, r: number,
  fillColor: [number, number, number],
  borderColor?: [number, number, number]
) {
  pdf.setFillColor(...fillColor);
  if (borderColor) {
    pdf.setDrawColor(...borderColor);
    pdf.setLineWidth(0.3);
    pdf.roundedRect(x, y, w, h, r, r, "FD");
  } else {
    pdf.roundedRect(x, y, w, h, r, r, "F");
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export async function exportPdf(data: ExportData, filename: string): Promise<void> {
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF("p", "mm", "a4");
  const pageW = 210;
  const pageH = 297;
  const margin = 12;
  const usableW = pageW - margin * 2;

  const ctx: PdfContext = { pdf, y: margin, pageW: pageW, pageH, margin, usableW, usableH: pageH - margin * 2 };

  const INDIGO = hexToRgb("#4F46E5");
  const INDIGO_LIGHT = hexToRgb("#E0E7FF");
  const GREEN = hexToRgb("#10B981");
  const GREEN_BG = hexToRgb("#ECFDF5");
  const AMBER = hexToRgb("#F59E0B");
  const AMBER_BG = hexToRgb("#FFFBEB");
  const RED = hexToRgb("#EF4444");
  const RED_BG = hexToRgb("#FEF2F2");
  const SLATE_50 = hexToRgb("#F8FAFC");
  const SLATE_100 = hexToRgb("#F1F5F9");
  const SLATE_200 = hexToRgb("#E2E8F0");
  const SLATE_400 = hexToRgb("#94A3B8");
  const SLATE_500 = hexToRgb("#64748B");
  const SLATE_700 = hexToRgb("#334155");
  const SLATE_800 = hexToRgb("#1E293B");
  const WHITE: [number, number, number] = [255, 255, 255];

  // ── Title Section ──
  drawRoundedRect(pdf, margin, ctx.y, usableW, 18, 2, INDIGO);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(14);
  pdf.setTextColor(...WHITE);
  pdf.text("Correlation Analysis", margin + 6, ctx.y + 8);
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(9);
  pdf.text(data.appTitle, margin + 6, ctx.y + 14);
  const dateStr = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  pdf.text(dateStr, usableW + margin - 6, ctx.y + 14, { align: "right" });
  ctx.y += 22;

  // ── Overview Stats Cards ──
  const statCards = [
    { label: "Total Apps", value: data.totalSubs, color: INDIGO, bg: INDIGO_LIGHT },
    { label: "Booked", value: data.bookedCount, color: GREEN, bg: GREEN_BG },
    { label: "Showed", value: data.showedCount, color: AMBER, bg: AMBER_BG },
    { label: "Closed", value: data.closedCount, color: RED, bg: RED_BG },
  ];
  const cardW = (usableW - 6) / 4;
  for (let i = 0; i < statCards.length; i++) {
    const x = margin + i * (cardW + 2);
    drawRoundedRect(pdf, x, ctx.y, cardW, 16, 2, statCards[i].bg, SLATE_200);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(16);
    pdf.setTextColor(...statCards[i].color);
    pdf.text(String(statCards[i].value), x + cardW / 2, ctx.y + 8, { align: "center" });
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(7);
    pdf.setTextColor(...SLATE_500);
    pdf.text(statCards[i].label, x + cardW / 2, ctx.y + 13, { align: "center" });
  }
  ctx.y += 20;

  // ── Funnel Row ──
  if (data.totalSubs > 0) {
    const funnelLabels = ["Booked", "Showed", "Closed"];
    const funnelValues = [data.bookedCount, data.showedCount, data.closedCount];
    const funnelDenoms = [data.totalSubs, data.bookedCount, data.showedCount];
    const funnelColors = [GREEN, AMBER, RED];
    const funnelBgs = [GREEN_BG, AMBER_BG, RED_BG];
    const fW = (usableW - 4) / 3;
    for (let i = 0; i < 3; i++) {
      const x = margin + i * (fW + 2);
      const pct = funnelDenoms[i] > 0 ? funnelValues[i] / funnelDenoms[i] : 0;
      drawRoundedRect(pdf, x, ctx.y, fW, 10, 1.5, WHITE, SLATE_200);
      // Progress bar fill
      if (pct > 0) {
        const barW = Math.max(1, (fW - 1) * pct);
        drawRoundedRect(pdf, x + 0.5, ctx.y + 0.5, barW, 9, 1, funnelBgs[i]);
      }
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(8);
      pdf.setTextColor(...funnelColors[i]);
      pdf.text(`${Math.round(pct * 100)}%`, x + 3, ctx.y + 6.5);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(7);
      pdf.setTextColor(...SLATE_500);
      pdf.text(`${funnelLabels[i]} (${funnelValues[i]}/${funnelDenoms[i]})`, x + fW - 3, ctx.y + 6.5, { align: "right" });
    }
    ctx.y += 14;
  }

  // ── Section divider helper ──
  function drawDivider(title: string) {
    ensureSpace(ctx, 10);
    const titleW = pdf.getStringUnitWidth(title) * 6 / pdf.internal.scaleFactor + 6;
    const lineY = ctx.y + 3;
    const centerX = margin + usableW / 2;
    pdf.setDrawColor(...SLATE_200);
    pdf.setLineWidth(0.3);
    pdf.line(margin, lineY, centerX - titleW / 2 - 2, lineY);
    pdf.line(centerX + titleW / 2 + 2, lineY, margin + usableW, lineY);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(6);
    pdf.setTextColor(...SLATE_400);
    pdf.text(title.toUpperCase(), centerX, lineY + 1.5, { align: "center" });
    ctx.y += 9;
  }

  // ── Bucket table helper ──
  function drawBucketTable(title: string, subtitle: string | null, buckets: BucketData[], totalCount: number) {
    if (buckets.length === 0) return;
    // Check space: header + all rows (approx 5mm each) + some padding
    const neededHeight = 14 + buckets.length * 5.5;
    ensureSpace(ctx, Math.min(neededHeight, 50)); // At least fit header + some rows

    // Section title
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(8);
    pdf.setTextColor(...SLATE_800);
    pdf.text(title, margin, ctx.y + 3);
    if (subtitle) {
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(6);
      pdf.setTextColor(...SLATE_400);
      pdf.text(subtitle, margin, ctx.y + 7);
      ctx.y += 10;
    } else {
      ctx.y += 6;
    }

    // Column headers
    const cols = [
      { x: margin, w: 55, label: "Answer", align: "left" as const },
      { x: margin + 55, w: 65, label: "", align: "left" as const }, // bar
      { x: margin + 120, w: 16, label: "Apps", align: "center" as const },
      { x: margin + 136, w: 16, label: "Booked", align: "center" as const },
      { x: margin + 152, w: 16, label: "Show%", align: "center" as const },
      { x: margin + 168, w: 18, label: "Close%", align: "center" as const },
    ];
    drawRoundedRect(pdf, margin, ctx.y, usableW, 5, 1, SLATE_100);
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(5.5);
    pdf.setTextColor(...SLATE_500);
    for (const col of cols) {
      pdf.text(col.label, col.align === "center" ? col.x + col.w / 2 : col.x + 1, ctx.y + 3.5, { align: col.align });
    }
    ctx.y += 6;

    // Rows
    for (const b of buckets) {
      ensureSpace(ctx, 6);
      const pct = totalCount > 0 ? b.count / totalCount : 0;
      const showRate = b.bookedCount > 0 ? b.showedCount / b.bookedCount : 0;
      const closeRate = b.showedCount > 0 ? b.closedCount / b.showedCount : 0;

      // Alternating row bg
      const rowBg = buckets.indexOf(b) % 2 === 0 ? WHITE : SLATE_50;
      drawRoundedRect(pdf, margin, ctx.y, usableW, 5, 0.5, rowBg);

      // Answer label
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(6.5);
      pdf.setTextColor(...SLATE_700);
      const answerText = b.label.length > 28 ? b.label.substring(0, 26) + "…" : b.label;
      pdf.text(answerText, margin + 1, ctx.y + 3.5);

      // Bar
      const barX = margin + 55;
      const barMaxW = 60;
      drawRoundedRect(pdf, barX, ctx.y + 1, barMaxW, 3, 0.5, SLATE_100);
      if (pct > 0) {
        const barW = Math.max(0.5, barMaxW * pct);
        drawRoundedRect(pdf, barX, ctx.y + 1, barW, 3, 0.5, INDIGO);
      }
      // Percentage on bar
      pdf.setFontSize(5);
      pdf.setTextColor(...SLATE_500);
      pdf.text(`${Math.round(pct * 100)}%`, barX + barMaxW + 1, ctx.y + 3.5);

      // Stats
      pdf.setFontSize(6);
      pdf.setTextColor(...SLATE_700);
      pdf.text(String(b.count), margin + 120 + 8, ctx.y + 3.5, { align: "center" });
      pdf.text(String(b.bookedCount), margin + 136 + 8, ctx.y + 3.5, { align: "center" });
      pdf.setTextColor(...(showRate > 0.5 ? GREEN : SLATE_500));
      pdf.text(`${Math.round(showRate * 100)}%`, margin + 152 + 8, ctx.y + 3.5, { align: "center" });
      pdf.setTextColor(...(closeRate > 0.3 ? GREEN : SLATE_500));
      pdf.text(`${Math.round(closeRate * 100)}%`, margin + 168 + 9, ctx.y + 3.5, { align: "center" });
      ctx.y += 5.5;
    }
    ctx.y += 4;
  }

  // ── Grades Section ──
  const hasGrades = data.gradeBuckets.hasTotalGrade || data.gradeBuckets.hasAppGrade || data.gradeBuckets.hasFinGrade;
  if (hasGrades) {
    drawDivider("Grades");
    if (data.gradeBuckets.hasTotalGrade) drawBucketTable("Final Grade", null, data.gradeBuckets.totalGrade, data.totalSubs);
    if (data.gradeBuckets.hasAppGrade) drawBucketTable("Application Grade", null, data.gradeBuckets.appGrade, data.totalSubs);
    if (data.gradeBuckets.hasFinGrade) drawBucketTable("Financial Grade", null, data.gradeBuckets.finGrade, data.totalSubs);
  }

  // Days to Booking
  if (data.daysToBookingBuckets.length > 0) {
    drawBucketTable("Days from Application to Booking", "Time between application submission and booking date", data.daysToBookingBuckets, data.totalSubs);
  }

  // ── Application Answers ──
  if (data.questionCorrelations.length > 0) {
    drawDivider("Application Answers");
    for (const qc of data.questionCorrelations) {
      drawBucketTable(qc.questionTitle, null, qc.stats.map(s => ({
        label: s.answer,
        count: s.count,
        bookedCount: s.bookedCount,
        showedCount: s.showedCount,
        closedCount: s.closedCount,
        emails: s.emails,
      })), data.totalSubs);
    }
  }

  // ── Financial Data ──
  const hasFinancial = data.creditScoreBuckets.length > 0 || data.incomeBuckets.length > 0 ||
    data.creditAccessBuckets.length > 0 || data.fundingBuckets.length > 0;
  if (hasFinancial) {
    drawDivider("Financial Data");
    if (data.creditScoreBuckets.length > 0) drawBucketTable("Credit Score Distribution", null, data.creditScoreBuckets, data.totalSubs);
    if (data.incomeBuckets.length > 0) drawBucketTable("Income Distribution", null, data.incomeBuckets, data.totalSubs);
    if (data.creditAccessBuckets.length > 0) drawBucketTable("Credit Access Distribution", null, data.creditAccessBuckets, data.totalSubs);
    if (data.fundingBuckets.length > 0) drawBucketTable("Funding Distribution", null, data.fundingBuckets, data.totalSubs);
  }

  // ── Footer on each page ──
  const totalPages = pdf.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    pdf.setPage(i);
    // Bottom border
    pdf.setDrawColor(...SLATE_200);
    pdf.setLineWidth(0.3);
    pdf.line(margin, pageH - 10, margin + usableW, pageH - 10);
    // Page number
    pdf.setFontSize(6);
    pdf.setFont("helvetica", "normal");
    pdf.setTextColor(...SLATE_400);
    pdf.text(`Page ${i} of ${totalPages}`, pageW / 2, pageH - 6, { align: "center" });
    // Branding
    pdf.text("SalesKick Correlation Analysis", margin, pageH - 6);
  }

  pdf.save(filename);
}
