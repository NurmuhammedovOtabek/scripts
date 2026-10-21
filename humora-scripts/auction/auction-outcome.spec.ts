import { auctionOutcomeOf } from './auction-status';

/**
 * The procurement charts decide "did money change hands" row by row, so the
 * grouping the list filter runs in SQL has to hold in memory too — refunds
 * above all, which read as both paid and returned.
 */
describe('auctionOutcomeOf', () => {
  it.each([
    ['Исполнен', 'done'],
    ['Востановлен и испольнен', 'done'],
    ['Оплачен', 'done'],
    ['Оплачена и сумма возвращена', 'cancelled'],
    ['Растогнут', 'cancelled'],
    ['Аннулирована - не оплачен', 'cancelled'],
    ['Ждет оплату', 'pending'],
    ['На рассмотрении', 'pending'],
    ['Срок доставки истек', 'expired'],
    ['Срок оплаты истек', 'expired'],
  ])('reads %p as %p', (status, outcome) => {
    expect(auctionOutcomeOf(status)).toBe(outcome);
  });

  it.each([[null], [undefined], [''], ['Что-то новое']])(
    'has no answer for %p',
    (status) => {
      expect(auctionOutcomeOf(status)).toBeNull();
    },
  );
});
