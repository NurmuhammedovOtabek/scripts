import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';

/** One row of the bundled SOATO JSON (output of the parse-once PDF script). */
export interface SoatoSeedEntry {
  code: string;
  name_uz: string | null;
  name_ru: string | null;
  parent_code: string | null;
  level: number; // 1 country, 2 region, 3 district, 4 settlement
}

export interface RegionRow {
  code: string;
  name_uz: string | null;
  name_ru: string | null;
}

export interface DistrictRow extends RegionRow {
  region_code: string | null;
}

export interface SettlementRow extends DistrictRow {
  district_code: string | null;
}

/**
 * One-shot seeder for the SOATO classifier — splits a single source JSON
 * into three sibling tables (regions / districts / settlements) and bulk-
 * upserts each. The classifier rarely changes (every few years), so there's
 * no live API sync: the JSON is versioned in the repo and reseeding is a
 * single POST /api/soato/seed call.
 *
 * Each table's INSERT uses ON CONFLICT (code) DO UPDATE — safe to re-run.
 * Country level (one row, "17") is dropped on purpose.
 */
@Injectable()
export class SoatoSeedService {
  private readonly logger = new Logger(SoatoSeedService.name);
  private readonly BATCH = 500;

  constructor(@InjectDataSource('flottDb') private readonly db: DataSource) {}

  /** Read the bundled JSON and bulk-upsert into all three tables. */
  async seedFromFile(): Promise<{
    regions: number;
    districts: number;
    settlements: number;
    elapsedMs: number;
  }> {
    const start = Date.now();
    const file = path.join(__dirname, 'soato_seed.json');
    const raw = fs.readFileSync(file, 'utf-8');
    const all = JSON.parse(raw) as SoatoSeedEntry[];

    // Bucket by level — country (level 1) is dropped.
    const regions: RegionRow[] = [];
    const districts: DistrictRow[] = [];
    const settlements: SettlementRow[] = [];
    for (const e of all) {
      if (e.level === 2) {
        regions.push({
          code: e.code,
          name_uz: e.name_uz,
          name_ru: e.name_ru,
        });
      } else if (e.level === 3) {
        districts.push({
          code: e.code,
          region_code: e.parent_code,
          name_uz: e.name_uz,
          name_ru: e.name_ru,
        });
      } else if (e.level === 4) {
        settlements.push({
          code: e.code,
          district_code: e.parent_code,
          // Denormalise region (first 4 digits) for fast region filters.
          region_code: e.code.slice(0, 4),
          name_uz: e.name_uz,
          name_ru: e.name_ru,
        });
      }
    }

    await this.upsertRegions(regions);
    await this.upsertDistricts(districts);
    await this.upsertSettlements(settlements);

    const elapsedMs = Date.now() - start;
    this.logger.log(
      `[soato] seeded regions=${regions.length} districts=${districts.length} ` +
        `settlements=${settlements.length} in ${elapsedMs}ms`,
    );
    return {
      regions: regions.length,
      districts: districts.length,
      settlements: settlements.length,
      elapsedMs,
    };
  }

  // ---- Read queries (logical parent ↔ children) ----

  async getRegionByCode(code: string): Promise<RegionRow | null> {
    const rows: RegionRow[] = await this.db.query(
      `SELECT code, name_uz, name_ru FROM public.regions
        WHERE code = $1 LIMIT 1`,
      [code],
    );
    return rows[0] ?? null;
  }

  async getDistrictByCode(code: string): Promise<DistrictRow | null> {
    const rows: DistrictRow[] = await this.db.query(
      `SELECT code, region_code, name_uz, name_ru FROM public.districts
        WHERE code = $1 LIMIT 1`,
      [code],
    );
    return rows[0] ?? null;
  }

  async getSettlementByCode(code: string): Promise<SettlementRow | null> {
    const rows: SettlementRow[] = await this.db.query(
      `SELECT code, district_code, region_code, name_uz, name_ru
         FROM public.settlements WHERE code = $1 LIMIT 1`,
      [code],
    );
    return rows[0] ?? null;
  }

  /** All districts in a region (idx_districts_region). */
  async listDistrictsOfRegion(regionCode: string): Promise<DistrictRow[]> {
    return this.db.query(
      `SELECT code, region_code, name_uz, name_ru FROM public.districts
        WHERE region_code = $1 ORDER BY code ASC`,
      [regionCode],
    );
  }

  /** All settlements in a district (idx_settlements_district). */
  async listSettlementsOfDistrict(
    districtCode: string,
  ): Promise<SettlementRow[]> {
    return this.db.query(
      `SELECT code, district_code, region_code, name_uz, name_ru
         FROM public.settlements
        WHERE district_code = $1 ORDER BY code ASC`,
      [districtCode],
    );
  }

  /** Truncate all three tables then re-seed from file. */
  async resetAndSeed(): Promise<{
    regions: number;
    districts: number;
    settlements: number;
    elapsedMs: number;
  }> {
    await this.db.query(
      `TRUNCATE public.settlements, public.districts, public.regions RESTART IDENTITY CASCADE`,
    );
    this.logger.log('[soato] tables truncated');
    return this.seedFromFile();
  }

  // ---- Bulk upserts (batched; idempotent via PRIMARY KEY) ----

  private async upsertRegions(rows: RegionRow[]): Promise<void> {
    if (rows.length === 0) return;
    for (let i = 0; i < rows.length; i += this.BATCH) {
      const chunk = rows.slice(i, i + this.BATCH);
      const tuples: string[] = [];
      const params: unknown[] = [];
      let p = 1;
      for (const r of chunk) {
        tuples.push(`($${p++}, $${p++}, $${p++})`);
        params.push(r.code, r.name_uz, r.name_ru);
      }
      await this.db.query(
        `INSERT INTO public.regions (code, name_uz, name_ru)
         VALUES ${tuples.join(', ')}
         ON CONFLICT (code) DO UPDATE SET
           name_uz    = EXCLUDED.name_uz,
           name_ru    = EXCLUDED.name_ru,
           fetched_at = now(),
           updated_at = now()`,
        params,
      );
    }
  }

  private async upsertDistricts(rows: DistrictRow[]): Promise<void> {
    if (rows.length === 0) return;
    for (let i = 0; i < rows.length; i += this.BATCH) {
      const chunk = rows.slice(i, i + this.BATCH);
      const tuples: string[] = [];
      const params: unknown[] = [];
      let p = 1;
      for (const r of chunk) {
        tuples.push(`($${p++}, $${p++}, $${p++}, $${p++})`);
        params.push(r.code, r.region_code, r.name_uz, r.name_ru);
      }
      await this.db.query(
        `INSERT INTO public.districts (code, region_code, name_uz, name_ru)
         VALUES ${tuples.join(', ')}
         ON CONFLICT (code) DO UPDATE SET
           region_code = EXCLUDED.region_code,
           name_uz     = EXCLUDED.name_uz,
           name_ru     = EXCLUDED.name_ru,
           fetched_at  = now(),
           updated_at  = now()`,
        params,
      );
    }
  }

  private async upsertSettlements(rows: SettlementRow[]): Promise<void> {
    if (rows.length === 0) return;
    for (let i = 0; i < rows.length; i += this.BATCH) {
      const chunk = rows.slice(i, i + this.BATCH);
      const tuples: string[] = [];
      const params: unknown[] = [];
      let p = 1;
      for (const r of chunk) {
        tuples.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
        params.push(
          r.code,
          r.district_code,
          r.region_code,
          r.name_uz,
          r.name_ru,
        );
      }
      await this.db.query(
        `INSERT INTO public.settlements
           (code, district_code, region_code, name_uz, name_ru)
         VALUES ${tuples.join(', ')}
         ON CONFLICT (code) DO UPDATE SET
           district_code = EXCLUDED.district_code,
           region_code   = EXCLUDED.region_code,
           name_uz       = EXCLUDED.name_uz,
           name_ru       = EXCLUDED.name_ru,
           fetched_at    = now(),
           updated_at    = now()`,
        params,
      );
    }
  }
}
