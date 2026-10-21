/** What a reader can ask an auction list for. */
export type AuctionOutcome = 'done' | 'cancelled' | 'pending' | 'expired';

export const AUCTION_OUTCOMES: AuctionOutcome[] = [
  'done',
  'cancelled',
  'pending',
  'expired',
];

/**
 * The source's statuses, grouped into the four answers worth asking for.
 *
 * `xarid.uzex.uz` writes them as Russian prose and there is no code beside
 * them, so these are matched on the word. Ten of them appear in 26k rows:
 *
 *   Исполнен 15582 · Растогнут 5065 · Востановлен и испольнен 2960 ·
 *   Оплачен 1223 · Срок доставки истек 713 · Ждет оплату 242 ·
 *   Аннулирована - не оплачен 175 · Оплачена и сумма возвращена 113 ·
 *   Срок оплаты истек 3 · На рассмотрении 2
 *
 * Ten buttons of untranslated Russian is not a filter anyone would use, and
 * the distinctions between most of them do not change the answer to "did
 * this go through". Four do.
 *
 * Two of these are less obvious than they look and are grouped deliberately:
 * *Оплачена и сумма возвращена* — paid and refunded — is a deal undone, so it
 * belongs with the cancelled rather than the completed; and *Востановлен и
 * испольнен* — restored and fulfilled — ends completed however it got there.
 *
 * Matched as substrings because the source's spelling is not dependable:
 * "Растогнут" is itself a misspelling of "Расторгнут", and "испольнен" of
 * "исполнен". Anchoring on whole strings would silently drop a group the day
 * somebody upstream fixes the typo.
 */
const PATTERNS: Record<AuctionOutcome, string[]> = {
  // Delivered, paid, or restored and then fulfilled.
  done: ['исполн', 'испольн', 'оплачен'],
  // Torn up, annulled, or refunded — a deal that came undone.
  cancelled: ['растогнут', 'расторгнут', 'аннул', 'возвращен'],
  // Still waiting on somebody.
  pending: ['ждет', 'рассмотрен', 'ожид'],
  // The clock ran out.
  expired: ['истек'],
};

/**
 * SQL for one outcome, over `status` with `kazna_status` behind it.
 *
 * The long history endpoint fills `status` and the detailed one fills
 * `kazna_status`; a row has whichever endpoint wrote it, so a filter reading
 * only one of them would hide most of the catalogue.
 *
 * Order matters. "Оплачена и сумма возвращена" contains both *оплачен* and
 * *возвращен*, so the cancelled test has to run before the done test or a
 * refund reads as a completed sale.
 */
export function auctionStatusClause(
  outcome: AuctionOutcome,
  paramIndex: number,
): { sql: string; params: string[] } {
  const field = `lower(COALESCE(status, kazna_status, ''))`;
  const params: string[] = [];
  const like = (words: string[]) =>
    words
      .map((w) => {
        params.push(`%${w}%`);
        return `${field} LIKE $${paramIndex + params.length - 1}`;
      })
      .join(' OR ');

  if (outcome === 'done') {
    // Everything that reads as completed, except the refunds.
    const cancelled = PATTERNS.cancelled;
    const done = PATTERNS.done;
    const sql = `((${like(done)}) AND NOT (${like(cancelled)}))`;
    return { sql, params };
  }

  return { sql: `(${like(PATTERNS[outcome])})`, params };
}

/**
 * The same grouping for a row already in hand. The procurement charts total a
 * company's auctions in memory, and must not count a refund as a sale any more
 * than the filter does — so cancelled is tested first, for the reason above.
 */
export function auctionOutcomeOf(
  status: string | null | undefined,
): AuctionOutcome | null {
  const text = (status ?? '').toLowerCase();
  if (!text) return null;
  const has = (words: string[]) => words.some((w) => text.includes(w));
  if (has(PATTERNS.cancelled)) return 'cancelled';
  if (has(PATTERNS.done)) return 'done';
  if (has(PATTERNS.pending)) return 'pending';
  if (has(PATTERNS.expired)) return 'expired';
  return null;
}
