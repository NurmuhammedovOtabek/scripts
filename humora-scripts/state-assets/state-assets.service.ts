import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { firstValueFrom } from 'rxjs';
import { classifyAsset, normalizeAssetName } from './state-assets.classifier';

interface RawAssetRecord {
  KorxonaSTIR?: string;
  KorxonaTXSH?: string;
  Korxonanomi?: string;
  Nomi?: string;
  Yili?: string;
}

export interface StateAssetRow {
  inn: string;
  org_form: string | null;
  org_name: string | null;
  asset_name: string;
  asset_name_normalized: string | null;
  asset_year: string | null;
  asset_type: 'vehicle' | 'building' | 'other';
}

@Injectable()
export class StateAssetsService {
  private readonly logger = new Logger(StateAssetsService.name);

  // davaktiv.uz state assets dataset (Davlat aktivlari) — bulk JSON
  private readonly DATASET_URL =
    'https://data.egov.uz/apiData/MainData/GetByFile?id=61f122c4a6060ddf7ed388da&fileType=1&tableType=2';

  constructor(
    private readonly httpService: HttpService,
    @InjectDataSource('flottDb') private readonly db: DataSource,
  ) {}

  async downloadDataset(): Promise<RawAssetRecord[]> {
    this.logger.log(`[downloadDataset] fetching from ${this.DATASET_URL}`);
    const start = Date.now();

    const resp = await firstValueFrom(
      this.httpService.get<RawAssetRecord[]>(this.DATASET_URL, {
        responseType: 'json',
        timeout: 120000,
        maxContentLength: 100 * 1024 * 1024,
        maxBodyLength: 100 * 1024 * 1024,
      }),
    );

    const records = Array.isArray(resp.data) ? resp.data : [];
    this.logger.log(
      `[downloadDataset] received ${records.length} records in ${Date.now() - start}ms`,
    );
    return records;
  }

  parseAndClassify(records: RawAssetRecord[]): StateAssetRow[] {
    const rows: StateAssetRow[] = [];
    for (const r of records) {
      const inn = (r.KorxonaSTIR || '').trim();
      const name = (r.Nomi || '').trim();
      if (!inn || !name) continue;
      rows.push({
        inn,
        org_form: (r.KorxonaTXSH || '').trim() || null,
        org_name: (r.Korxonanomi || '').trim() || null,
        asset_name: name,
        asset_name_normalized: normalizeAssetName(name),
        asset_year: (r.Yili || '').trim() || null,
        asset_type: classifyAsset(name),
      });
    }
    return rows;
  }

  async insertBatch(rows: StateAssetRow[]): Promise<number> {
    if (rows.length === 0) return 0;

    const BATCH_SIZE = 500;
    let inserted = 0;

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const chunk = rows.slice(i, i + BATCH_SIZE);
      const values: string[] = [];
      const params: any[] = [];
      let p = 1;
      for (const row of chunk) {
        values.push(
          `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`,
        );
        params.push(
          row.inn,
          row.org_form,
          row.org_name,
          row.asset_name,
          row.asset_name_normalized,
          row.asset_year,
          row.asset_type,
        );
      }
      await this.db.query(
        `INSERT INTO public.company_state_assets
           (inn, org_form, org_name, asset_name, asset_name_normalized, asset_year, asset_type)
         VALUES ${values.join(', ')}`,
        params,
      );
      inserted += chunk.length;
    }

    return inserted;
  }

  async runImport(opts: { limit?: number; truncate?: boolean } = {}): Promise<{
    downloaded: number;
    parsed: number;
    inserted: number;
    counts: Record<string, number>;
    elapsedMs: number;
  }> {
    const start = Date.now();
    const records = await this.downloadDataset();
    const all = this.parseAndClassify(records);
    const rows = opts.limit ? all.slice(0, opts.limit) : all;

    if (opts.truncate) {
      this.logger.warn('[runImport] truncating company_state_assets');
      await this.db.query(
        `TRUNCATE TABLE public.company_state_assets RESTART IDENTITY`,
      );
    }

    const inserted = await this.insertBatch(rows);

    const counts: Record<string, number> = {
      vehicle: 0,
      building: 0,
      other: 0,
    };
    for (const r of rows) counts[r.asset_type]++;

    return {
      downloaded: records.length,
      parsed: all.length,
      inserted,
      counts,
      elapsedMs: Date.now() - start,
    };
  }

  async getByInn(inn: string): Promise<StateAssetRow[]> {
    const rows = await this.db.query(
      `SELECT inn, org_form, org_name, asset_name, asset_name_normalized, asset_year, asset_type
         FROM public.company_state_assets
        WHERE inn = $1
        ORDER BY asset_type, asset_year DESC NULLS LAST, asset_name`,
      [inn],
    );
    return rows;
  }
}
