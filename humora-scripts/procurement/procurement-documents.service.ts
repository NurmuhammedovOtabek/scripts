import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { S3Service } from '../../s3/s3.service';
import { ProcurementScriptService } from './procurement.service';

/**
 * Where procurement paperwork lives, resolved in one place.
 *
 * The default matters: an environment that has not set the variable still
 * works, the way the court sync's does. Exported so the route that streams a
 * file and the service that writes it cannot disagree about the bucket.
 */
export function procurementBucket(): string {
  return process.env.MINIO_PROCUREMENT_BUCKET || 'procurement-documents';
}

/** What a deal can have a document for. */
export type ProcurementDocumentKind = 'contract' | 'protocol';

interface Mirrorable {
  id: number;
  lot_display_no: string | null;
  contract_file_path: string | null;
  contract_file_ext: string | null;
  contract_stored_key: string | null;
  protocol_file_path: string | null;
  protocol_file_ext: string | null;
  protocol_stored_key: string | null;
}

/**
 * Our own copy of the contract and protocol behind a procurement deal.
 *
 * etender's `contract_file_path` is not a URL. It answers 404 on the API host,
 * returns the SPA's HTML on the web host, and only yields bytes through
 * `POST /api/common/DownloadFile?path=…`. So a reader cannot be handed the
 * path, and the file lasts only as long as etender chooses to serve it.
 *
 * This mirrors both documents into object storage the way the court-decision
 * sync does, and the row remembers the key. Same reasoning as there: the file
 * stays available even when the source does not, and it is served through our
 * own route rather than a storage URL, so the masking that applies to the rest
 * of the deal applies to its paperwork too.
 */
@Injectable()
export class ProcurementDocumentsService {
  private readonly logger = new Logger(ProcurementDocumentsService.name);

  constructor(
    @InjectDataSource('flottDb') private readonly db: DataSource,
    private readonly s3: S3Service,
    private readonly etender: ProcurementScriptService,
  ) {}

  /** Bucket holding procurement paperwork. */
  private get bucket(): string {
    return procurementBucket();
  }

  /**
   * Key prefix, so a test environment writes into a folder that can be dropped
   * wholesale later — the same escape hatch the court sync has.
   */
  private get prefix(): string {
    const p = process.env.MINIO_PROCUREMENT_PREFIX || '';
    return p && !p.endsWith('/') ? `${p}/` : p;
  }

  /**
   * `26120012503865/contract.pdf`.
   *
   * Keyed by the lot's display number rather than our row id: the same lot
   * re-synced into a new row is the same document, and re-fetching it from
   * etender would be work for nothing.
   */
  private objectKey(
    lotDisplayNo: string,
    kind: ProcurementDocumentKind,
    ext: string | null,
  ): string {
    const safe = lotDisplayNo.replace(/[^\w.-]/g, '');
    const suffix = (ext || '').replace(/[^\w]/g, '').toLowerCase() || 'bin';
    return `${this.prefix}${safe}/${kind}.${suffix}`;
  }

  /**
   * Mirror whatever the given rows have, and record where it went.
   *
   * Never throws. This runs behind a company page and behind the sync that
   * fills it; a document that cannot be fetched is worth a log line, not a
   * failed request for the deal it belongs to.
   */
  async mirrorDeals(rowIds: number[]): Promise<{ stored: number }> {
    if (!rowIds.length) return { stored: 0 };

    let stored = 0;
    try {
      // A document not yet in storage, rather than a row with nothing in
      // storage. The contract usually arrives after the protocol has been
      // mirrored, and requiring both keys to be empty skipped exactly that
      // row — the contract was never fetched.
      const rows: Mirrorable[] = await this.db.query(
        `SELECT id, lot_display_no,
                contract_file_path, contract_file_ext, contract_stored_key,
                protocol_file_path, protocol_file_ext, protocol_stored_key
           FROM public.company_deals
          WHERE id = ANY($1)
            AND ((contract_file_path IS NOT NULL AND contract_stored_key IS NULL)
              OR (protocol_file_path IS NOT NULL AND protocol_stored_key IS NULL))`,
        [rowIds],
      );

      for (const row of rows) {
        const keys = await this.mirrorRow(row);
        if (keys.contract || keys.protocol) stored++;
      }
    } catch (err) {
      this.logger.error(`[procurement-docs] error: ${(err as Error).message}`);
    }
    return { stored };
  }

  /** One row's documents not yet stored, and the write that records them. */
  private async mirrorRow(
    row: Mirrorable,
  ): Promise<{ contract: string | null; protocol: string | null }> {
    const lot = row.lot_display_no;
    if (!lot) return { contract: null, protocol: null };

    // A document already stored is left alone; the COALESCE below keeps its key.
    const contract = row.contract_stored_key
      ? null
      : await this.store(
          lot,
          'contract',
          row.contract_file_path,
          row.contract_file_ext,
        );
    const protocol = row.protocol_stored_key
      ? null
      : await this.store(
          lot,
          'protocol',
          row.protocol_file_path,
          row.protocol_file_ext,
        );

    // Stamped even when both came back null, so a later pass can tell a row
    // that was tried and had nothing from one that was never looked at.
    await this.db.query(
      `UPDATE public.company_deals
          SET contract_stored_key = COALESCE($2, contract_stored_key),
              protocol_stored_key = COALESCE($3, protocol_stored_key),
              documents_stored_at = now(),
              updated_at = now()
        WHERE id = $1`,
      [row.id, contract, protocol],
    );

    return { contract, protocol };
  }

  /** Fetch one document and put it in storage, unless it is already there. */
  private async store(
    lotDisplayNo: string,
    kind: ProcurementDocumentKind,
    path: string | null,
    ext: string | null,
  ): Promise<string | null> {
    if (!path) return null;
    const key = this.objectKey(lotDisplayNo, kind, ext);

    try {
      // The same lot can arrive again under a new row; the bytes have not
      // changed, and etender owes us nothing.
      if (await this.s3.exists(this.bucket, key)) return key;

      const file = await this.etender.downloadFile(path);
      if (!file) return null;

      await this.s3.ensureBucket(this.bucket);
      await this.s3.upload(this.bucket, key, file.body, file.contentType);
      this.logger.log(
        `[procurement-docs] ${key} stored (${file.body.length} bytes)`,
      );
      return key;
    } catch (err) {
      this.logger.warn(
        `[procurement-docs] ${key} not stored: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * The stored key for one deal's document, for the route that streams it.
   *
   * Returns null when the deal has no such document or it has not been
   * mirrored yet — the caller answers 404 either way, because from a reader's
   * side those are the same thing.
   */
  async storedKey(
    dealRowId: number,
    kind: ProcurementDocumentKind,
  ): Promise<{ key: string; lot: string | null; ext: string | null } | null> {
    const column =
      kind === 'contract' ? 'contract_stored_key' : 'protocol_stored_key';
    const extColumn =
      kind === 'contract' ? 'contract_file_ext' : 'protocol_file_ext';

    const [row] = await this.db.query(
      `SELECT ${column} AS key, lot_display_no AS lot, ${extColumn} AS ext
         FROM public.company_deals
        WHERE id = $1 AND ${column} IS NOT NULL`,
      [dealRowId],
    );
    return row ?? null;
  }
}
