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

function norm(s: string) {
  return s.toLowerCase().replace(/[\s_-]/g, "");
}

export function autoDetectTarget(
  col: string,
  questionTitles: string[] = []
): string {
  const n = norm(col);
  const lower = col.toLowerCase();

  if (EMAIL_TARGETS.some((t) => norm(t) === n)) return "email";
  if (FNAME_TARGETS.some((t) => norm(t) === n)) return "first_name";
  if (LNAME_TARGETS.some((t) => norm(t) === n)) return "last_name";
  if (FULLNAME_TARGETS.some((t) => norm(t) === n)) return "full_name";
  if (PHONE_TARGETS.some((t) => norm(t) === n)) return "phone";

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

  const stripped = stripQuestionPrefix(col);
  if (stripped) {
    if (EMAIL_TARGETS.some((t) => norm(stripped) === norm(t)))
      return "email";
    if (FNAME_TARGETS.some((t) => norm(stripped) === norm(t)))
      return "first_name";
    if (LNAME_TARGETS.some((t) => norm(stripped) === norm(t)))
      return "last_name";
    if (FULLNAME_TARGETS.some((t) => norm(stripped) === norm(t)))
      return "full_name";
    if (PHONE_TARGETS.some((t) => norm(stripped) === norm(t)))
      return "phone";
    const matched = questionTitles.find(
      (qt) => norm(qt) === norm(stripped) || norm(qt).startsWith(norm(stripped.slice(0, 15)))
    );
    if (matched) return `answer:${matched}`;
    return `answer:${stripped}`;
  }

  if (n === "showed" || n === "show" || lower === "did show") return "booking.showed";
  if (n === "closed" || n === "close" || lower === "did close") return "booking.closed";
  if (n === "booked" || n === "book" || lower === "did book") return "booking.booked";
  if (lower === "close date" || lower === "close_date" || lower === "closedate" || lower === "closed date" || lower === "closed_date") return "close_date";
  if (lower === "booking date" || lower === "booking_date" || lower === "bookingdate") return "booking_date";

  // Financial record targets
  if (lower === "credit score" || lower === "credit_score") return "financial.credit_score";
  if (lower === "estimated income" || lower === "estimated_income" || lower === "income") return "financial.estimated_income";
  if (lower === "credit access" || lower === "credit_access" || lower === "available credit" || lower === "available_credit") return "financial.available_credit";
  if (lower === "access to funding" || lower === "access_to_funding" || lower === "available funding" || lower === "available_funding") return "financial.available_funding";
  if (lower === "financial grade" || lower === "financial_grade") return "financial.grade";

  // Default: treat unrecognized headers as questions (user can change to skip)
  return `answer:${col}`;
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
