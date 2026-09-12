import { parseAmount, parsePassportPage } from './ejarima.parse';

/**
 * The markup below is ejarima.uz's own, with every value replaced by a made-up
 * one — the structure is what is being tested, and a fixture of a real
 * person's penalties has no business in a repository.
 */

/** One protocol card, as the site builds it. `status` is a parameter. */
function card(opts: {
  series: string;
  status: string;
  statusClass: string;
  fine: string;
  paidAt?: string;
  penaltyKind?: string;
  receipt?: string;
}): string {
  return `
<div class="card result-card mb-4">
  <div class="card-body">
    <h4 class="font-weight-bold mb-5">Ma'muriy huquqbuzarlik to'g'risidagi bayonnoma</h4>
    <div class="row mb-4">
      <div class="col-md-4">
        <p class="text-muted mb-0">Bayonnoma seriyasi va raqami</p>
        <h5 class="font-weight-bold">${opts.series}</h5>
      </div>
      <div class="col-md-4">
        <p class="text-muted mb-0">Holati</p>
        <h5 class="font-weight-bold ${opts.statusClass}">${opts.status}</h5>
      </div>
      <div class="col-md-4">
        <p class="text-muted mb-0">Jazo chorasi</p>
        <h5 class="font-weight-bold">${opts.penaltyKind ?? 'JARIMA'}</h5>
      </div>
    </div>
    <div class="row mb-4 ">
      <div class="col-md-4">
        <p class="text-muted mb-0">Jarima miqdori</p>
        <h5 class="font-weight-bold">${opts.fine}</h5>
      </div>
      <div class="col-md-4">
        <p class="text-muted mb-0">Zarar miqdori</p>
        <h5 class="font-weight-bold">0 сум</h5>
      </div>
      <div class="col-md-4">
        <p class="text-muted mb-0">To'lov sanasi</p>
        <h5 class="font-weight-bold">${opts.paidAt ?? ''}</h5>
      </div>
    </div>
    <hr>
    <div class="row mb-4">
      <div class="col-md-4">
        <p class="text-muted mb-0">Sodir etilgan viloyat:</p>
        <h5 class="font-weight-bold">TOSHKENT SHAHRI</h5>
      </div>
      <div class="col-md-4">
        <p class="text-muted mb-0">Sodir etilgan tuman:</p>
        <h5 class="font-weight-bold">CHILONZOR TUMANI</h5>
      </div>
      <div class="col-md-4">
        <p class="text-muted mb-0">Tuzilgan sana</p>
        <h5 class="font-weight-bold">01.01.2026</h5>
      </div>
    </div>
    <div class="row mb-4">
      <div class="col-md-6">
        <p class="text-muted mb-0">Kvitansiya raqami</p>
        <h5 class="font-weight-bold">${opts.receipt ?? 'MAB_00000000000001'}</h5>
      </div>
      <div class="col-md-6">
        <p class="text-muted mb-0">Shaxs</p>
        <h5 class="font-weight-bold">Jismoniy shaxs</h5>
      </div>
    </div>
    <div class="row mb-4">
      <div class="col-md-6">
        <p class="text-muted mb-0">Tuzgan organ</p>
        <h5 class="font-weight-bold">YHXX (GAI)</h5>
      </div>
      <div class="col-md-6">
        <p class="text-muted mb-0">Modda</p>
        <h5 class="font-weight-bold">128 - 1Q</h5>
      </div>
    </div>
    <hr>
    <p class="font-italic"><b>Diqqat!</b> ... (<b>YHXX (GAI)</b>) ...</p>
  </div>
</div>`;
}

function page(body: string, script = ''): string {
  return `<!DOCTYPE html><html><body>
    <div class="card-body service-admin">${body}</div>
    <script>${script}</script>
  </body></html>`;
}

const HEADER = `<h5 class="result-header text-muted mb-4">Pasport orqali qidirish natijalari: AA 1234567</h5>`;

const UNPAID = card({
  series: 'PAND 0000000000001',
  status: 'To‘lanmagan',
  statusClass: 'status_2',
  fine: '123 000 сум',
});
const PAID = card({
  series: 'PAND 0000000000002',
  status: 'To‘langan',
  statusClass: 'status_0',
  fine: '412 000 сум',
  paidAt: '17.07.2026',
});
const PARTIAL = card({
  series: 'PAND 0000000000003',
  status: 'Qisman to‘langan',
  statusClass: 'status_1',
  fine: '200 000 сум',
});

describe('parsePassportPage — the three outcomes', () => {
  it('reads the cards when the site found protocols', () => {
    const r = parsePassportPage(page(HEADER + UNPAID + PAID), 'AA', '1234567');

    expect(r.outcome).toBe('found');
    expect(r.found).toBe(true);
    expect(r.protocols).toHaveLength(2);
    expect(r.serial).toBe('AA');
    expect(r.number).toBe('1234567');
  });

  it('calls an empty result set "none", not a failure', () => {
    const html = page(
      HEADER,
      `toastr.warning('Ushbu so&#039;rov uchun hech qanday natija topilmadi.');`,
    );
    const r = parsePassportPage(html, 'ZZ', '9999999');

    expect(r.outcome).toBe('none');
    expect(r.found).toBe(false);
    expect(r.protocols).toEqual([]);
    expect(r.unpaidCount).toBe(0);
    expect(r.message).toContain('hech qanday natija topilmadi');
  });

  // The one that matters: the site answers 200 with a full page when its own
  // upstream is down. Reading that as "no fines" would clear a person who is
  // not clear.
  it('calls an upstream refusal "unavailable" — never "none"', () => {
    const html = page(
      '',
      `toastr.error('Server vaqtincha ish faoliyatida emas. Keyinroq qayta urinib ko&#039;ring.');`,
    );
    const r = parsePassportPage(html, 'AA', '1234567');

    expect(r.outcome).toBe('unavailable');
    expect(r.found).toBe(false);
    expect(r.message).toContain('Server vaqtincha ish faoliyatida emas');
  });

  it('treats an unrecognisable page as unavailable', () => {
    expect(parsePassportPage('', 'AA', '1234567').outcome).toBe('unavailable');
    expect(parsePassportPage('<html><body>502</body></html>', 'AA', '1234567').outcome).toBe(
      'unavailable',
    );
  });
});

describe('parsePassportPage — one protocol', () => {
  const r = parsePassportPage(page(HEADER + UNPAID), 'AA', '1234567');
  const p = r.protocols[0];

  it('maps every labelled field', () => {
    expect(p.series).toBe('PAND 0000000000001');
    expect(p.penaltyKind).toBe('JARIMA');
    expect(p.region).toBe('TOSHKENT SHAHRI');
    expect(p.district).toBe('CHILONZOR TUMANI');
    expect(p.issuedAt).toBe('01.01.2026');
    expect(p.receiptNo).toBe('MAB_00000000000001');
    expect(p.personKind).toBe('Jismoniy shaxs');
    expect(p.authority).toBe('YHXX (GAI)');
    expect(p.article).toBe('128 - 1Q');
  });

  // The labels carry a trailing colon on two fields and not on the rest, and
  // the status word uses a curly apostrophe where the labels use a straight
  // one. Both folded, or those fields come back null.
  it('matches labels regardless of colon or apostrophe spelling', () => {
    expect(p.region).not.toBeNull();
    expect(p.paidAt).toBeNull(); // blank while unpaid, not the string ''
  });

  it('reads the status from the class, not the word', () => {
    expect(p.statusCode).toBe(2);
    expect(p.paid).toBe(false);
    expect(p.status).toBe('To‘lanmagan');
  });

  it('parses the fine into so‘m', () => {
    expect(p.fineAmount).toBe(123000);
    expect(p.fineText).toBe('123 000 сум');
    expect(p.damageAmount).toBe(0);
  });
});

describe('parsePassportPage — what is owed', () => {
  it('counts unpaid and partly paid, and leaves the settled ones out', () => {
    const r = parsePassportPage(
      page(HEADER + UNPAID + PAID + PARTIAL),
      'AA',
      '1234567',
    );

    expect(r.protocols).toHaveLength(3);
    expect(r.unpaidCount).toBe(2);
    expect(r.unpaidTotal).toBe(123000 + 200000);
  });

  it('owes nothing when everything is settled', () => {
    const r = parsePassportPage(page(HEADER + PAID), 'AA', '1234567');

    expect(r.found).toBe(true);
    expect(r.unpaidCount).toBe(0);
    expect(r.unpaidTotal).toBe(0);
    expect(r.protocols[0].paid).toBe(true);
  });

  // `status_` with nothing after it is markup the site really emits. An
  // unknown status is not a paid one, and it is not silently counted as owed
  // either — but it must never read as settled.
  it('does not call an unknown status paid', () => {
    const html = page(
      HEADER +
        card({
          series: 'PAND 0000000000004',
          status: '',
          statusClass: 'status_',
          fine: '50 000 сум',
        }),
    );
    const p = parsePassportPage(html, 'AA', '1234567').protocols[0];

    expect(p.statusCode).toBeNull();
    expect(p.paid).toBe(false);
  });
});

// The site reuses the "Jazo chorasi" column for the stage of a case that has
// not reached a penalty yet, and leaves the status class empty on those. On a
// real passport with 47 protocols, 15 looked like this — a third of them — so
// how they are counted is not an edge case.
describe('parsePassportPage — protocols still in progress', () => {
  const STAGES = [
    'KOʼRIB CHIQILMOQDA',
    'ROʼYXАTGА OLINGАN',
    'ORGАNGА YUBORILGAN',
    'SUDGА TAYYORGARLIK',
    'SUDGА YUBORILDI',
  ];

  const pendingCards = STAGES.map((stage, i) =>
    card({
      series: `PAND 000000000001${i}`,
      status: '',
      statusClass: 'status_',
      fine: '0 сум',
      penaltyKind: stage,
      receipt: '',
    }),
  ).join('');

  it('counts them apart from both the paid and the owed', () => {
    const r = parsePassportPage(
      page(HEADER + UNPAID + PAID + pendingCards),
      'AA',
      '1234567',
    );

    expect(r.protocols).toHaveLength(7);
    expect(r.pendingCount).toBe(5);
    // The open cases add nothing to the debt: no penalty has been imposed.
    expect(r.unpaidCount).toBe(1);
    expect(r.unpaidTotal).toBe(123000);
  });

  it('marks them undecided, and never paid', () => {
    const r = parsePassportPage(page(HEADER + pendingCards), 'AA', '1234567');

    for (const p of r.protocols) {
      expect(p.decided).toBe(false);
      expect(p.paid).toBe(false);
      expect(p.statusCode).toBeNull();
      expect(p.fineAmount).toBe(0);
      expect(STAGES).toContain(p.penaltyKind);
    }
  });

  it('keeps a decided fine decided', () => {
    const r = parsePassportPage(page(HEADER + UNPAID + PAID), 'AA', '1234567');

    expect(r.pendingCount).toBe(0);
    expect(r.protocols.every((p) => p.decided)).toBe(true);
  });
});

describe('parseAmount', () => {
  it('drops separators and the currency word', () => {
    expect(parseAmount('412 000 сум')).toBe(412000);
    expect(parseAmount('1 234 567 сум')).toBe(1234567);
    expect(parseAmount('0 сум')).toBe(0);
  });

  // A blank cell means "not stated", which is not the same as a fine of zero.
  it('answers null for a value with no digits', () => {
    expect(parseAmount('')).toBeNull();
    expect(parseAmount(null)).toBeNull();
    expect(parseAmount('—')).toBeNull();
  });
});
