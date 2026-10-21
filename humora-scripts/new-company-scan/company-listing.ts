import { DataSource } from 'typeorm';
import { MysoliqCompanyData } from '../../mysoliq/mysoliq-data.service';
import { companyLocationChanged } from '../../common/mahalla/company-location-events';
import { classifyDbFailure } from '../../common/db-failure';

/**
 * A registration date the column can take, or null.
 *
 * mysoliq's date is converted to YYYY-MM-DD when it arrives as DD.MM.YYYY and
 * passed through untouched otherwise. Anything else would make Postgres refuse
 * the whole row, and the company would miss being listed over a detail the
 * first full sync fills in anyway.
 */
export function registrationDateOf(value: unknown): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value ?? ''));
  return match ? match[1] : null;
}

/**
 * Lists a company with what mysoliq said about it.
 *
 * Two callers land a company here: the new-company scan, walking the STIR
 * counter, and the STIR lookup behind the search box, when someone types a
 * company we do not hold yet.
 *
 * The columns and their values are the ones `syncCompanyInfo` merges from the
 * same mysoliq call, so the first full sync finds them unchanged. Local copies
 * have no unique key on `company_info.inn`, hence NOT EXISTS rather than
 * ON CONFLICT. Answers whether a row was written; a refusal from the table is
 * thrown for the caller to count.
 *
 * NOT EXISTS is not race-proof: a search for the same STIR can insert between
 * the check and the write (production and dev do have `company_info_inn_key`).
 * That unique violation means the company is there — not written by us, and
 * not an error (see `insertCompanyInfoOrFill` for the search's side).
 */
export async function listCompanyFromMysoliq(
  db: Pick<DataSource, 'query'>,
  inn: string,
  company: MysoliqCompanyData,
): Promise<boolean> {
  let rows: Array<{ inn: string }>;
  try {
    rows = await insertListing(db, inn, company);
  } catch (err) {
    if (classifyDbFailure(err)?.code === '23505') return false;
    throw err;
  }
  // A listed company gets its mahalla (company_mahalla) at once, from the
  // street line and the ns10/ns11 pair — it carries no soato_code yet.
  if (rows.length > 0) companyLocationChanged(inn);
  return rows.length > 0;
}

function insertListing(
  db: Pick<DataSource, 'query'>,
  inn: string,
  company: MysoliqCompanyData,
): Promise<Array<{ inn: string }>> {
  return db.query(
    `INSERT INTO public.company_info
       (inn, company_name, short_name, director_name, director_tin,
        director_pinfl, street_address, oked_code, status, status_description,
        activity_state, registration_date, bank_code, bank_account_number,
        is_budget, accountant, ns10_code, ns11_code, created_at, updated_at)
     SELECT $1::text, $2::text, $3::text, $4::text, $5::text,
            $6::text, $7::text, $8::text, $9::text, $10::text,
            $11::bigint, $12::date, $13::text, $14::text,
            $15::boolean, $16::text, $17::bigint, $18::bigint, now(), now()
      WHERE NOT EXISTS (
        SELECT 1 FROM public.company_info WHERE inn = $1::text
      )
     RETURNING inn`,
    [
      inn,
      company.company_name,
      company.short_name,
      company.director_name,
      company.director_tin,
      company.director_pinfl,
      company.street_address,
      company.oked_code,
      company.status,
      company.status_description,
      company.activity_state,
      registrationDateOf(company.registration_date),
      company.bank_code,
      company.bank_account_number,
      company.is_budget,
      company.accountant,
      company.ns10_code,
      company.ns11_code,
    ],
  );
}
