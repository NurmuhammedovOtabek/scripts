import { Test, TestingModule } from '@nestjs/testing';
import { NdsScriptService } from './nds.service';
import { MysoliqService } from 'src/mysoliq/mysoliq.service';

describe('NdsScriptService', () => {
  let service: NdsScriptService;
  const request = jest.fn();

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NdsScriptService,
        { provide: MysoliqService, useValue: { request } },
      ],
    }).compile();
    service = module.get(NdsScriptService);
  });

  // ─── getByInn: empty / missing data ───────────────────────────────────────

  // These used to answer `{is_abuse_vat: false, ...}`, which the caller then
  // wrote into company_info — clearing the flag off a company the tax
  // authority really had flagged, and putting the flip in visible history.
  // "We could not tell" now returns null and the stored value survives.
  describe('getByInn (no data)', () => {
    it('returns null when the response carries no data', async () => {
      request.mockResolvedValue({ data: null });
      await expect(service.getByInn('123456789')).resolves.toBeNull();
    });

    it('returns null when the response itself is null', async () => {
      request.mockResolvedValue(null);
      await expect(service.getByInn('123456789')).resolves.toBeNull();
    });

    it("returns null on the service's own failure shape", async () => {
      request.mockResolvedValue({ success: false, reason: 'not found' });
      await expect(service.getByInn('123456789')).resolves.toBeNull();
    });

    // A hard failure throws from MysoliqService; the callers turn a rejected
    // promise into null themselves, so the stored value is kept either way.
    it('lets a transport failure propagate rather than inventing a value', async () => {
      request.mockRejectedValue(new Error('MySoliq server unreachable'));
      await expect(service.getByInn('123456789')).rejects.toThrow(
        'MySoliq server unreachable',
      );
    });
  });

  // ─── getByInn: active ─────────────────────────────────────────────────────

  describe('getByInn (active)', () => {
    it('maps an active, safe, non-suspended company', async () => {
      request.mockResolvedValue({
        data: { active: true, suspended: false, isSafe: true },
      });
      const result = await service.getByInn('123456789');
      expect(result?.is_abuse_vat).toBe(false);
      expect(result?.nds_state).toBe(1);
      expect(result?.nds_state_text).toBe('Aktiv');
    });
  });

  // ─── getByInn: abuse flag driven by isSafe ────────────────────────────────

  describe('getByInn (is_abuse_vat)', () => {
    it('flags is_abuse_vat only when the source says isSafe:false', async () => {
      request.mockResolvedValue({
        data: { active: true, suspended: true, isSafe: false },
      });
      const result = await service.getByInn('123456789');
      expect(result?.is_abuse_vat).toBe(true);
      expect(result?.nds_state_text).toBe("NDS to'xtatilgan");
    });

    // Regression: "FLOTT" MCHJ 312387381 — not a VAT payer (active:false,
    // vatPayer:false) but isSafe:true. Must NOT be flagged as a VAT abuser.
    it('does NOT flag a safe non-VAT-payer as abuse', async () => {
      request.mockResolvedValue({
        data: {
          vatRegCode: '',
          active: false,
          suspended: false,
          isSafe: true,
          vatPayer: false,
        },
      });
      const result = await service.getByInn('312387381');
      expect(result?.is_abuse_vat).toBe(false);
      expect(result?.nds_state).toBe(0);
      expect(result?.nds_state_text).toBe("Noma'lum");
    });

    it('leaves is_abuse_vat unknown (null) when isSafe is missing', async () => {
      request.mockResolvedValue({ data: { active: false, suspended: false } });
      const result = await service.getByInn('123456789');
      expect(result?.is_abuse_vat).toBeNull();
    });
  });

  // ─── getByInn: request wiring ─────────────────────────────────────────────

  it('calls mysoliq with the nds status endpoint and the inn', async () => {
    request.mockResolvedValue({ data: { active: true, suspended: false } });
    await service.getByInn('123456789');
    expect(request).toHaveBeenCalledWith(
      'nds/reference/status',
      expect.objectContaining({ tin: '123456789' }),
    );
  });
});
