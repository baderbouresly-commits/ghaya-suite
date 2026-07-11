-- ============================================================
-- GHAYA SUITE — D1 SQLite Schema
-- All 17 tables — Kuwait Labour Law compliant
-- Run: wrangler d1 execute ghaya-db --file=schema.sql
-- ============================================================

PRAGMA foreign_keys = ON;

-- ─────────────────────────────────────────────
-- 1. COMPANIES (one row per tenant)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS companies (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name_en             TEXT NOT NULL,
  name_ar             TEXT,
  cr_number           TEXT,                    -- Commercial Registration
  pifss_number        TEXT,                    -- PIFSS employer number
  industry            TEXT,
  size_tier           TEXT CHECK(size_tier IN ('micro','small','growth','established')),
  managed_by_ghaya    INTEGER NOT NULL DEFAULT 0,  -- 0=self-serve, 1=managed
  subscription_tier   TEXT CHECK(subscription_tier IN ('kit','starter','growth','enterprise')),
  subscription_active INTEGER NOT NULL DEFAULT 1,
  logo_r2_key         TEXT,
  default_language    TEXT NOT NULL DEFAULT 'en' CHECK(default_language IN ('en','ar')),
  timezone            TEXT NOT NULL DEFAULT 'Asia/Kuwait',
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────────────────────────────
-- 2. USERS (login accounts, all roles)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  company_id          TEXT REFERENCES companies(id) ON DELETE CASCADE,
  email               TEXT NOT NULL UNIQUE,
  password_hash       TEXT NOT NULL,
  role                TEXT NOT NULL CHECK(role IN ('ghaya_admin','company_admin','manager','employee')),
  employee_id         TEXT,                    -- FK set after employees table created
  is_active           INTEGER NOT NULL DEFAULT 1,
  last_login_at       TEXT,
  password_reset_token TEXT,
  password_reset_expires TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ─────────────────────────────────────────────
-- 3. DEPARTMENTS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS departments (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name_en             TEXT NOT NULL,
  name_ar             TEXT,
  manager_employee_id TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_departments_company ON departments(company_id);

-- ─────────────────────────────────────────────
-- 4. JOB TITLES / POSITIONS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS job_titles (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title_en            TEXT NOT NULL,
  title_ar            TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────────────────────────────
-- 5. EMPLOYEES (the main HR record)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS employees (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id             TEXT REFERENCES users(id),
  employee_number     TEXT,
  first_name_en       TEXT NOT NULL,
  last_name_en        TEXT NOT NULL,
  first_name_ar       TEXT,
  last_name_ar        TEXT,
  civil_id            TEXT,
  nationality         TEXT,
  is_kuwaiti          INTEGER NOT NULL DEFAULT 0,  -- affects PIFSS calc
  gender              TEXT CHECK(gender IN ('male','female')),
  date_of_birth       TEXT,
  mobile              TEXT,
  personal_email      TEXT,
  work_email          TEXT,
  department_id       TEXT REFERENCES departments(id),
  job_title_id        TEXT REFERENCES job_titles(id),
  direct_manager_id   TEXT REFERENCES employees(id),
  employment_type     TEXT CHECK(employment_type IN ('full_time','part_time','contract','temporary')),
  hire_date           TEXT NOT NULL,
  probation_end_date  TEXT,
  termination_date    TEXT,
  termination_reason  TEXT,
  status              TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','on_leave','terminated','probation')),
  -- Salary & compensation
  basic_salary        REAL NOT NULL DEFAULT 0,
  housing_allowance   REAL NOT NULL DEFAULT 0,
  transport_allowance REAL NOT NULL DEFAULT 0,
  other_allowances    REAL NOT NULL DEFAULT 0,
  -- Kuwait law overrides (NULL = use company default)
  annual_leave_days   INTEGER,       -- Art. 70: min 30 days; can be more
  work_hours_per_day  REAL,          -- Art. 64: max 8 hrs/day
  overtime_rate       REAL,          -- Art. 66: min 1.25x (day), 1.5x (night/Fri), 2x (holiday)
  -- PIFSS
  pifss_enrolled      INTEGER NOT NULL DEFAULT 0,
  pifss_start_date    TEXT,
  photo_r2_key        TEXT,
  contract_r2_key     TEXT,
  notes               TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_employees_company ON employees(company_id);
CREATE INDEX IF NOT EXISTS idx_employees_dept ON employees(department_id);
CREATE INDEX IF NOT EXISTS idx_employees_manager ON employees(direct_manager_id);

-- Add FK from users back to employees
-- (SQLite doesn't support ADD CONSTRAINT; handle in app layer)

-- ─────────────────────────────────────────────
-- 6. COMPANY SETTINGS (law defaults + overrides)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS company_settings (
  id                      TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  company_id              TEXT NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  -- Leave settings (Kuwait Labour Law Art. 70)
  default_annual_leave    INTEGER NOT NULL DEFAULT 30,   -- Law min = 30 days
  default_sick_leave      INTEGER NOT NULL DEFAULT 15,   -- Art. 69
  default_maternity_leave INTEGER NOT NULL DEFAULT 70,   -- Art. 75
  default_paternity_leave INTEGER NOT NULL DEFAULT 3,
  default_unpaid_leave    INTEGER NOT NULL DEFAULT 0,
  -- Work settings (Art. 64-66)
  work_hours_per_day      REAL NOT NULL DEFAULT 8.0,
  work_days_per_week      INTEGER NOT NULL DEFAULT 5,
  overtime_rate_day       REAL NOT NULL DEFAULT 1.25,    -- Art. 66
  overtime_rate_night     REAL NOT NULL DEFAULT 1.50,
  overtime_rate_holiday   REAL NOT NULL DEFAULT 2.00,
  -- Indemnity settings (Arts. 51-54)
  indemnity_year1_rate    REAL NOT NULL DEFAULT 15.0,    -- 15 days per year (first 5 yrs)
  indemnity_year6_rate    REAL NOT NULL DEFAULT 30.0,    -- 1 month per year after
  -- PIFSS (Law 61/1976)
  pifss_employee_rate     REAL NOT NULL DEFAULT 0.05,    -- 5%
  pifss_employer_rate     REAL NOT NULL DEFAULT 0.11,    -- 11%
  -- Visibility toggles (what employees can see)
  show_salary_to_employee       INTEGER NOT NULL DEFAULT 1,
  show_leave_balance_to_employee INTEGER NOT NULL DEFAULT 1,
  show_payslips_to_employee     INTEGER NOT NULL DEFAULT 1,
  show_org_chart_to_employee    INTEGER NOT NULL DEFAULT 0,
  show_colleagues_to_employee   INTEGER NOT NULL DEFAULT 0,
  show_manager_to_employee      INTEGER NOT NULL DEFAULT 1,
  show_documents_to_employee    INTEGER NOT NULL DEFAULT 1,
  show_attendance_to_employee   INTEGER NOT NULL DEFAULT 1,
  -- Notifications
  notify_leave_request_admin    INTEGER NOT NULL DEFAULT 1,
  notify_leave_approved_employee INTEGER NOT NULL DEFAULT 1,
  notify_payslip_published      INTEGER NOT NULL DEFAULT 1,
  notify_contract_expiry_days   INTEGER NOT NULL DEFAULT 30,
  notify_probation_end_days     INTEGER NOT NULL DEFAULT 14,
  updated_at                    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────────────────────────────
-- 7. LEAVE TYPES
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leave_types (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name_en             TEXT NOT NULL,
  name_ar             TEXT,
  default_days        INTEGER NOT NULL DEFAULT 0,
  law_minimum_days    INTEGER NOT NULL DEFAULT 0,  -- Kuwait Labour Law reference
  is_paid             INTEGER NOT NULL DEFAULT 1,
  requires_approval   INTEGER NOT NULL DEFAULT 1,
  color               TEXT DEFAULT '#E8472A',      -- for calendar display
  is_active           INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────────────────────────────
-- 8. LEAVE BALANCES (per employee per year)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leave_balances (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id         TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type_id       TEXT NOT NULL REFERENCES leave_types(id),
  year                INTEGER NOT NULL,
  entitled_days       INTEGER NOT NULL DEFAULT 0,
  used_days           REAL NOT NULL DEFAULT 0,
  pending_days        REAL NOT NULL DEFAULT 0,
  carried_over_days   REAL NOT NULL DEFAULT 0,
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(employee_id, leave_type_id, year)
);

CREATE INDEX IF NOT EXISTS idx_leave_balances_employee ON leave_balances(employee_id);
CREATE INDEX IF NOT EXISTS idx_leave_balances_company ON leave_balances(company_id);

-- ─────────────────────────────────────────────
-- 9. LEAVE REQUESTS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leave_requests (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id         TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type_id       TEXT NOT NULL REFERENCES leave_types(id),
  start_date          TEXT NOT NULL,
  end_date            TEXT NOT NULL,
  days_count          REAL NOT NULL,
  reason              TEXT,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','cancelled')),
  approved_by         TEXT REFERENCES users(id),
  approved_at         TEXT,
  rejection_reason    TEXT,
  cover_employee_id   TEXT REFERENCES employees(id),
  attachment_r2_key   TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_leave_requests_employee ON leave_requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_leave_requests_company ON leave_requests(company_id);
CREATE INDEX IF NOT EXISTS idx_leave_requests_status ON leave_requests(status);

-- ─────────────────────────────────────────────
-- 10. ATTENDANCE
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attendance (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id         TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date           TEXT NOT NULL,
  check_in            TEXT,
  check_out           TEXT,
  hours_worked        REAL,
  overtime_hours      REAL NOT NULL DEFAULT 0,
  status              TEXT CHECK(status IN ('present','absent','late','half_day','holiday','weekend','on_leave')),
  notes               TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(employee_id, work_date)
);

CREATE INDEX IF NOT EXISTS idx_attendance_employee ON attendance(employee_id, work_date);
CREATE INDEX IF NOT EXISTS idx_attendance_company ON attendance(company_id, work_date);

-- ─────────────────────────────────────────────
-- 11. PAYROLL RUNS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payroll_runs (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period_month        INTEGER NOT NULL,
  period_year         INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','processing','approved','paid','locked')),
  total_gross         REAL NOT NULL DEFAULT 0,
  total_net           REAL NOT NULL DEFAULT 0,
  total_pifss_employee REAL NOT NULL DEFAULT 0,
  total_pifss_employer REAL NOT NULL DEFAULT 0,
  total_deductions    REAL NOT NULL DEFAULT 0,
  notes               TEXT,
  approved_by         TEXT REFERENCES users(id),
  approved_at         TEXT,
  paid_at             TEXT,
  created_by          TEXT REFERENCES users(id),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(company_id, period_month, period_year)
);

CREATE INDEX IF NOT EXISTS idx_payroll_runs_company ON payroll_runs(company_id);

-- ─────────────────────────────────────────────
-- 12. PAYROLL ENTRIES (one per employee per run)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payroll_entries (
  id                    TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  company_id            TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payroll_run_id        TEXT NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  employee_id           TEXT NOT NULL REFERENCES employees(id),
  basic_salary          REAL NOT NULL DEFAULT 0,
  housing_allowance     REAL NOT NULL DEFAULT 0,
  transport_allowance   REAL NOT NULL DEFAULT 0,
  other_allowances      REAL NOT NULL DEFAULT 0,
  gross_salary          REAL NOT NULL DEFAULT 0,
  overtime_pay          REAL NOT NULL DEFAULT 0,
  overtime_hours        REAL NOT NULL DEFAULT 0,
  pifss_employee        REAL NOT NULL DEFAULT 0,   -- 5% if Kuwaiti
  pifss_employer        REAL NOT NULL DEFAULT 0,   -- 11% if Kuwaiti
  deductions_other      REAL NOT NULL DEFAULT 0,
  advance_deduction     REAL NOT NULL DEFAULT 0,
  net_salary            REAL NOT NULL DEFAULT 0,
  days_worked           INTEGER,
  days_absent           INTEGER NOT NULL DEFAULT 0,
  leave_days            REAL NOT NULL DEFAULT 0,
  payslip_r2_key        TEXT,
  payslip_published     INTEGER NOT NULL DEFAULT 0,
  payslip_published_at  TEXT,
  notes                 TEXT,
  UNIQUE(payroll_run_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_payroll_entries_run ON payroll_entries(payroll_run_id);
CREATE INDEX IF NOT EXISTS idx_payroll_entries_employee ON payroll_entries(employee_id);

-- ─────────────────────────────────────────────
-- 13. DOCUMENT TYPES
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS document_types (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  company_id          TEXT REFERENCES companies(id) ON DELETE CASCADE,  -- NULL = system-wide
  name_en             TEXT NOT NULL,
  name_ar             TEXT,
  has_expiry          INTEGER NOT NULL DEFAULT 0,
  expiry_alert_days   INTEGER NOT NULL DEFAULT 30,
  is_required         INTEGER NOT NULL DEFAULT 0,
  category            TEXT CHECK(category IN ('identity','contract','education','medical','visa','other')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed system-wide document types
INSERT OR IGNORE INTO document_types (id, company_id, name_en, name_ar, has_expiry, category, is_required) VALUES
  ('dt-civil-id',     NULL, 'Civil ID',              'البطاقة المدنية',    1, 'identity',  1),
  ('dt-passport',     NULL, 'Passport',              'جواز السفر',         1, 'identity',  1),
  ('dt-residency',    NULL, 'Residency Permit (Iqama)', 'تصريح الإقامة',  1, 'visa',      0),
  ('dt-work-permit',  NULL, 'Work Permit',           'تصريح العمل',        1, 'visa',      0),
  ('dt-contract',     NULL, 'Employment Contract',   'عقد العمل',          0, 'contract',  1),
  ('dt-offer-letter', NULL, 'Offer Letter',          'خطاب العرض',         0, 'contract',  0),
  ('dt-medical',      NULL, 'Medical Certificate',   'شهادة طبية',         1, 'medical',   0),
  ('dt-education',    NULL, 'Educational Certificate','شهادة تعليمية',     0, 'education', 0),
  ('dt-noc',          NULL, 'No Objection Certificate','شهادة عدم ممانعة', 0, 'other',     0);

-- ─────────────────────────────────────────────
-- 14. EMPLOYEE DOCUMENTS (archive)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS employee_documents (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id         TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  document_type_id    TEXT NOT NULL REFERENCES document_types(id),
  file_name           TEXT NOT NULL,
  file_size           INTEGER,
  mime_type           TEXT,
  r2_key              TEXT NOT NULL,
  issue_date          TEXT,
  expiry_date         TEXT,
  document_number     TEXT,
  issuing_authority   TEXT,
  notes               TEXT,
  uploaded_by         TEXT REFERENCES users(id),
  is_verified         INTEGER NOT NULL DEFAULT 0,
  verified_by         TEXT REFERENCES users(id),
  verified_at         TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_emp_docs_employee ON employee_documents(employee_id);
CREATE INDEX IF NOT EXISTS idx_emp_docs_company ON employee_documents(company_id);
CREATE INDEX IF NOT EXISTS idx_emp_docs_expiry ON employee_documents(expiry_date) WHERE expiry_date IS NOT NULL;

-- ─────────────────────────────────────────────
-- 15. NOTIFICATIONS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type                TEXT NOT NULL,   -- e.g. 'leave_request','payslip_ready','doc_expiry'
  title_en            TEXT NOT NULL,
  title_ar            TEXT,
  body_en             TEXT,
  body_ar             TEXT,
  link                TEXT,
  is_read             INTEGER NOT NULL DEFAULT 0,
  read_at             TEXT,
  sent_email          INTEGER NOT NULL DEFAULT 0,
  email_sent_at       TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_company ON notifications(company_id);

-- ─────────────────────────────────────────────
-- 16. AUDIT LOG
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  company_id          TEXT REFERENCES companies(id),
  user_id             TEXT REFERENCES users(id),
  action              TEXT NOT NULL,   -- e.g. 'employee.create','leave.approve'
  entity_type         TEXT,            -- 'employee','leave_request','payroll_run' etc
  entity_id           TEXT,
  old_values          TEXT,            -- JSON
  new_values          TEXT,            -- JSON
  ip_address          TEXT,
  user_agent          TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_company ON audit_log(company_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);

-- ─────────────────────────────────────────────
-- 17. SYSTEM SETTINGS (Ghaya Super Admin level)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS system_settings (
  key                 TEXT PRIMARY KEY,
  value               TEXT NOT NULL,
  description         TEXT,
  updated_by          TEXT REFERENCES users(id),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Default system settings
INSERT OR IGNORE INTO system_settings (key, value, description) VALUES
  ('platform_name',         'Ghaya Suite',          'Platform display name'),
  ('support_email',         'support@ghaya.hr',     'Support contact email'),
  ('kuwait_law_version',    'Law No. 6/2010',       'Kuwait Labour Law version in use'),
  ('pifss_law_version',     'Law No. 61/1976',      'PIFSS Law version in use'),
  ('default_currency',      'KWD',                  'Default currency'),
  ('default_language',      'en',                   'Platform default language'),
  ('max_upload_size_mb',    '10',                   'Max file upload size in MB'),
  ('session_duration_hours','24',                   'JWT session duration in hours');

-- ─────────────────────────────────────────────
-- SESSIONS (JWT refresh tokens)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash          TEXT NOT NULL UNIQUE,
  expires_at          TEXT NOT NULL,
  ip_address          TEXT,
  user_agent          TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);

-- ─────────────────────────────────────────────
-- SEED: Default Ghaya Super Admin user
-- Password: GhayaAdmin2025! (change immediately after deploy)
-- bcrypt hash of GhayaAdmin2025! (cost 12) — replace with real hash in production
-- ─────────────────────────────────────────────
INSERT OR IGNORE INTO users (id, company_id, email, password_hash, role) VALUES
  ('ghaya-super-admin', NULL, 'admin@ghaya.hr', '$2b$12$PLACEHOLDER_CHANGE_THIS_HASH', 'ghaya_admin');
