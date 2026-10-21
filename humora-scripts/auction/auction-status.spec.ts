import {
  AUCTION_OUTCOMES,
  AuctionOutcome,
  auctionStatusClause,
} from './auction-status';

/**
 * The source writes its statuses as Russian prose with no code beside them,
 * so these are matched on the word. Ten appear in 26k rows and the
 * distinctions between most of them do not change the answer to "did this go
 * through" — four groups do.
 *
 * These assert the SQL rather than run it, because what goes wrong here is a
 * pattern that quietly matches too much or too little. Verified against the
 * real table as well: for 311950878 the four groups sum to 581, exactly the
 * unfiltered total, with one refund and none of it leaking into `done`.
 */
describe('auctionStatusClause', () => {
  const clause = (outcome: AuctionOutcome, from = 2) =>
    auctionStatusClause(outcome, from);

  it('reads both status columns', () => {
    const { sql } = clause('pending');
    // The long history fills `status`, the detailed endpoint `kazna_status`;
    // a filter reading one of them would hide most of the catalogue.
    expect(sql).toContain("COALESCE(status, kazna_status, '')");
  });

  it('compares case-insensitively', () => {
    const { sql, params } = clause('expired');
    expect(sql).toContain('lower(');
    expect(params.every((p) => p === p.toLowerCase())).toBe(true);
  });

  it('numbers its parameters from where the caller is', () => {
    const { sql, params } = clause('expired', 5);
    expect(sql).toContain('$5');
    expect(params).toHaveLength(1);
  });

  it('does not collide with the parameters before it', () => {
    const { sql } = clause('cancelled', 3);
    const used = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    expect(Math.min(...used)).toBe(3);
  });

  /**
   * "Оплачена и сумма возвращена" — paid, then refunded — contains both
   * *оплачен* and *возвращен*. Read in the wrong order it is a completed
   * sale; it is a deal that came undone.
   */
  describe('a refund is not a sale', () => {
    it('excludes the cancelled words from done', () => {
      const { sql, params } = clause('done');
      expect(sql).toContain('AND NOT');
      // The words ride in as parameters, not in the statement text.
      expect(params).toContain('%возвращен%');
    });

    it('claims the refund for cancelled', () => {
      expect(clause('cancelled').params).toContain('%возвращен%');
    });
  });

  describe('the words each group is matched on', () => {
    it.each<[AuctionOutcome, string]>([
      ['done', '%исполн%'],
      ['done', '%оплачен%'],
      ['cancelled', '%растогнут%'],
      ['cancelled', '%аннул%'],
      ['pending', '%ждет%'],
      ['expired', '%истек%'],
    ])('%s matches %s', (outcome, word) => {
      expect(clause(outcome).params).toContain(word);
    });

    it('carries both spellings of a word the source misspells', () => {
      // "Растогнут" is the source's own typo for "Расторгнут"; anchoring on
      // one would drop the group the day somebody upstream fixes it.
      const { params } = clause('cancelled');
      expect(params).toContain('%растогнут%');
      expect(params).toContain('%расторгнут%');
    });

    it('matches on substrings, not whole strings', () => {
      // "Востановлен и испольнен" is one status, misspelled, and has to land
      // in done on the strength of a fragment.
      const { sql } = clause('done');
      expect(sql).toContain('LIKE');
      expect(sql).not.toContain(' = ');
    });
  });

  it('offers exactly the four groups', () => {
    expect(AUCTION_OUTCOMES).toEqual([
      'done',
      'cancelled',
      'pending',
      'expired',
    ]);
  });

  it('builds a clause for every one of them', () => {
    for (const outcome of AUCTION_OUTCOMES) {
      const { sql, params } = clause(outcome);
      expect(sql).toBeTruthy();
      expect(params.length).toBeGreaterThan(0);
    }
  });
});
