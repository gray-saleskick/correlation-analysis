// Core types for Correlation Analysis

export type TypeformQuestionType =
  | "short_text"
  | "long_text"
  | "multiple_choice"
  | "dropdown"
  | "ranking"
  | "rating"
  | "opinion_scale"
  | "yes_no"
  | "email"
  | "phone_number"
  | "first_name"
  | "last_name"
  | "full_name"
  | "date"
  | "number"
  | "file_upload"
  | "statement"
  | "picture_choice"
  | "website";

export interface ApplicationQuestion {
  id: string;
  ref?: string;
  title: string;
  type: TypeformQuestionType;
  required: boolean;
  choices?: { id: string; label: string }[];
  allow_multiple_selection?: boolean;
  order: number;
  grading_prompt_template?: string;
  grading_prompt?: string;
  drop_off_rate?: number;
}

export interface AppSubmissionAnswer {
  question_ref: string;
  question_title: string;
  value: string | null;
}

export interface AppSubmissionGrade {
  final_grade?: number;
  answer_grade?: number;
  financial_grade?: number;
  was_disqualified?: boolean;
  was_spam?: boolean;
  details?: string;
}

export interface AppSubmissionFinancial {
  credit_score?: number;
  estimated_income?: number;
  available_credit?: number;
  available_funding?: number;
}

export interface AppSubmission {
  id: string;
  submitted_at: string;
  booking_date?: string;
  respondent_email?: string;
  respondent_name?: string;
  respondent_phone?: string;
  source?: "api" | "csv";
  answers: AppSubmissionAnswer[];
  grade?: AppSubmissionGrade;
  financial?: AppSubmissionFinancial;
}

export interface BookingRecord {
  email: string;
  showed: boolean;
  closed: boolean;
}

export interface ColumnMappingEntry {
  file_column: string;
  target: string;
}

export interface SavedColumnMapping {
  upload_type: "submissions" | "financial" | "call_results";
  entries: ColumnMappingEntry[];
  saved_at: string;
}

export interface FinancialRecord {
  email: string;
  financial_grade?: number;
  credit_score?: number;
  estimated_income?: number;
  credit_access?: number;
  access_to_funding?: number;
}

export interface CallResultRecord {
  email: string;
  booking_date?: string;
  close_date?: string;
  booked: boolean;
  showed: boolean;
  closed: boolean;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface DataChat {
  id: string;
  title: string;
  messages: ChatMessage[];
  created_at: string;
}

export interface Application {
  id: string;
  title: string;
  source: "manual";
  added_at: string;
  questions: ApplicationQuestion[];
  submissions?: AppSubmission[];
  bookings?: BookingRecord[];
  financial_records?: FinancialRecord[];
  call_results?: CallResultRecord[];
  upload_mappings?: {
    submissions?: SavedColumnMapping;
    financial?: SavedColumnMapping;
    call_results?: SavedColumnMapping;
  };
  grade_mappings?: {
    total_grade?: string;
    application_grade?: string;
  };
  hidden_correlation_questions?: string[];
  correlation_answer_order?: Record<string, string[]>;
  saved_correlation_filters?: SavedCorrelationFilter[];
  typeform_pat?: string;
  typeform_form_id?: string;
  narrative_analysis?: string;
  narrative_generated_at?: string;
  audit_analysis?: string;
  audit_generated_at?: string;
  audit_client_notes?: string;
  narrative_chat?: ChatMessage[];
  audit_chat?: ChatMessage[];
  grading_audit_analysis?: string;
  grading_audit_generated_at?: string;
  grading_audit_client_notes?: string;
  grading_audit_chat?: ChatMessage[];
  data_chats?: DataChat[];
  share_token?: string;
  share_enabled?: boolean;
  webhook_config?: WebhookConfig;
  pending_webhook_submissions?: PendingWebhookSubmission[];
  load_history?: LoadHistoryEntry[];
}

// Webhook types

export interface WebhookFieldMapping {
  source_field: string;
  target: string;
}

export interface CalculatedField {
  id: string;
  name: string;
  type: "date_diff_days" | "math";
  expression: string;
  source_fields: string[];
  target: string;
}

export interface WebhookConfig {
  enabled: boolean;
  token: string;
  source: "typeform" | "zapier" | "generic";
  field_mapping: WebhookFieldMapping[];
  calculated_fields?: CalculatedField[];
  last_received_at?: string;
  last_field_signature?: string;
  created_at: string;
}

export interface PendingWebhookSubmission {
  id: string;
  received_at: string;
  raw_payload: Record<string, unknown>;
  source: string;
  status: "pending" | "rejected";
  reason?: string;
}

// Load history types

export type LoadSourceType =
  | "csv-submissions"
  | "csv-financial"
  | "csv-call-results"
  | "typeform-sync"
  | "webhook-batch"
  | "webhook-auto";

export interface LoadHistorySourceData {
  csv_rows?: Record<string, string>[];
  csv_mapping?: { file_column: string; target: string }[];
  webhook_pending_ids?: string[];
  webhook_field_mapping?: WebhookFieldMapping[];
}

export interface LoadHistoryDataSnapshot {
  submissions?: AppSubmission[];
  questions?: ApplicationQuestion[];
  financial_records?: FinancialRecord[];
  call_results?: CallResultRecord[];
  bookings?: BookingRecord[];
  pending_webhook_submissions?: PendingWebhookSubmission[];
}

export interface LoadHistoryEntry {
  id: string;
  timestamp: string;
  source_type: LoadSourceType;
  description: string;
  record_count: number;
  pre_load_snapshot: LoadHistoryDataSnapshot;
  source_data?: LoadHistorySourceData;
}

// Correlation filter types

export type FilterOperator = "equals" | "not_equals" | "contains" | "not_contains" | "gte" | "lte" | "between" | "is";

export type FilterFieldType =
  | "question_answer"
  | "credit_score" | "estimated_income" | "credit_access" | "access_to_funding" | "financial_grade"
  | "final_grade" | "answer_grade"
  | "booked" | "showed" | "closed";

export interface FilterCondition {
  id: string;
  field: FilterFieldType;
  questionTitle?: string;
  operator: FilterOperator;
  value: string | number | boolean | [number, number];
}

export interface SavedCorrelationFilter {
  id: string;
  name: string;
  conditions: FilterCondition[];
  dateRange?: { start: string; end: string };
}

export interface ClientProfile {
  clientId: string;
  clientName: string;
  company_description?: string;
  created_at: string;
  updated_at: string;
  applications: Application[];
}
