import axios from 'axios';
import { ProcurementScriptService } from './procurement.service';

jest.mock('axios');
const mockedPost = axios.post as jest.MockedFunction<typeof axios.post>;

/**
 * One lot, asked about again for the documents attached after the deal. Two
 * things make the answer usable: this company's STIR on the right side, which
 * narrows it to this company and makes it several times faster, and room for
 * more than one deal, because a lot put out again holds two.
 */
describe('ProcurementScriptService.fetchDealsOfLot', () => {
  const service = new ProcurementScriptService();

  beforeEach(() => mockedPost.mockReset());

  it('names the lot and this company as the buyer', async () => {
    mockedPost.mockResolvedValue({ data: [] });
    await service.fetchDealsOfLot('203195074', '26120012507419', 'customer');
    const [url, body] = mockedPost.mock.calls[0];
    expect(url).toMatch(/\/DealsList$/);
    expect(body).toMatchObject({
      Keyword: '26120012507419',
      CustomerTin: '203195074',
      From: 1,
      To: 11,
    });
    expect(body).not.toHaveProperty('ProviderTin');
  });

  it('names this company as the seller when it sold', async () => {
    mockedPost.mockResolvedValue({ data: [] });
    await service.fetchDealsOfLot('203195074', '26120012507419', 'provider');
    const [, body] = mockedPost.mock.calls[0];
    expect(body).toMatchObject({ ProviderTin: '203195074' });
    expect(body).not.toHaveProperty('CustomerTin');
  });

  it('returns every deal on the lot, mapped', async () => {
    mockedPost.mockResolvedValue({
      data: [
        {
          deal_id: 158330,
          display_no: 25120012445542,
          contract_file_path: null,
        },
        {
          deal_id: 174574,
          display_no: 25120012445542,
          contract_file_path: '/files/2026/9/14/c.pdf',
        },
      ],
    });
    const deals = await service.fetchDealsOfLot(
      '203195074',
      '25120012445542',
      'customer',
    );
    expect(deals.map((d) => d.deal_id)).toEqual([158330, 174574]);
    expect(deals[0].display_no).toBe('25120012445542');
    expect(deals[1].contract_file_path).toBe('/files/2026/9/14/c.pdf');
  });
});
