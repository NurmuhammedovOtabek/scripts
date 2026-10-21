import { Test, TestingModule } from '@nestjs/testing';
import axios from 'axios';
import { ChamberScriptService } from './chamber.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('ChamberScriptService', () => {
  let service: ChamberScriptService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [ChamberScriptService],
    }).compile();
    service = module.get(ChamberScriptService);
  });

  // ─── getByInn: missing tin ────────────────────────────────────────────────

  describe('getByInn (no tin in response)', () => {
    it('returns all-null defaults when data has no tin', async () => {
      mockedAxios.get.mockResolvedValue({ data: {} });
      const result = await service.getByInn('123456789');
      expect(result).toEqual({
        trust: null,
        score: null,
        is_large_taxpayer: false,
        oked_description: null,
        rating_type: null,
      });
    });

    it('returns defaults when data is null', async () => {
      mockedAxios.get.mockResolvedValue({ data: null });
      const result = await service.getByInn('123456789');
      expect(result.is_large_taxpayer).toBe(false);
      expect(result.trust).toBeNull();
    });
  });

  // ─── getByInn: is_large_taxpayer ─────────────────────────────────────────

  describe('getByInn (is_large_taxpayer)', () => {
    it('sets is_large_taxpayer=true when taxpayerType === 3', async () => {
      mockedAxios.get.mockResolvedValue({
        data: { tin: '123', taxpayerType: 3, criteriaAll: 80, type: 'A' },
      });
      const result = await service.getByInn('123');
      expect(result.is_large_taxpayer).toBe(true);
    });

    it('sets is_large_taxpayer=false when taxpayerType !== 3', async () => {
      mockedAxios.get.mockResolvedValue({
        data: { tin: '123', taxpayerType: 1, criteriaAll: 50, type: 'B' },
      });
      const result = await service.getByInn('123');
      expect(result.is_large_taxpayer).toBe(false);
    });
  });

  // ─── getByInn: field mapping ──────────────────────────────────────────────

  describe('getByInn (field mapping)', () => {
    // criteriaAll used to be copied into both columns. `score` still holds the
    // number; `trust` now holds the letter it grades to, which is what the
    // company page shows and what myorg publishes directly.
    it('keeps criteriaAll as the score and grades it into trust', async () => {
      mockedAxios.get.mockResolvedValue({
        data: { tin: '123', criteriaAll: 75, type: 'A' },
      });
      const result = await service.getByInn('123');
      expect(result.score).toBe(75);
      expect(result.trust).toBe('BB');
    });

    it('grades each band the way the company page always has', async () => {
      for (const [criteriaAll, grade] of [
        [98, 'AAA'],
        [88, 'A'],
        [77, 'BBB'],
        [40, 'CC'],
        [10, 'D'],
      ] as const) {
        mockedAxios.get.mockResolvedValue({
          data: { tin: '123', criteriaAll, type: 'X' },
        });
        const result = await service.getByInn('123');
        expect([criteriaAll, result.trust]).toEqual([criteriaAll, grade]);
      }
    });

    it('maps okedDetail.name to oked_description', async () => {
      mockedAxios.get.mockResolvedValue({
        data: {
          tin: '123',
          criteriaAll: 60,
          type: 'B',
          okedDetail: { name: 'Software Development' },
        },
      });
      const result = await service.getByInn('123');
      expect(result.oked_description).toBe('Software Development');
    });

    it('sets oked_description to null when okedDetail is missing', async () => {
      mockedAxios.get.mockResolvedValue({
        data: { tin: '123', criteriaAll: 60, type: 'B' },
      });
      const result = await service.getByInn('123');
      expect(result.oked_description).toBeNull();
    });

    it('maps type to rating_type', async () => {
      mockedAxios.get.mockResolvedValue({
        data: { tin: '123', criteriaAll: 70, type: 'GOLD' },
      });
      const result = await service.getByInn('123');
      expect(result.rating_type).toBe('GOLD');
    });

    it('sets trust and score to null when criteriaAll is 0', async () => {
      mockedAxios.get.mockResolvedValue({
        data: { tin: '123', criteriaAll: 0, type: 'C' },
      });
      const result = await service.getByInn('123');
      expect(result.trust).toBeNull();
      expect(result.score).toBeNull();
    });
  });
});
