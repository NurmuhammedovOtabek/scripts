import { innCheckDigit, innFromSequence, sequenceOfInn } from './inn-sequence';

describe('inn-sequence', () => {
  // Each generated from its sequence number and then found on registr.stat.uz
  // on 2026-09-15 — the formula predicted real registrations.
  it.each([
    [31333197, '313331973'],
    [31332406, '313324063'],
    [31330001, '313300014'],
    [31325000, '313250007'],
    [31320000, '313200004'],
    [31316463, '313164635'],
  ])('sequence %i is issued as %s', (sequence, inn) => {
    expect(innFromSequence(sequence)).toBe(inn);
    expect(sequenceOfInn(inn)).toBe(sequence);
  });

  it('holds for the older 2xx register as well', () => {
    expect(innFromSequence(20172876)).toBe('201728764');
    expect(innFromSequence(20286016)).toBe('202860166');
  });

  it('gives 4 for both remainder 5 and remainder 6', () => {
    // Why 4 turns up twice as often as any other check digit.
    expect(innCheckDigit(31320000)).toBe(4); // S mod 11 = 5
    expect(innCheckDigit(20172876)).toBe(4); // S mod 11 = 6
  });

  it('knows a STIR with the wrong ninth digit was never issued', () => {
    expect(sequenceOfInn('313331974')).toBeNull();
  });

  it('refuses anything that is not nine digits', () => {
    for (const bad of ['', '31333197', '3133319730', '31333197a', null]) {
      expect(sequenceOfInn(bad)).toBeNull();
    }
  });

  it('refuses a sequence that is not eight digits', () => {
    expect(() => innFromSequence(1234567)).toThrow(RangeError);
    expect(() => innFromSequence(313331973)).toThrow(RangeError);
    expect(() => innFromSequence(31333197.5)).toThrow(RangeError);
  });
});
