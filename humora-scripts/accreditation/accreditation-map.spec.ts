import {
  AkkredEntry,
  contentHashOf,
  dayOf,
  mapAccreditation,
  sentValues,
  stirOf,
  textOf,
  typeCodeOf,
} from './accreditation-map';

/** A register entry in the source's own shape. Nothing in it is real. */
function entry(over: Partial<AkkredEntry> = {}): AkkredEntry {
  return {
    id: 409,
    uid: '0b7f6a52-3c3e-4d55-9a0e-7a1d2c3b4e5f',
    number: "O'ZAK.SL.0001",
    area: 'sl0001',
    status: 'active',
    status_date: '2026-04-30',
    accreditation_date: '2021-05-03',
    re_accreditation_date: '2026-04-30',
    accreditation_duration: '2031-04-29',
    accreditation_duration_text: null,
    step: 'end',
    type_ownership: 'private',
    type_accredited: 'competence_independence',
    specific_to_finance: false,
    in_production: true,
    designation_of_the_fundamental_standard: "O'z DSt ISO/IEC 17025:2019",
    type_std: { id: 1, key: 'SL', full: 'Sinov laboratoriyasi' },
    directions: [1, 7],
    region: 1,
    tin: '123456789',
    legal_entity_name: 'NAMUNA LABORATORIYA MChJ',
    legal_entity_address: 'Toshkent sh., Namuna ko‘chasi, 1',
    phone: '+998 71 000 00 00',
    email: 'lab@example.uz',
    web_site: '-',
    title_organ: 'Namuna sinov laboratoriyasi',
    address_organ: 'Toshkent sh., Namuna ko‘chasi, 1',
    is_fact_address: false,
    full_name_supervisor_ao: 'TOSHMATOV ESHMAT',
    phone_ao: '+998 90 000 00 00',
    email_ao: 'head@example.uz',
    text: 'Sinov obyekti\tUsul',
    certificate_pdf:
      'https://api-e.akkred.uz/media/file/pdf/2026-04/sl0001-Certificate.pdf',
    file_oblast:
      'https://api-e.akkred.uz/media/file/pdf/2026-03/sl0001-Oblast.pdf',
    file_scopes: 'https://api-e.akkred.uz/media/file/pdf/2026-04/pdf_new.pdf',
    modified_date: '2026-04-14T15:05:19.030265+05:00',
    ...over,
  };
}

describe('accreditation-map', () => {
  it('reads "-" and blanks as no value', () => {
    expect(textOf('-')).toBeNull();
    expect(textOf('   ')).toBeNull();
    expect(textOf('  Namuna  ')).toBe('Namuna');
    expect(textOf(12)).toBeNull();
  });

  it('keeps a day only when it exists', () => {
    expect(dayOf('2031-04-29')).toBe('2031-04-29');
    expect(dayOf('2026-04-14T15:05:19+05:00')).toBe('2026-04-14');
    expect(dayOf('2026-02-30')).toBeNull();
    expect(dayOf('29.04.2031')).toBeNull();
    expect(dayOf(null)).toBeNull();
  });

  it('ties a unit to a company only by a nine-digit STIR', () => {
    expect(stirOf('123456789')).toBe('123456789');
    expect(stirOf(' 123456789 ')).toBe('123456789');
    expect(stirOf('12345678')).toBeNull();
    expect(stirOf('12345678900001')).toBeNull();
    expect(stirOf('0')).toBeNull();
  });

  it('reads the kind off the registry number, whatever the apostrophe', () => {
    expect(typeCodeOf("O'ZAK.SL.0001")).toBe('SL');
    expect(typeCodeOf('O‘ZAK.O‘U.0001')).toBe("O'U");
    expect(typeCodeOf('OZAK.kl.0012')).toBe('KL');
    expect(typeCodeOf('ZAK-SL-1')).toBeNull();
  });

  it('maps an entry into our columns', () => {
    const r = mapAccreditation(entry())!;
    expect(r).toMatchObject({
      source_id: 409,
      number: "O'ZAK.SL.0001",
      type_code: 'SL',
      tin: '123456789',
      inn: '123456789',
      status: 'active',
      expiry_date: '2031-04-29',
      standard: "O'z DSt ISO/IEC 17025:2019",
      region_id: 1,
      web_site: null,
      unit_name: 'Namuna sinov laboratoriyasi',
      supervisor_name: 'TOSHMATOV ESHMAT',
      supervisor_phone: '+998 90 000 00 00',
      scope_text: 'Sinov obyekti\tUsul',
      source_modified_at: '2026-04-14T15:05:19.030265+05:00',
    });
    expect(r.raw.id).toBe(409);
  });

  it('takes the scope the register shows: the current file, else the older one', () => {
    expect(mapAccreditation(entry())!.scope_url).toBe(
      'https://api-e.akkred.uz/media/file/pdf/2026-04/pdf_new.pdf',
    );
    expect(mapAccreditation(entry({ file_scopes: null }))!.scope_url).toBe(
      'https://api-e.akkred.uz/media/file/pdf/2026-03/sl0001-Oblast.pdf',
    );
    expect(
      mapAccreditation(entry({ file_scopes: null, file_oblast: null }))!
        .scope_url,
    ).toBeNull();
  });

  it('reads an empty list of directions as nothing', () => {
    expect(mapAccreditation(entry({ directions: [] }))!.directions).toBeNull();
    expect(mapAccreditation(entry())!.directions).toEqual([1, 7]);
    expect(mapAccreditation(entry({ type_std: 'SL' }))!.type_std).toBeNull();
  });

  it('leaves out an entry with no id', () => {
    expect(mapAccreditation(entry({ id: undefined as any }))).toBeNull();
    expect(mapAccreditation(entry({ id: '409' as any }))).toBeNull();
  });

  it('hashes what an entry says — not when the register last saved it', () => {
    const a = mapAccreditation(entry())!;
    const resaved = mapAccreditation(
      entry({ modified_date: '2026-10-09T10:00:00+05:00' }),
    )!;
    expect(resaved.content_hash).toBe(a.content_hash);

    // Same entry, keys in another order.
    const shuffled = Object.fromEntries(
      Object.entries(entry()).reverse(),
    ) as AkkredEntry;
    expect(mapAccreditation(shuffled)!.content_hash).toBe(a.content_hash);

    const paused = mapAccreditation(entry({ status: 'paused' }))!;
    expect(paused.content_hash).not.toBe(a.content_hash);

    const { content_hash, raw, source_modified_at, ...rest } = a;
    void raw;
    void source_modified_at;
    expect(contentHashOf(rest)).toBe(content_hash);
  });

  it('sends only what has a value, and the STIR whenever the TIN came', () => {
    const blankPhone = mapAccreditation(entry({ phone_ao: '' }))!;
    expect('supervisor_phone' in sentValues(blankPhone)).toBe(false);
    expect(sentValues(blankPhone).inn).toBe('123456789');

    // A TIN corrected to a PINFL unties the unit from the company.
    const person = mapAccreditation(entry({ tin: '12345678900001' }))!;
    const sent = sentValues(person);
    expect('inn' in sent).toBe(true);
    expect(sent.inn).toBeNull();

    // No TIN at all is a gap: the held STIR stays.
    const noTin = mapAccreditation(entry({ tin: null }))!;
    expect('inn' in sentValues(noTin)).toBe(false);
  });
});
