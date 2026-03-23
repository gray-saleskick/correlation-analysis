/**
 * CSV / XLSX parsing utilities.
 * Uses SheetJS (xlsx) to support .csv, .xls, and .xlsx files.
 */

export interface ParsedFile {
  headers: string[];
  rows: Record<string, string>[];
  rowCount: number;
}

export async function parseFileToRows(file: File): Promise<ParsedFile> {
  const XLSX = await import("xlsx-js-style");

  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  let workbook: ReturnType<typeof XLSX.read>;

  if (ext === "csv") {
    const text = await file.text();
    workbook = XLSX.read(text, { type: "string", raw: false });
  } else {
    const buffer = await file.arrayBuffer();
    workbook = XLSX.read(new Uint8Array(buffer), { type: "array", raw: false });
  }

  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  const raw = XLSX.utils.sheet_to_json<string[]>(sheet, {
    header: 1,
    defval: "",
    raw: false,
  });

  if (!raw || raw.length === 0) return { headers: [], rows: [], rowCount: 0 };

  const headers = (raw[0] as string[]).map((h) => String(h ?? "").trim());
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < raw.length; i++) {
    const rowArr = raw[i] as string[];
    if (!rowArr || rowArr.every((v) => !v)) continue;
    const rowObj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      rowObj[h] = String(rowArr[idx] ?? "").trim();
    });
    rows.push(rowObj);
  }

  return { headers, rows, rowCount: rows.length };
}

export function stripQuestionPrefix(col: string): string | null {
  const match = col.match(/^#\d+\s*[-–]\s*(.+)$/);
  return match ? match[1].trim() : null;
}

const EMAIL_TARGETS = ["email", "e-mail", "emailaddress", "email address"];
const FNAME_TARGETS = ["firstname", "first name", "first_name"];
const LNAME_TARGETS = ["lastname", "last name", "last_name"];
const FULLNAME_TARGETS = ["fullname", "full name", "full_name", "name"];
const PHONE_TARGETS = ["phone", "phonenumber", "phone number", "phone_number"];

// Known system/metadata columns that should default to skip
const SKIP_TARGETS = [
  "source name", "source id", "sourcename", "sourceid",
  "source_name", "source_id",
];

function norm(s: string) {
  return s.toLowerCase().replace(/[\s_-]/g, "");
}

/** Check if a string exactly matches one of the target lists */
function exactMatch(s: string, targets: string[]): boolean {
  const n = norm(s);
  return targets.some((t) => norm(t) === n);
}

/** Check if a string contains keywords that indicate a constant field */
function containsEmail(s: string): boolean {
  const l = s.toLowerCase();
  return l.includes("email address") || l.includes("email") || l.includes("e-mail");
}
function containsPhone(s: string): boolean {
  const l = s.toLowerCase();
  return l.includes("phone number") || l.includes("phone");
}
function containsFirstName(s: string): boolean {
  const l = s.toLowerCase();
  return /\bfirst\s*name\b/.test(l);
}
function containsLastName(s: string): boolean {
  const l = s.toLowerCase();
  return /\blast\s*name\b/.test(l);
}

export function autoDetectTarget(
  col: string,
  questionTitles: string[] = []
): string {
  const n = norm(col);
  const lower = col.toLowerCase();

  // Exact matches for constants
  if (exactMatch(col, EMAIL_TARGETS)) return "email";
  if (exactMatch(col, FNAME_TARGETS)) return "first_name";
  if (exactMatch(col, LNAME_TARGETS)) return "last_name";
  if (exactMatch(col, FULLNAME_TARGETS)) return "full_name";
  if (exactMatch(col, PHONE_TARGETS)) return "phone";

  // Known skip columns
  if (SKIP_TARGETS.includes(lower) || SKIP_TARGETS.includes(n)) return "skip";

  if (n === "submissionid" || lower === "submission id") return "submission_id";
  if (n === "addedat" || lower === "added at") return "submitted_at";

  if (lower === "final grade" || lower === "gradingdata.finalgrade") return "grade.final";
  if (lower === "answers grade" || lower === "gradingdata.answergrade") return "grade.answer";
  if (
    lower.startsWith("financial grade") ||
    lower === "gradingdata.financialgradinresult.resultinggrade" ||
    lower === "gradingdata.financialgradingresult.resultinggrade"
  )
    return "grade.financial";
  if (lower === "was disqualified") return "grade.disqualified";
  if (lower === "was spam") return "grade.spam";
  if (lower === "grade message/details" || lower === "gradingdata.details")
    return "grade.details";

  if (lower === "financialdata.data.creditscore") return "financial.credit_score";
  if (lower === "financialdata.data.estimatedincome")
    return "financial.estimated_income";
  if (lower === "offer[1].value.amount") return "financial.available_credit";
  if (lower === "offer[2].value.amount") return "financial.available_funding";

  // Strip #x - prefix if present (display cleanup only — doesn't determine if it's a question)
  const stripped = stripQuestionPrefix(col) ?? col;

  // Check stripped text for constant fields — exact first, then fuzzy contains
  if (exactMatch(stripped, EMAIL_TARGETS)) return "email";
  if (exactMatch(stripped, FNAME_TARGETS)) return "first_name";
  if (exactMatch(stripped, LNAME_TARGETS)) return "last_name";
  if (exactMatch(stripped, FULLNAME_TARGETS)) return "full_name";
  if (exactMatch(stripped, PHONE_TARGETS)) return "phone";

  // Fuzzy: header text *contains* email/phone/name keywords
  if (containsEmail(stripped)) return "email";
  if (containsFirstName(stripped)) return "first_name";
  if (containsLastName(stripped)) return "last_name";
  if (containsPhone(stripped)) return "phone";

  // Booking & financial targets
  if (n === "showed" || n === "show" || lower === "did show") return "booking.showed";
  if (n === "closed" || n === "close" || lower === "did close") return "booking.closed";
  if (n === "booked" || n === "book" || lower === "did book") return "booking.booked";
  if (lower === "close date" || lower === "close_date" || lower === "closedate" || lower === "closed date" || lower === "closed_date") return "close_date";
  if (lower === "booking date" || lower === "booking_date" || lower === "bookingdate") return "booking_date";

  if (lower === "credit score" || lower === "credit_score") return "financial.credit_score";
  if (lower === "estimated income" || lower === "estimated_income" || lower === "income") return "financial.estimated_income";
  if (lower === "credit access" || lower === "credit_access" || lower === "available credit" || lower === "available_credit") return "financial.available_credit";
  if (lower === "access to funding" || lower === "access_to_funding" || lower === "available funding" || lower === "available_funding") return "financial.available_funding";
  if (lower === "financial grade" || lower === "financial_grade") return "financial.grade";

  // Try matching against existing question titles
  const matched = questionTitles.find(
    (qt) => norm(qt) === norm(stripped) || norm(qt).startsWith(norm(stripped.slice(0, 15)))
  );
  if (matched) return `answer:${matched}`;

  // Default: treat as question (user can change to skip)
  return `answer:${stripped}`;
}

export function buildInitialMapping(
  headers: string[],
  questionTitles: string[] = []
): Array<{ file_column: string; target: string }> {
  return headers.map((h) => ({
    file_column: h,
    target: autoDetectTarget(h, questionTitles),
  }));
}

export function parseBoolValue(val: string): boolean {
  const v = val.trim().toLowerCase();
  return v === "true" || v === "yes" || v === "y" || v === "1";
}

export function extractUniqueValues(
  rows: Record<string, string>[],
  column: string,
  max = 30
): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    const v = row[column]?.trim();
    if (v) seen.add(v);
    if (seen.size >= max) break;
  }
  return Array.from(seen).sort();
}

export function parseDollarAmount(val: string): number | null {
  const cleaned = val.replace(/[$,\s]/g, "");
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}
