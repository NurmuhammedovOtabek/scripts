import { Injectable, Logger } from '@nestjs/common';
import { MysoliqService } from 'src/mysoliq/mysoliq.service';

export interface NdsFields {
  /** null when the answer has no isSafe: not known, never cleared. */
  is_abuse_vat: boolean | null;
  nds_state: number | null;
  nds_state_text: string | null;
}

@Injectable()
export class NdsScriptService {
  private readonly logger = new Logger(NdsScriptService.name);

  constructor(private readonly mysoliqService: MysoliqService) {}

  /**
   * VAT standing for one INN, or **null when the tax service did not answer
   * with data**.
   *
   * Null rather than a default matters because the caller writes is_abuse_vat
   * straight into company_info: returning `{is_abuse_vat: false}` on a soft
   * failure would clear the abuse flag off a company the tax authority really
   * had flagged, and record the flip in history for everyone to read. The
   * caller already guards with `if (nds)`, so null simply leaves the stored
   * value alone. (Same failure shape as it-park.uz — see ItparkScriptService.)
   *
   * A hard failure throws from MysoliqService and never reaches here; this
   * covers the case where the service answers 200 with `success:false` or an
   * empty `data`.
   */
  async getByInn(inn: string): Promise<NdsFields | null> {
    this.logger.log(`nds/reference/status: INN=${inn}`);

    const d = new Date();
    const today = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
    const response = await this.mysoliqService.request('nds/reference/status', {
      tin: inn,
      facturaDate: today,
    });

    const data = response?.data;

    if (!data) {
      this.logger.warn(
        `nds/reference/status: INN=${inn} — ma'lumot topilmadi, ` +
          "noma'lum deb qoldirildi (bazadagi qiymat saqlanadi)",
      );
      return null;
    }

    // `is_abuse_vat` = the tax authority's own "not safe" verdict (`isSafe`).
    // Do NOT derive it from `active`/`suspended`: a company that is simply not a
    // VAT payer returns active:false, vatPayer:false but isSafe:true — that is
    // NOT abuse. (Bug fix: "FLOTT" MCHJ 312387381 was wrongly flagged "Ha"
    // because the old check used `active === false`.) A missing `isSafe` is
    // null — unknown: it neither accuses a company nor clears a flag the tax
    // authority set (the caller skips null).
    const isAbuse =
      data.isSafe === false ? true : data.isSafe === true ? false : null;
    const stateText = data.suspended
      ? "NDS to'xtatilgan"
      : data.active
        ? 'Aktiv'
        : "Noma'lum";

    this.logger.log(
      `nds/reference/status: INN=${inn} — active:${data.active}, suspended:${data.suspended}, abuse:${isAbuse}`,
    );

    return {
      is_abuse_vat: isAbuse,
      nds_state: data.active ? 1 : 0,
      nds_state_text: stateText,
    };
  }
}
