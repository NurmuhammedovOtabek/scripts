import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { mapGovLicense } from './gov-license.mapper';
import { logFieldChanges } from '../../common/change-log';

/**
 * What the registry says about a permit's standing. Written as sent, empty
 * included: a suspension lifted or an expiry date dropped is itself news.
 *
 * Every other column describes the permit, and there an empty value keeps
 * what is stored — the registry leaving an address or the issuing officer out
 * of one answer does not mean the permit lost them.
 */
const STANDING_COLUMNS = new Set([
  'status_code',
  'is_active',
  'validity',
  'revoke_date',
  'suspension_begin',
  'suspension_end',
]);

/**
 * Persistence for permits fetched from license.gov.uz.
 *
 * Separate from OrgDataService so the queue worker can write without importing
 * the service that enqueues, which would be circular.
 */
@Injectable()
export class GovLicenseStore {
  private readonly logger = new Logger(GovLicenseStore.name);

  constructor(@InjectDataSource('flottDb') private readonly db: DataSource) {}

  /**
   * Upsert permits, keyed on the registry's own uuid so one that changes state
   * — suspended, revoked, renewed — updates in place instead of appearing
   * twice. Nothing is ever deleted, and a value is cleared only where the
   * registry's answer is about standing (STANDING_COLUMNS).
   */
  async save(inn: string, raw: any[]): Promise<number> {
    const rows = raw.map((r) => mapGovLicense(inn, r)).filter((r) => r.uuid);
    if (rows.length === 0) {
      this.logger.warn(
        `[licenses] inn=${inn}: ${raw.length} record(s) carried no uuid — nothing stored`,
      );
      return 0;
    }

    const cols = Object.keys(rows[0]) as (keyof (typeof rows)[0])[];
    const updatable = cols.filter((c) => c !== 'inn' && c !== 'uuid');
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const setClause = updatable
      .map((c) =>
        STANDING_COLUMNS.has(String(c))
          ? `${String(c)} = EXCLUDED.${String(c)}`
          : `${String(c)} = COALESCE(EXCLUDED.${String(c)}, company_licenses.${String(c)})`,
      )
      .join(', ');
    const sql = `INSERT INTO public.company_licenses
        (${cols.map(String).join(', ')}, source, created_at, updated_at)
      VALUES (${placeholders}, 'license.gov.uz', now(), now())
      ON CONFLICT (uuid) WHERE uuid IS NOT NULL
      DO UPDATE SET ${setClause}, updated_at = now()`;

    /**
     * Claims the row a permit already has under an older source.
     *
     * Permits used to come from myorg, and those rows carry no registry uuid,
     * so the upsert above cannot match them — its unique key is partial
     * (`WHERE uuid IS NOT NULL`). Left alone, refreshing INN 202099756 would
     * have written the registry's forty-six alongside the ten already there:
     * fifty-six rows for forty-six permits, ten of them the same document
     * twice.
     *
     * They are the same documents. Checked against the live registry: all ten
     * of that company's stored `register_number`s appear in the forty-six, and
     * so do all ten `number`s. So the old row is updated in place — it gains
     * the uuid and the registry's fields, and keeps its `license_id`, which
     * anything referring to it still points at.
     *
     * Only rows without a uuid are claimable, and only one per permit
     * (`LIMIT 1`), so this can never overwrite a registry row or collapse two
     * distinct permits into one.
     */
    // Same parameter order as the insert, so one `values` array serves both.
    const at = (c: string) => `$${cols.indexOf(c as never) + 1}`;
    // The older row's own values stand where the registry sends nothing, the
    // same rule as the upsert; the key columns and standing are the registry's.
    const claimValue = (c: string) =>
      c === 'inn' || c === 'uuid' || STANDING_COLUMNS.has(c)
        ? at(c)
        : `COALESCE(${at(c)}, ${c})`;
    const claimSql = `UPDATE public.company_licenses SET
        ${cols.map((c) => `${String(c)} = ${claimValue(String(c))}`).join(', ')},
        source = 'license.gov.uz', updated_at = now()
      WHERE license_id = (
        SELECT license_id FROM public.company_licenses
         WHERE inn = ${at('inn')}
           AND uuid IS NULL
           AND register_number IS NOT NULL
           AND register_number = ${at('register_number')}
         ORDER BY license_id
         LIMIT 1
      )`;

    // Standing as stored, so a suspension lifted or a revocation is kept in
    // company_change_log rather than overwritten without a trace.
    const standing = [...STANDING_COLUMNS];
    const stored: any[] = await this.db.query(
      `SELECT uuid, ${standing.join(', ')}
         FROM public.company_licenses
        WHERE inn = $1 AND uuid = ANY($2)`,
      [inn, rows.map((r) => r.uuid)],
    );
    const storedByUuid = new Map((stored ?? []).map((r) => [r.uuid, r]));

    let saved = 0;
    let upgraded = 0;
    for (const row of rows) {
      const values = cols.map((c) => row[c]);

      // Upgrade first: an insert would succeed on its own and leave the older
      // copy behind, which is the outcome being avoided.
      if (row.register_number) {
        const res = await this.db.query(claimSql, values);
        if ((res?.rowCount ?? 0) > 0) {
          upgraded++;
          saved++;
          continue;
        }
      }

      await this.db.query(sql, values);
      saved++;
      await logFieldChanges(
        this.db,
        {
          entity: 'company_licenses',
          inn,
          key: row.uuid,
          source: 'license.gov.uz',
        },
        storedByUuid.get(row.uuid),
        row as unknown as Record<string, any>,
        standing,
      ).catch((e) =>
        this.logger.warn(`[licenses] change log ${row.uuid}: ${e.message}`),
      );
    }

    this.logger.log(
      `[licenses] inn=${inn}: stored ${saved}/${raw.length} permit(s) from license.gov.uz` +
        (upgraded ? ` (${upgraded} replaced an older myorg row in place)` : ''),
    );
    return saved;
  }
}
