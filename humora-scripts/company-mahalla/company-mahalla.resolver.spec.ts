import {
  MahallaMatcher,
  MahallaRow,
} from '../../common/mahalla/mahalla-matcher';
import {
  CompanyLocationInput,
  VillageCodeEvidence,
  VillageMapEntry,
  decideVillageCode,
  explainCompanyMahalla,
  resolveCompanyMahalla,
} from './company-mahalla.resolver';

const r = (
  code: string,
  district_code: string,
  name_latin: string,
): MahallaRow => ({
  code,
  district_code,
  name_latin,
  name_cyrl: null,
});

// Real GRKI rows (Fergana region, 1730).
const matcher = new MahallaMatcher(
  [
    r('1730401011', '1730401', 'Lolazor'),
    r('1730401024', '1730401', 'Huvaydo'),
    r('1730401043', '1730401', 'Ibrat'),
    r('1730401038', '1730401', 'Surxtepa'),
    r('1730242014', '1730242', 'Qorasoqol'),
    r('1730412020', '1730412', 'Yoyilma'),
    r('1730206039', '1730206', 'Solijonobod'),
    r('1730215035', '1730215', 'Oltin kol'),
    r('1726273019', '1726273', 'Abdulla Avloniy'),
  ],
  [
    { code: '1730401', region_code: '1730' },
    { code: '1730242', region_code: '1730' },
    { code: '1730412', region_code: '1730' },
    { code: '1730206', region_code: '1730' },
    { code: '1730215', region_code: '1730' },
    { code: '1726273', region_code: '1726' },
  ],
);

const MAP = new Map<string, VillageMapEntry>([
  [
    '8139',
    {
      mahallaCode: '1730401043',
      status: 'auto',
      tier: 'exact',
      villageName: 'IBRAT',
    },
  ],
  [
    '8151',
    {
      mahallaCode: '1730401038',
      status: 'auto',
      tier: 'number',
      villageName: '69-SURXTEPA',
    },
  ],
  [
    '7777',
    {
      mahallaCode: '1730401011',
      status: 'review',
      tier: 'fuzzy',
      villageName: 'LOLAZR',
    },
  ],
  [
    '9999',
    {
      mahallaCode: '1726273019',
      status: 'manual',
      tier: 'manual',
      villageName: null,
    },
  ],
]);
const lookup = (c: string) => MAP.get(c);

const company = (
  over: Partial<CompanyLocationInput>,
): CompanyLocationInput => ({
  inn: '300000001',
  soato: null,
  nsSoato: null,
  villageCode: null,
  villageName: null,
  street: null,
  cbuSoato: null,
  cbuVillageCode: null,
  cbuStreet: null,
  ...over,
});

describe('resolveCompanyMahalla', () => {
  it("takes the mahalla CBU's street line names", () => {
    const res = resolveCompanyMahalla(
      company({
        soato: '1730401',
        cbuSoato: '1730401',
        cbuStreet: "Lolazor MFY, Guliston ko'chasi, 2-uy",
        street: "Lolazor MFY, Guliston ko'chasi, 2-uy",
        villageCode: '8139',
        villageName: 'IBRAT',
      }),
      matcher,
      lookup,
    );
    expect(res).toMatchObject({
      mahalla_code: '1730401011',
      district_code: '1730401',
      region_code: '1730',
      source: 'cbu_address',
      tier: 'exact',
      matched_name: 'Lolazor',
      // The frozen registry field says otherwise, and is kept for review.
      alt_mahalla_code: '1730401043',
      reason: null,
    });
  });

  it('ignores a registry row left in the district the company moved out of', () => {
    // Real case: registry 1730412 / "YOYILMA", CBU 1730206 and the street
    // "Solijonobod MFY" — the company had moved.
    const res = resolveCompanyMahalla(
      company({
        soato: '1730412',
        villageName: 'YOYILMA',
        street: "Solijonobod MFY, Afsona ko'chasi, 38-a-uy",
        cbuSoato: '1730206',
        cbuStreet: "Solijonobod MFY, Afsona ko'chasi, 38-a-uy",
      }),
      matcher,
      lookup,
    );
    expect(res.mahalla_code).toBe('1730206039');
    expect(res.alt_mahalla_code).toBeNull();
  });

  it("uses CBU's village code when the street names no mahalla", () => {
    const res = resolveCompanyMahalla(
      company({
        soato: '1730401',
        villageCode: '8151',
        villageName: '69-SURXTEPA',
        street: "Ezgulik ko'chasi 19-uy",
        cbuSoato: '1730401',
        cbuVillageCode: '8139',
        cbuStreet: "Ezgulik ko'chasi 19-uy",
      }),
      matcher,
      lookup,
    );
    expect(res).toMatchObject({
      mahalla_code: '1730401043',
      source: 'cbu_village_code',
      matched_name: 'IBRAT',
      alt_mahalla_code: '1730401038',
    });
  });

  it('falls back to the registry when there is no CBU row', () => {
    const res = resolveCompanyMahalla(
      company({ soato: '1730401550', villageName: 'XUVAYDO' }),
      matcher,
      lookup,
    );
    expect(res).toMatchObject({
      mahalla_code: '1730401024',
      district_code: '1730401',
      source: 'registry_village_name',
      tier: 'fold',
    });
  });

  it('prefers the street to the frozen village field — renames', () => {
    const res = resolveCompanyMahalla(
      company({
        soato: '1730215',
        villageName: 'SHAYTONKOʻL',
        street: "Oltin ko'l MFY, 3-uy",
      }),
      matcher,
      lookup,
    );
    expect(res).toMatchObject({
      mahalla_code: '1730215035',
      source: 'registry_address',
    });
  });

  it('uses a manual mapping, and never a review proposal', () => {
    expect(
      resolveCompanyMahalla(
        company({ soato: '1726273', villageCode: '9999' }),
        matcher,
        lookup,
      ).mahalla_code,
    ).toBe('1726273019');
    const { result, steps } = explainCompanyMahalla(
      company({ soato: '1730401', villageCode: '7777' }),
      matcher,
      lookup,
    );
    expect(result.mahalla_code).toBeNull();
    expect(steps[1].note).toBe('map_review');
  });

  it('refuses a mapped mahalla in another region than the address', () => {
    const { result, steps } = explainCompanyMahalla(
      company({ soato: '1730401', villageCode: '9999' }),
      matcher,
      lookup,
    );
    expect(result.mahalla_code).toBeNull();
    expect(steps.find((s) => s.source === 'registry_village_code')?.note).toBe(
      'other_region',
    );
  });

  it('takes the district from the ns10/ns11 pair when a listed company has no soato', () => {
    // What the new-company scan writes: mysoliq's street line and the tax
    // office pair, no soato_code.
    const res = resolveCompanyMahalla(
      company({ nsSoato: '1730401', street: "Lolazor MFY, Guliston ko'chasi" }),
      matcher,
      lookup,
    );
    expect(res).toMatchObject({
      mahalla_code: '1730401011',
      district_code: '1730401',
      source: 'registry_address',
    });
    // A soato_code, when there is one, wins over the pair.
    expect(
      resolveCompanyMahalla(
        company({
          soato: '1730242',
          nsSoato: '1730401',
          street: 'Qorasoqol MFY',
        }),
        matcher,
        lookup,
      ).mahalla_code,
    ).toBe('1730242014');
  });

  describe('says why when it cannot tell', () => {
    it.each([
      [{}, 'no_district'],
      [
        { soato: '1730401', street: "Qatortol ko'chasi, 5-uy" },
        'no_mahalla_given',
      ],
      [{ soato: '1730401', villageName: 'BUNDAY YOQ' }, 'not_found'],
      // A district formed after the classifier was exported.
      [{ cbuSoato: '1726299', cbuStreet: 'Lolazor MFY' }, 'unknown_district'],
    ])('%j → %s', (over, reason) => {
      const res = resolveCompanyMahalla(company(over), matcher, lookup);
      expect(res.mahalla_code).toBeNull();
      expect(res.reason).toBe(reason);
    });

    it('keeps the name it tried, so the misses can be read', () => {
      expect(
        resolveCompanyMahalla(
          company({
            soato: '1730401',
            street: "Bunday yo'q MFY, 5-uy",
            villageName: 'BOSHQA',
          }),
          matcher,
          lookup,
        ),
      ).toMatchObject({ reason: 'not_found', tried_name: "Bunday yo'q" });
      // A village code with a name in the map counts by that name.
      expect(
        resolveCompanyMahalla(
          company({ soato: '1730401', villageCode: '7777' }),
          matcher,
          lookup,
        ).tried_name,
      ).toBe('LOLAZR');
    });

    it('keeps no tried name when a mahalla was found or none was given', () => {
      expect(
        resolveCompanyMahalla(
          company({ soato: '1730401', street: 'Lolazor MFY' }),
          matcher,
          lookup,
        ).tried_name,
      ).toBeNull();
      expect(
        resolveCompanyMahalla(
          company({ soato: '1730401', street: "Qatortol ko'chasi" }),
          matcher,
          lookup,
        ).tried_name,
      ).toBeNull();
    });

    it('does not get round an untrusted village code through its name', () => {
      // 7777 is only a proposal (LOLAZR ~ Lolazor). The registry's village
      // name — the same field — would match Lolazor exactly.
      const { result, steps } = explainCompanyMahalla(
        company({
          soato: '1730401',
          villageCode: '7777',
          villageName: 'LOLAZOR',
        }),
        matcher,
        lookup,
      );
      expect(result).toMatchObject({ mahalla_code: null, reason: 'not_found' });
      expect(
        steps.find((s) => s.source === 'registry_village_name')?.note,
      ).toBe('code_not_trusted');
      // A code in another region (9999), or one the map never saw (4242),
      // is refused the same way.
      for (const villageCode of ['9999', '4242']) {
        expect(
          resolveCompanyMahalla(
            company({ soato: '1730401', villageCode, villageName: 'LOLAZOR' }),
            matcher,
            lookup,
          ).mahalla_code,
        ).toBeNull();
      }
      // With no code at all the name is all there is, and it is used.
      expect(
        resolveCompanyMahalla(
          company({ soato: '1730401', villageName: 'LOLAZOR' }),
          matcher,
          lookup,
        ).mahalla_code,
      ).toBe('1730401011');
      // A code that works still wins; the name is only a second opinion.
      expect(
        resolveCompanyMahalla(
          company({
            soato: '1730401',
            villageCode: '8139',
            villageName: 'LOLAZOR',
          }),
          matcher,
          lookup,
        ),
      ).toMatchObject({
        mahalla_code: '1730401043',
        alt_mahalla_code: '1730401011',
      });
    });

    it('still places the company in its district', () => {
      const res = resolveCompanyMahalla(
        company({ soato: '1730401', cbuSoato: '1730242' }),
        matcher,
        lookup,
      );
      expect(res).toMatchObject({
        mahalla_code: null,
        district_code: '1730242',
        region_code: '1730',
      });
    });
  });
});

describe('decideVillageCode', () => {
  const ev = (
    name: string | null,
    district: string,
    votes: Record<string, number> = {},
  ): VillageCodeEvidence => ({
    names: new Map(name ? [[name, 10]] : []),
    districts: new Map([[district, 10]]),
    companies: 10,
    votes: new Map(Object.entries(votes)),
  });

  it('uses a safe name match as it is', () => {
    expect(
      decideVillageCode('8139', ev('IBRAT', '1730401'), matcher),
    ).toMatchObject({
      mahallaCode: '1730401043',
      status: 'auto',
      tier: 'exact',
    });
  });

  it('lets the street lines decide a code whose name matches nothing', () => {
    // SHAYTONKOʻL was renamed; its companies' streets say Oltin koʻl.
    expect(
      decideVillageCode(
        '7526',
        ev('SHAYTONKOʻL', '1730215', { '1730215035': 15 }),
        matcher,
      ),
    ).toMatchObject({
      mahallaCode: '1730215035',
      status: 'auto',
      tier: 'street_vote',
      streetVotes: 15,
      streetAgree: 15,
    });
  });

  it('keeps an unconfirmed review match as a proposal only', () => {
    expect(
      decideVillageCode('7777', ev('LOLAZR', '1730401'), matcher),
    ).toMatchObject({
      mahallaCode: '1730401011',
      status: 'review',
      tier: 'fuzzy',
    });
  });

  it('takes a one-letter-off match every street line agrees with', () => {
    expect(
      decideVillageCode(
        '7777',
        ev('LOLAZR', '1730401', { '1730401011': 2 }),
        matcher,
      ),
    ).toMatchObject({
      mahallaCode: '1730401011',
      status: 'auto',
      tier: 'fuzzy',
    });
    // One street line saying otherwise, and too few for a majority, keeps it
    // a proposal.
    expect(
      decideVillageCode(
        '7777',
        ev('LOLAZR', '1730401', { '1730401011': 1, '1730401024': 1 }),
        matcher,
      ),
    ).toMatchObject({ status: 'review' });
  });

  it('does not follow a split vote', () => {
    expect(
      decideVillageCode(
        '1',
        ev('NOWHERE', '1730401', { '1730401011': 2, '1730401024': 2 }),
        matcher,
      ),
    ).toMatchObject({ mahallaCode: null, status: 'none' });
    // 3 of 5 is a majority and still two places.
    expect(
      decideVillageCode(
        '1',
        ev('NOWHERE', '1730401', { '1730401011': 3, '1730401024': 2 }),
        matcher,
      ),
    ).toMatchObject({ mahallaCode: null, status: 'none' });
    expect(
      decideVillageCode(
        '1',
        ev('NOWHERE', '1730401', { '1730401011': 4, '1730401024': 1 }),
        matcher,
      ),
    ).toMatchObject({ mahallaCode: '1730401011', status: 'auto' });
  });

  it('does not trust a name match the street lines contradict', () => {
    // IBRAT matches exactly, but three of four street lines say Lolazor:
    // the field stopped following these companies. A proposal, not an answer.
    expect(
      decideVillageCode(
        '8139',
        ev('IBRAT', '1730401', { '1730401011': 3, '1730401043': 1 }),
        matcher,
      ),
    ).toMatchObject({
      mahallaCode: '1730401043',
      status: 'review',
      tier: 'exact',
    });
    // When the street lines agree among themselves, they decide.
    expect(
      decideVillageCode(
        '8139',
        ev('IBRAT', '1730401', { '1730401011': 4 }),
        matcher,
      ),
    ).toMatchObject({
      mahallaCode: '1730401011',
      status: 'auto',
      tier: 'street_vote',
    });
  });

  it('still uses a name match one street line or a tie leaves standing', () => {
    for (const votes of [
      { '1730401011': 1 },
      { '1730401011': 1, '1730401043': 1 },
    ]) {
      expect(
        decideVillageCode('8139', ev('IBRAT', '1730401', votes), matcher),
      ).toMatchObject({
        mahallaCode: '1730401043',
        status: 'auto',
        tier: 'exact',
      });
    }
  });

  it('decides a CBU-only code, which has no name, by its votes', () => {
    expect(
      decideVillageCode('2', ev(null, '1730401', { '1730401011': 4 }), matcher),
    ).toMatchObject({
      mahallaCode: '1730401011',
      status: 'auto',
      tier: 'street_vote',
    });
  });
});
