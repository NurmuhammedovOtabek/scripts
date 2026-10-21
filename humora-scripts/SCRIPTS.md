# Humora — Scripts Documentation

Each script in this folder is responsible for fetching data from a specific external source and (optionally) persisting it to the database. This document describes what each script does, where it gets data from, and how it works.

---

## Table of Contents

| Script | External Source | DB Table | Captcha |
|--------|----------------|----------|---------|
| [bad-suppliers](#bad-suppliers) | xt-xarid.uz | `company_bad_suppliers` | No |
| [bank](#bank) | cs.egov.uz | — (lookup only) | No |
| [bank-registry](#bank-registry) | cs.egov.uz | `banks`, `bank_branches` | No |
| [chamber](#chamber) | chamber.uz | — (read-only) | No |
| [chamber-fill](#chamber-fill) | chamber.uz | `company_info` | No |
| [construction-rating](#construction-rating) | reyting.mc.uz | `company_construction_rating` | No |
| [court-cases](#court-cases) | sud.uz | — (read-only) | No |
| [davreestr](#davreestr) | davreestr.uz | — (read-only) | Bypass (token trick) |
| [garov](#garov) | garov.uz | `company_collaterals` | Bypass (token trick) |
| [itpark](#itpark) | it-park.uz | `company_info` | No |
| [large-taxpayer](#large-taxpayer) | old.soliq.uz | `company_tax` | No |
| [mib](#mib) | mib.uz | — (read-only) | OCR (Tesseract) |
| [nds](#nds) | my.soliq.uz | — (read-only) | No |
| [procurement](#procurement) | etender.uzex.uz, xarid.uzex.uz | — (read-only) | No |
| [registries](#registries) | data.egov.uz, cbu.uz, napp.uz, GxP / uzpharm-control APIs, e-ngo.uz, e-advokat.uz, it-park.uz | `registry_sources`, `company_registry_entries`, `registry_name_rows` | No |
| [sert](#sert) | sert2.standart.uz | — (read-only) | No |
| [sert-fill](#sert-fill) | sert2.standart.uz | `company_certificates` | No |
| [soato](#soato) | Bundled JSON file | `regions`, `districts`, `settlements` | No |
| [stat-registry](#stat-registry) | registr.stat.uz | — (read-only) | No |
| [state-assets](#state-assets) | data.egov.uz | `company_state_assets` | No |
| [state-participation](#state-participation) | data.egov.uz | `company_info` | No |
| [tax-debtor](#tax-debtor) | old.soliq.uz | `company_tax` | External solver |
| [tax-risk](#tax-risk) | old.soliq.uz | `company_tax` | External solver |

---

## bad-suppliers

**What it does:** Checks if a company is on the "unscrupulous suppliers" (vijdonsiz ta'minotchilar) blacklist used in government procurement.

**Source:** `https://api.xt-xarid.uz/rpc`  
**Method:** POST — JSON-RPC 2.0  
**Request:**
```json
{ "method": "ref", "params": { "ref": "ref_bad_suppliers", "op": "read", "q": {"INN": "{inn}"} } }
```

**Data returned:** `inn`, `name`, `note`, `date_begin`, `date_end`

**DB table:** `company_bad_suppliers`  
**DB operation:** UPSERT on `inn`

**Captcha:** None  
**Cache TTL:** None (checked on every request)

**Used in Humora:** Warning badge on company page (Asosiy ma'lumot section)

---

## bank

**What it does:** Resolves an MFO (bank routing code) to a bank name. Used when syncing company info that has a `bank_code` but no `bank_name`.

**Source:** `https://cs.egov.uz/apiData/MainData/Get`  
**Method:** POST  
**Query:** Filter by `BANK_ID: mfo`

**Data returned:** `{ bank_name, bank_code }`

**DB table:** None (lookup only, no writes)  
**Cache TTL:** None

**Captcha:** None

**Used in Humora:** Resolves bank name during `syncCompanyInfo` (company page → Contact → Bank details)

---

## bank-registry

**What it does:** Bulk syncs the full list of Uzbek banks (72 parent banks) and their branches (~3,600) from the government registry.

**Source:** `https://cs.egov.uz/apiData/MainData/Get`  
**Method:** POST  
**Datasets:**
- Banks: dataset ID `61a60296b83d3e9e6a91d8c8`
- Branches: dataset ID `61a5af415e335967803edc8b`

**Data returned:** Bank name, type, active status, dates; branch address, MFO, INN, region

**DB tables:** `banks`, `bank_branches`  
**DB operation:** UPSERT by primary key; batched 500 rows per insert  
**Timeout:** 60s

**Captcha:** None  
**Special:** One-shot bulk sync (fits in single response, no pagination needed)

**Used in Humora:** MFO → bank name lookup; bank branch search

---

## chamber

**What it does:** Fetches trust/reliability score for a company from the Chamber of Commerce rating API.

**Source:** `https://admin.chamber.uz/api/GetCompanyCriteries/{inn}`  
**Method:** GET

**Data returned:** `trust` (0–100 score), `score`, `is_large_taxpayer` flag, `oked_description`

**DB table:** None (read-only; writes done via `chamber-fill`)  
**Cache TTL:** None  
**Timeout:** 15s  
**Note:** SSL certificate verification disabled (`rejectUnauthorized: false`)

**Captcha:** None

**Used in Humora:** Company trust rating badge; `syncCompanyInfo` merges this into `company_info`

---

## chamber-fill

**What it does:** Bulk fills chamber rating data (`trust`, `score`) for all companies in the DB that have `trust IS NULL`.

**Source:** `https://admin.chamber.uz/api/GetCompanyCriteries/{inn}`  
**Method:** GET per INN

**DB table:** `company_info`  
**DB operation:** UPDATE `trust`, `score` WHERE `inn`

**Captcha:** None  
**Special:**
- Cursor-based progress (processes companies with `trust IS NULL`)
- Detects IP blocks on connection errors → pauses 3 minutes
- 3-retry backoff per INN
- HTTP 500 = company not rated (treated as OK, skipped)
- Telegram progress alerts

**Used in Humora:** Populates rating for new companies added to DB

---

## construction-rating

**What it does:** Fetches construction company ratings (building contractors, road builders, irrigation, design firms) from the Ministry of Construction rating system.

**Source:**
- Live per INN: `https://japi-reyting.mc.uz/api/v1/statistic/check-inn/{inn}`
- Bulk sync: `https://japi-reyting.mc.uz/api/v2/category/all?type=0-3&page=N&perPage=200`

**Method:** GET

**Data returned:** `inn`, `type` (0=general/1=road/2=irrigation/3=design), `name`, `rating` score, `rank`, `status`, `viloyat_name`, `sumbal`

**DB table:** `company_construction_rating`  
**DB operation:** UPSERT on `(inn, type)`  
**Cache TTL:** 20 hours (Redis)

**Captcha:** None  
**Special:** Ratings change daily → live fetch on cache miss; bulk sync on schedule (~22k companies)

**Used in Humora:** "Sohaviy reyting" tab on company page (construction companies only)

---

## court-cases

**What it does:** Fetches all court cases (economic, civil, criminal, administrative) for a company by INN.

**Source:**
- Economic: `https://jadval.sud.uz/case/findByTin/{inn}`
- Civil/Criminal/Administrative: `https://jadvalapi.sud.uz/online-monitoring/{type}/findByTin/{inn}`

**Method:** GET  
**Parallel:** All 4 court types queried simultaneously

**Data returned:** `casenumber`, `category`, `type`, `claimant`, `defendant`, `court`, `region`, `responsible` (judge), `reg_date`, `hearing_date`, `status`, `result`, `article`, `file` (decision documents)

**DB table:** None (read-only)  
**Cache TTL:** None  
**Deduplication:** By `casenumber` across all 4 sources

**Captcha:** None

**Used in Humora:** "Sud ishlari" tab on company page

---

## davreestr

**What it does:** Fetches real estate and cadastre (land registry) data for a company from the State Cadastre Registry.

**Source:** `https://davreestr.uz`  
**Method:** GET (session init) + POST (form search)  
**Endpoints:** `/uz` (init), `/data/get-info/search` (by STIR/TIN), `/data/get-info/cadastr-number` (by CAD number)

**Data returned:** Cadastral numbers, addresses, areas, ownership details, restrictions

**DB table:** None (read-only; results cached and stored via `org-data.service`)  
**Cache TTL:** 24 hours (only successful results)  
**Timeout:** Per request 15s

**Captcha:** Bypass — random 6-char token sent identically in both `Cookie` header and form body field. davreestr.uz only string-compares these; no image captcha.  
**Rate limit:** ~15 req/min (X-RateLimit headers); session rotates User-Agent  
**Special:**
- Session refresh on HTTP 419 (expired token)
- 3 retry attempts on captcha error
- Dummy CAD number detection (`99:99:99:99:99:9999`)

**Used in Humora:** "Ko'chmas mulk" tab (cadastre + buildings)

---

## garov

**What it does:** Fetches collateral (pledge/mortgage) records for a company from the State Collateral Registry.

**Source:** `https://www.garov.uz/record/getDeclarationOrderSearchWA`  
**Method:** POST (JSON)

**Data returned:** `code`, `debtor_name`, `state` (active/resolved), `creditor_name`, `creditor_phone`, `printable`

**DB table:** `company_collaterals`  
**DB operation:** UPSERT keyed on `(code, creditor_name)` — pledge code alone is not unique (consortium loans)  
**Cache TTL:** 24 hours (Redis)  
**Dataset:** ~127M rows pre-synced

**Captcha:** Bypass — random token sent in both `Cookie: captcha=` and JSON body field `captcha`. garov.uz string-compares only.  
**Rate limit:** ~2 req/sec (serial queue)  
**Special:**
- Always fetches fresh from garov.uz on cache miss (guarantees active/inactive state is current)
- Throttled Telegram alerts on hard failures
- State changes (`active → resolved`) trigger DB update; unchanged state is skipped

**Used in Humora:** "Garovlar va yuklamalar" tab on company page

---

## itpark

**What it does:** Bulk-checks which companies are registered as IT Park residents and updates the flag in the database.

**Source:** `https://www.it-park.uz/uz/itpark/residents/itpark-residents`  
**Method:** GET (HTML page)

**Data returned:** List of INN numbers extracted from HTML via regex `data-val="inn"[^>]*>(\d{9})`

**DB table:** `company_info`  
**DB operation:**
- `UPDATE itpark=true WHERE inn IN (...)`
- `UPDATE itpark=false WHERE itpark=true AND inn NOT IN (...)`

**Captcha:** None  
**Special:** One-shot bulk sync per trigger; no per-INN caching. Resets all non-residents on each run.

**Used in Humora:** "IT Park" field in company info; IT Park badge on company page

---

## large-taxpayer

**What it does:** Checks if a company is on the "large taxpayer" (yirik soliq to'lovchi) registry.

**Source:** `https://old.soliq.uz/activities/list?tin={inn}&sEcho=1&iDisplayStart=0&iDisplayLength=10`  
**Method:** GET

**Data returned:** `tin`, `name`, `ns10Name` (region), `ns11Name` (district), `in_list` (boolean)

**DB table:** `company_tax`  
**DB operation:** Upsert via SELECT-then-UPDATE/INSERT (preserves other tax data)  
**Timeout:** 15s

**Captcha:** None

**Used in Humora:** "Katta soliq to'lovchi" field in tax info tab; affects risk scoring

---

## mib

**What it does:** Checks if a company has active enforcement proceedings (MIB — Majburiy Ijro Byurosi / Bailiff Service debts).

**Source:** `https://mib.uz`  
**Method:** GET (pages) + POST (form submission, Wicket framework)

**Data returned:** `debts[]` with `case_number`, `debtor_name`, `doc_status`, `description`, `region`, `creditor`, `amount`, `total_debt`

**DB table:** None (read-only)  
**Cache TTL:** None

**Captcha:** Math expression in Cyrillic text (e.g., "ikki + besh = ?"). Solved via:
- Image capture from `/captcha` endpoint
- Tesseract OCR (Russian language model)
- 5 image preprocessing strategies (resize, greyscale, threshold, invert, raw)
- Max 3 attempts  
**Special:** Wicket AJAX form session management; session token/cookie critical; URL cleanup (`;jsessionid` strip)

**Used in Humora:** "MIB qarzlari" tab on company page

---

## nds

**What it does:** Checks a company's VAT (NDS — Qo'shilgan Qiymat Solig'i) status — whether VAT is active, suspended, or being abused.

**Source:** `https://my.soliq.uz/nds/list-grid`  
**Method:** POST (form data: `ns10Code`, `ns11Code`, `searchText=INN`)

**Data returned:** `is_abuse_vat` (boolean — true if VAT certificate cancelled/abused), `nds_state` (state code), `nds_state_text`

**DB table:** None (read-only)  
**Cache TTL:** None  
**Timeout:** 15s

**Captcha:** None  
**Detection:** `is_abuse_vat=true` when `stateText` contains "бекор" (cancelled in Cyrillic)

**Used in Humora:** VAT status field in "Soliq ma'lumotlari" tab; affects trust rating

---

## procurement

**What it does:** Fetches government procurement (tender) data — deals, active trades, and direct purchases — for a company.

**Sources:**
- Tender deals: `https://apietender.uzex.uz/api/common/DealsList`
- Active trades: `https://apietender.uzex.uz/api/common/TradeList`
- Direct purchases: `https://xarid-api-purchase.uzex.uz/Common/GetDirectPurchases`

**Method:** POST  
**Roles:** customer (xaridor) or provider (yetkazib beruvchi)

**Data returned:**
- `DealsList`: `lot_display_no`, `customer_name/inn`, `provider_name/inn`, `amount`, `deal_cost`, `category_name`, `status`, `is_completed`
- `DirectPurchases`: `contract_num`, `contract_date`, `contract_sum`, `customer_name/inn`, `provider_name/inn`, `typ_direct_purchase_name`, `decree_name`, `status_name`

**DB table:** None (read-only; paginated directly from API)  
**Cache TTL:** None  
**Timeout:** 15s  

**Captcha:** None

**Used in Humora:** "Bitimlar" tab (tender deals) and "To'g'ridan-to'g'ri xaridlar" tab on company page

---

## registries

**What it does:** Keeps 34 open registers that list companies of one kind — licence and certificate holders, members, benefit recipients — in one store, one adapter per register (`registries/adapters/*`, catalogue `registries/registry-catalog.ts`). Engine: `RegistriesSyncService`; details and rules in `CLAUDE.md` → *Open registers*.

**Sources:** data.egov.uz (`POST /apiClient/Main/GetMainData`, `GET /apiClient/Main/GetById`), cbu.uz register pages → XLSX, napp.uz HTML tables, `api.gxp-application.pharmagency.uz` (Spring pages), `back.uzpharm-control.uz` (Django REST, never `drugs/`), `e-ngo.uz/front/registry_ajax` (cookie + XHR), `api.e-advokat.uz/api/v.1/getInfo/contragentList` (POST), it-park.uz residents page. Four registers come only as files an admin posts (`POST /registries-sync/upload`).

**Schedule:** 03:10 Mon–Sat the daily registers; Sunday 04:30 chain the rest (monthly ones on the first Sunday); first fill of an empty store. `REGISTRIES_SYNC_ENABLED=1|0`. Lock 8_150_944, `job_runs` `registries`, Telegram `#registries`.

**Pacing:** ≥1.5 s between requests to one host; a 403/429 stops that register for the run. A whole read is ~620 requests (about 25 min), most of it the retail drug licences (20 a page).

**DB operation:** Compare by content hash; insert / update with the replaced values in `company_change_log` / mark listed again; a complete read delists what is gone (never deletes). An incomplete or too-small read writes nothing.

**Used in Humora:** "Reyestrlar" tab (beta key `registries`, `GET /org/registries/inn/:inn`); partner `GET /partner/org/registries/inn/:inn`.

---

## sert

**What it does:** Fetches product conformity certificates (sertifikatlar) for a company from the National Certification Centre.

**Source:** `http://sert2.standart.uz/site/register?Search[inn]={inn}`  
**Method:** GET (session init) + GET (search)

**Data returned:** `cert_body`, `blank_number`, `registry_number`, `issued_date`, `expiry_date`, `product_name`, `scheme`, `applicant_inn`, `tnved_code`, `applicant_name`, `country`, `status`

**DB table:** None (read-only; writes done via `sert-fill`)  
**Cache TTL:** None  
**Timeout:** 30s  

**Captcha:** None  
**Special:** Session cookies required. HTTP 302 = expired session → auto-refresh once. HTML table parsing via cheerio.

**Used in Humora:** "Sertifikatlar" tab on company page

---

## sert-fill

**What it does:** Bulk syncs all certificates for companies in the DB from the National Certification Centre.

**Source:** `http://sert2.standart.uz/site/register`  
**Method:** GET per INN

**DB table:** `company_certificates`  
**DB operation:** UPSERT on `(inn, registry_number)` — uses `RETURNING xmax=0 AS is_insert` to count new vs updated rows  
**Concurrency:** 5 workers (tested safe; 40 workers caused blocks)

**Captcha:** None  
**Special:**
- Each worker maintains its own session; resets on error
- Batch size 200 rows, cursor tracks progress
- Telegram alerts every 2,000 rows processed
- Progress counter: inserts vs updates

---

## soato

**What it does:** Seeds the geographic reference tables (regions, districts, settlements) from a bundled JSON file. One-shot operation, no external API calls.

**Source:** Bundled JSON file `soato_seed.json` (committed to repo)  
**Method:** File I/O — no HTTP

**Data returned:** SOATO codes + Uzbek/Russian names for 14 regions, 232 districts, 3,054 settlements

**DB tables:** `regions`, `districts`, `settlements`  
**DB operation:** UPSERT by primary key (code); batched 500 rows; optional TRUNCATE CASCADE  
**Special:** Idempotent — safe to re-run. Settlement rows denormalize `region_code` (first 4 digits of SOATO code) for fast filtering.

**Captcha:** None  
**External API:** None

**Used in Humora:** Address display; region/district filters in search

---

## stat-registry

**What it does:** Fetches official company registration data from the State Statistics Committee registry, including founders with real ownership percentages.

**Source:** `https://registr.stat.uz`  
**Method:** GET (session) + POST (search form)  
**Form fields:** `OKPO={inn}`, `lang=0`, `submit=`  
**HTML target:** Table with `id="demo2"`

**Data returned:** `inn`, `company_name`, `registration_date`, `registration_number`, `registration_center`, `director_name`, `address`, `email`, `phone`, `statutory_fund`, `activity_state`, `oked_code`, `oked_description`, `opf_code`, `founders[]` (with real ownership %)

**DB table:** None (read-only)  
**Cache TTL:** None  
**Timeout:** 20s

**Captcha:** None  
**Special:** Cookie management (`PHPSESSID`). Raises on HTTP 302 or missing `demo2` element. **Founders from this source have correct percentages** — myorg.uz returns placeholder 10% for all founders; stat-registry has real charter data.

**Used in Humora:** `syncCompanyInfo` — founders enrichment (primary override over myorg founders data)

---

## state-assets

**What it does:** Bulk imports state-owned assets (vehicles, buildings, other property) belonging to state-participated companies.

**Source:** `https://data.egov.uz/apiData/MainData/GetByFile`  
**Dataset ID:** `61f122c4a6060ddf7ed388da`  
**Method:** GET (entire dataset in one response)

**Data returned:** `KorxonaSTIR` (INN), `Korxonanomi` (org name), `Nomi` (asset name), `Yili` (year)  
**Classification:** Asset name normalized → `vehicle` / `building` / `other`

**DB table:** `company_state_assets`  
**DB operation:** Batch INSERT 500 rows; optional TRUNCATE before insert  
**Timeout:** 120s, 100MB max body

**Captcha:** None  
**Special:** Entire dataset in one response (no pagination). Returns counts per asset type.

**Used in Humora:** "Davlat aktivlari" tab on company page (state-participated companies only)

---

## state-participation

**What it does:** Checks what percentage of a company is owned by the state and which government entity it falls under.

**Source:** `https://data.egov.uz/apiClient/Main/GetMainData?GuidId=6110bec8db32b99538e08167`  
**Method:** POST  
**Dataset:** ~1,852 state-participated companies

**Data returned:** `inn`, `share_percent` (0–100), `superior_organization` (which government body oversees it)

**DB table:** `company_info`  
**DB operation:** UPDATE `state_share_percent`, `superior_organization` via bulk VALUES  
**Cache TTL:** 24 hours (Redis)

**Lookup order:** Redis cache → live API + DB update → DB fallback  
**Captcha:** None  
**Timeout:** 15s

**Used in Humora:** "Davlat tassarufidagi tashkilot: Ha/Yo'q" field in company info; previously shown as blue banner (now simple field)

---

## tax-debtor

**What it does:** Checks if a company has outstanding tax debt (soliq qarzdori) and retrieves the debt amount.

**Source:** `https://old.soliq.uz/activities/debtor`  
**Method:** GET (page + captcha) + POST (form submit)

**Data returned:** `tin`, `name`, `region`, `entity_type`, `sum_debt` (in UZS), `in_debtor_list` (boolean)

**DB tables:**
- `company_tax` — current amount (`tax_debt_total`, `has_tax_debt`, `tax_debt_checked_at`). Upsert via SELECT-then-UPDATE/INSERT, preserving VAT and taxpayer-type data written by other sources.
- `company_tax_debts` — debt episodes. One row per continuous period of owed tax: opens when `sum_debt > 0`, tracks current and peak amounts, resolves when the debt reaches zero.

**Important:** this endpoint is a *company lookup*, not a debtor-list membership test. It returns `success: true` for any valid INN. The only truthful debt signal is `sum_debt > 0`. (The `in_debtor_list` field is a misnomer — it means "company found".)

**Re-check:** `TaxDebtorCronService` re-checks active episodes nightly at 02:00 Asia/Tashkent, so paid debts resolve without waiting for a page view.

**Read API:** `GET /org/tax-debt/inn/:inn`

**Captcha:** 4-digit image captcha. Solved via external `captcha-solver` service (likely 2captcha/anti-captcha).  
**Special:**
- Serial queue for session consistency
- Max 10 attempts per INN
- Pattern matching for Uzbek/Russian captcha error messages
- Returns `attempts` count in result

**Cache TTL:** None  
**Timeout:** 15s

**Used in Humora:** "Soliq qarzi" field in tax info tab; shown with masking for non-premium users

---

## tax-risk

**What it does:** Checks a company's tax risk classification (trusted vs suspicious) and money laundering (obnal) signals.

**Source:** `https://old.soliq.uz/activities/tax-risk-analysis`  
**Method:** GET (page + captcha) + POST (form submit)

**Data returned:** `tin`, `name`, `region`, `status` ("Ishonchli" / "Shubhali"), `obnal` (money laundering flag), `vat_state`, `tax_gap`, `reg_date`

**DB table:** `company_tax`  
**DB operation:** Upsert via SELECT-then-UPDATE/INSERT (preserves other tax data)

**Captcha:** Same as `tax-debtor` — 4-digit image captcha via external solver. `CAPTCHA_ID` cookie is critical (must be set by `/activities/captcha` endpoint and persist across requests).  
**Special:**
- Serial queue
- Max 10 attempts
- Returns raw response for debugging

**Cache TTL:** None  
**Timeout:** 15s

**Used in Humora:** Tax risk status in "Soliq ma'lumotlari" tab; `tax_risk_status` field in company_tax

---

## Shared Utilities

### html-parser
Cheerio-based HTML parser used by stat-registry and sert for table extraction.

### common/captcha-solver.client.ts
HTTP client that sends captcha images to an external solving service. Used by `tax-debtor` and `tax-risk`.

### common/telegram-alert.service.ts
Throttled Telegram notifications for script failures. Used by `chamber-fill`, `garov`, `sert-fill`, and others.

### davreestr/user-agent.pool.ts
Rotating pool of browser User-Agent strings for davreestr session management.
