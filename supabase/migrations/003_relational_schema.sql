-- Migration: JSONB monolith → Relational tables
-- This creates all new tables alongside the existing clients table.
-- The old `profile` JSONB column is NOT dropped yet (kept as fallback).

-- ═══════════════════════════════════════════════════════════════════════
-- 1. USERS (replaces __users__ special row)
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  name text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ═══════════════════════════════════════════════════════════════════════
-- 2. CLIENTS (add new columns to existing table)
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE clients ADD COLUMN IF NOT EXISTS client_name text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS company_description text;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. APPLICATIONS
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS applications (
  id text PRIMARY KEY,
  client_id text NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
  title text NOT NULL,
  source text NOT NULL DEFAULT 'manual',
  added_at timestamptz DEFAULT now(),

  -- Typeform integration
  typeform_pat text,
  typeform_form_id text,

  -- Public sharing
  share_token text,
  share_enabled boolean DEFAULT false,

  -- Correlation config (small JSONB, fine to keep as JSON)
  hidden_correlation_questions jsonb DEFAULT '[]',
  correlation_answer_order jsonb DEFAULT '{}',
  grade_mappings jsonb,
  upload_mappings jsonb,

  -- AI analysis outputs
  narrative_analysis text,
  narrative_generated_at timestamptz,
  audit_analysis text,
  audit_generated_at timestamptz,
  audit_client_notes text,
  grading_audit_analysis text,
  grading_audit_generated_at timestamptz,
  grading_audit_client_notes text,

  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_applications_client ON applications(client_id);
CREATE INDEX IF NOT EXISTS idx_applications_share_token ON applications(share_token) WHERE share_token IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════
-- 4. APPLICATION QUESTIONS
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS application_questions (
  id text NOT NULL,
  application_id text NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  ref text,
  title text NOT NULL,
  type text NOT NULL,
  required boolean DEFAULT false,
  choices jsonb, -- [{id, label}] array — small, fine as JSONB
  allow_multiple_selection boolean DEFAULT false,
  sort_order int NOT NULL DEFAULT 0,
  grading_prompt_template text,
  grading_prompt text,
  drop_off_rate real,
  PRIMARY KEY (application_id, id)
);

-- ═══════════════════════════════════════════════════════════════════════
-- 5. SUBMISSIONS
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS submissions (
  id text PRIMARY KEY,
  application_id text NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  submitted_at timestamptz,
  booking_date text,
  respondent_email text,
  respondent_name text,
  respondent_phone text,
  source text,

  -- Grade fields (flattened from nested AppSubmissionGrade)
  final_grade real,
  answer_grade real,
  financial_grade real,
  was_disqualified boolean DEFAULT false,
  was_spam boolean DEFAULT false,
  grade_details text,

  -- Financial fields (flattened from nested AppSubmissionFinancial)
  fin_credit_score real,
  fin_estimated_income real,
  fin_available_credit real,
  fin_available_funding real
);
CREATE INDEX IF NOT EXISTS idx_submissions_app ON submissions(application_id);
CREATE INDEX IF NOT EXISTS idx_submissions_email ON submissions(respondent_email) WHERE respondent_email IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════
-- 6. SUBMISSION ANSWERS
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS submission_answers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  submission_id text NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  question_ref text NOT NULL,
  question_title text NOT NULL,
  value text
);
CREATE INDEX IF NOT EXISTS idx_sub_answers_submission ON submission_answers(submission_id);

-- ═══════════════════════════════════════════════════════════════════════
-- 7. FINANCIAL RECORDS
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS financial_records (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  application_id text NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  email text NOT NULL,
  financial_grade real,
  credit_score real,
  estimated_income real,
  credit_access real,
  access_to_funding real
);
CREATE INDEX IF NOT EXISTS idx_fin_records_app ON financial_records(application_id);
CREATE INDEX IF NOT EXISTS idx_fin_records_email ON financial_records(email);

-- ═══════════════════════════════════════════════════════════════════════
-- 8. CALL RESULTS
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS call_results (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  application_id text NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  email text NOT NULL,
  booking_date text,
  close_date text,
  booked boolean DEFAULT false,
  showed boolean DEFAULT false,
  closed boolean DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_call_results_app ON call_results(application_id);
CREATE INDEX IF NOT EXISTS idx_call_results_email ON call_results(email);

-- ═══════════════════════════════════════════════════════════════════════
-- 9. WEBHOOK CONFIGS
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS webhook_configs (
  application_id text PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
  enabled boolean DEFAULT true,
  token text UNIQUE NOT NULL,
  source text NOT NULL,
  last_received_at timestamptz,
  last_field_signature text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webhook_token ON webhook_configs(token);

CREATE TABLE IF NOT EXISTS webhook_field_mappings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  webhook_config_id text NOT NULL REFERENCES webhook_configs(application_id) ON DELETE CASCADE,
  source_field text NOT NULL,
  target text NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_calculated_fields (
  id text PRIMARY KEY,
  webhook_config_id text NOT NULL REFERENCES webhook_configs(application_id) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL,
  expression text NOT NULL,
  source_fields jsonb NOT NULL DEFAULT '[]',
  target text NOT NULL
);

-- ═══════════════════════════════════════════════════════════════════════
-- 10. PENDING WEBHOOK SUBMISSIONS
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pending_webhook_submissions (
  id text PRIMARY KEY,
  application_id text NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  received_at timestamptz DEFAULT now(),
  raw_payload jsonb NOT NULL,
  source text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  reason text
);
CREATE INDEX IF NOT EXISTS idx_pending_webhooks_app ON pending_webhook_submissions(application_id);

-- ═══════════════════════════════════════════════════════════════════════
-- 11. UPLOAD MAPPINGS
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS upload_mappings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  application_id text NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  upload_type text NOT NULL, -- 'submissions', 'financial', 'call_results'
  entries jsonb NOT NULL,
  saved_at timestamptz DEFAULT now(),
  UNIQUE (application_id, upload_type)
);

-- ═══════════════════════════════════════════════════════════════════════
-- 12. SAVED CORRELATION FILTERS
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS saved_correlation_filters (
  id text PRIMARY KEY,
  application_id text NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  name text NOT NULL,
  conditions jsonb NOT NULL DEFAULT '[]',
  date_range jsonb
);
CREATE INDEX IF NOT EXISTS idx_saved_filters_app ON saved_correlation_filters(application_id);

-- ═══════════════════════════════════════════════════════════════════════
-- 13. CHAT MESSAGES (narrative, audit, grading_audit chats)
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS chat_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  application_id text NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  chat_type text NOT NULL, -- 'narrative', 'audit', 'grading_audit'
  role text NOT NULL,
  content text NOT NULL,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_app_type ON chat_messages(application_id, chat_type);

-- ═══════════════════════════════════════════════════════════════════════
-- 14. DATA CHATS (free-form AI conversations)
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS data_chats (
  id text PRIMARY KEY,
  application_id text NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  title text NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS data_chat_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chat_id text NOT NULL REFERENCES data_chats(id) ON DELETE CASCADE,
  role text NOT NULL,
  content text NOT NULL,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_data_chat_msgs ON data_chat_messages(chat_id);

-- ═══════════════════════════════════════════════════════════════════════
-- 15. LOAD HISTORY (undo mechanism)
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS load_history (
  id text PRIMARY KEY,
  application_id text NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  timestamp timestamptz DEFAULT now(),
  source_type text NOT NULL,
  description text NOT NULL,
  record_count int NOT NULL DEFAULT 0,
  pre_load_snapshot jsonb NOT NULL, -- Full snapshot kept as JSONB for undo restore
  source_data jsonb,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_load_history_app ON load_history(application_id);

-- ═══════════════════════════════════════════════════════════════════════
-- Enable Row Level Security (all tables default deny, service key bypasses)
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE submission_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_field_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_calculated_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_webhook_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE upload_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_correlation_filters ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE load_history ENABLE ROW LEVEL SECURITY;
