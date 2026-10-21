import axios from 'axios';
import { csNumber, csText, fetchCsDataset } from './cs-egov';

jest.mock('axios');
const post = axios.post as jest.Mock;

describe('cs.egov.uz cells', () => {
  it('reads text in the asked script, falling back to the other when blank', () => {
    const cell = {
      text: { uzbText: 'Andijon', uzbKrText: 'Андижон' },
      default: 'x',
    };
    expect(csText(cell, 'uzbKrText')).toBe('Андижон');
    expect(csText(cell, 'uzbText')).toBe('Andijon');
    expect(csText({ text: { uzbText: 'Andijon', uzbKrText: '' } })).toBe(
      'Andijon',
    );
    expect(csText({ text: '  plain  ' })).toBe('plain');
    expect(csText({ text: null, default: '   ' })).toBeNull();
  });

  it('reads a blank number as none, not 0', () => {
    expect(csNumber({ number: 30, default: 30 })).toBe(30);
    expect(csNumber({ number: null, default: '14' })).toBe(14);
    expect(csNumber({ number: null, default: null })).toBeNull();
    expect(csNumber({ number: null, default: '' })).toBeNull();
    expect(csNumber(undefined)).toBeNull();
  });
});

describe('fetchCsDataset', () => {
  it('fails on an error, a missing list or a short answer — never "empty"', async () => {
    post.mockResolvedValueOnce({ status: 502, data: 'Bad Gateway' });
    await expect(fetchCsDataset('x')).rejects.toThrow(/HTTP 502/);
    post.mockResolvedValueOnce({ status: 200, data: { result: {} } });
    await expect(fetchCsDataset('x')).rejects.toThrow(/without a row list/);
    post.mockResolvedValueOnce({
      status: 200,
      data: { result: { count: 5, data: [{}, {}] } },
    });
    await expect(fetchCsDataset('x')).rejects.toThrow(/sent 2 of 5 rows/);
  });

  it('takes the full dataset even when isSuccess says false', async () => {
    post.mockResolvedValueOnce({
      status: 200,
      data: { result: { isSuccess: false, count: 2, data: [{}, {}] } },
    });
    await expect(fetchCsDataset('x')).resolves.toHaveLength(2);
  });
});
