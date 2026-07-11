# Ghaya Suite — Cloudflare Deployment Guide

## Prerequisites
- Cloudflare account (free tier works)
- Node.js installed on your computer
- Wrangler CLI: `npm install -g wrangler`

---

## Step 1 — Login to Cloudflare
```bash
wrangler login
```
This opens a browser. Approve access.

---

## Step 2 — Create D1 Database
```bash
wrangler d1 create ghaya-db
```
Copy the `database_id` it prints. Paste it into `wrangler.toml`:
```toml
database_id = "548be003-b8ca-417c-b0f1-03dad840fe92"
```

---

## Step 3 — Create R2 Bucket
```bash
wrangler r2 bucket create ghaya-files
```

---

## Step 4 — Set JWT Secret
Generate a random 64-character string and put it in wrangler.toml:
```bash
# One way to generate it:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Paste the result as `JWT_SECRET` in `wrangler.toml`.

---

## Step 5 — Run Database Schema
```bash
wrangler d1 execute ghaya-db --file=schema.sql
```
This creates all 17 tables and seeds the system settings + document types.

---

## Step 6 — Deploy to Cloudflare Pages

### Option A: Git deploy (recommended for ongoing updates)
1. Push this folder to a GitHub repo
2. Go to Cloudflare Dashboard → Pages → Create a Project
3. Connect your GitHub repo
4. Set build config:
   - Build command: *(leave empty)*
   - Build output directory: `public`
5. Add environment variables (from wrangler.toml):
   - `JWT_SECRET` = your secret
   - `ENVIRONMENT` = production
6. Under Functions → D1 Database Bindings → Add `DB` → select `ghaya-db`
7. Under Functions → R2 Bucket Bindings → Add `R2` → select `ghaya-files`
8. Deploy!

### Option B: Direct upload (fastest to test)
```bash
wrangler pages deploy public --project-name=ghaya-suite
```
Note: For Pages Functions (the `/functions/` folder), use Option A or the Pages Dashboard.

---

## Step 7 — Set Your Admin Password

After deploy, visit your site URL. The default super admin login is:
- **Email:** `admin@ghaya.hr`
- **Password:** `GhayaAdmin2025!`

Immediately after first login, go to your profile and change the password.

---

## Step 8 — Create First Company

Using the Ghaya Super Admin dashboard (`/ghaya/`):
1. Click "Add Company"
2. Fill in company details
3. Set `managed_by_ghaya = true` if you're handling their HR, or `false` if they self-serve
4. Create a Company Admin user for them

---

## Folder Structure
```
ghaya-suite/
├── schema.sql                    ← Run once on D1
├── wrangler.toml                 ← Cloudflare config
├── functions/                    ← Backend API (Pages Functions)
│   ├── _middleware.js            ← CORS
│   └── api/
│       ├── _lib/auth.js          ← JWT + password helpers
│       ├── auth/
│       │   ├── login.js          ← POST /api/auth/login
│       │   ├── me.js             ← GET /api/auth/me
│       │   └── set-password.js   ← POST /api/auth/set-password
│       ├── employees/
│       │   └── [[route]].js      ← CRUD /api/employees/*
│       ├── leaves/
│       │   └── [[route]].js      ← /api/leaves/*
│       └── dashboard/
│           └── index.js          ← GET /api/dashboard
└── public/                       ← Frontend (Cloudflare Pages)
    ├── index.html                ← Login page
    ├── employee/
    │   └── index.html            ← Employee dashboard
    ├── admin/
    │   └── index.html            ← Company Admin dashboard
    └── ghaya/
        └── index.html            ← Ghaya Super Admin (build next)
```

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/login` | Login, returns JWT |
| GET | `/api/auth/me` | Get current user |
| POST | `/api/auth/set-password` | Change password |
| GET | `/api/dashboard` | Role-based dashboard data |
| GET | `/api/employees` | List employees |
| POST | `/api/employees` | Create employee |
| GET | `/api/employees/:id` | Get employee |
| PUT | `/api/employees/:id` | Update employee |
| GET | `/api/leaves` | List leave requests |
| POST | `/api/leaves` | Submit leave request |
| PUT | `/api/leaves/:id` | Approve/reject leave |
| GET | `/api/leaves/balance` | Leave balances |
| GET | `/api/leaves/types` | Leave types |

---

## Kuwait Labour Law Defaults

All enforced in `schema.sql` company_settings defaults:
- Annual Leave: 30 days minimum (Art. 70)
- Sick Leave: 15 days (Art. 69)
- Maternity Leave: 70 days (Art. 75)
- Overtime Day Rate: 1.25x (Art. 66)
- Overtime Night/Fri Rate: 1.50x
- Overtime Holiday Rate: 2.00x
- PIFSS Employee: 5% (Law 61/1976)
- PIFSS Employer: 11% (Law 61/1976)

Admins can increase these but NOT decrease below law minimums.

---

## Next Steps (after first deploy works)
1. Build `/public/ghaya/index.html` — Super Admin dashboard
2. Build `/public/admin/employees.html` — Employee list + add form
3. Build `/public/admin/payroll.html` — Payroll runner
4. Add `/functions/api/payroll/[[route]].js` — Payroll engine with Kuwait law calculations
5. Add `/functions/api/companies/[[route]].js` — Company management (for Ghaya admin)
6. Add email notifications (Cloudflare Email Workers or SendGrid)
7. Add R2 file upload for employee documents
8. Buy domain → ghaya.hr → connect to Cloudflare Pages
