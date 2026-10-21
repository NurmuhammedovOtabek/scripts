import {
  MahallaMatcher,
  MahallaTier,
  SAFE_TIERS,
  districtOfSoato,
  mahallaFromAddress,
} from '../../common/mahalla/mahalla-matcher';

/**
 * Everything we hold that says where a company is registered.
 *
 * Two sources, and they are not equally fresh:
 * - **CBU** (`company_addresses`, billing row) is written on every CBU sync —
 *   its SOATO, its 4-5 digit village code and its street line are current.
 * - **company_info** is the registry row. CBU keeps `street_address` current,
 *   but not `soato_code`, and nothing has written `village_code` /
 *   `village_name` since myorg stopped answering. When a company moves, those
 *   keep describing where it used to be — in the Fergana sample every case
 *   where the two disagreed about the district was a company that had moved.
 */
export interface CompanyLocationInput {
  inn: string;
  soato: string | null;
  /**
   * The SOATO `ns_soato_map` gives for the row's ns10/ns11 pair. A company
   * listed by the new-company scan arrives from mysoliq with that pair and no
   * `soato_code`; without this it would have no district until CBU answers.
   */
  nsSoato: string | null;
  villageCode: string | null;
  villageName: string | null;
  street: string | null;
  cbuSoato: string | null;
  cbuVillageCode: string | null;
  cbuStreet: string | null;
}

/**
 * One 4-5 digit village code's place in GRKI (`mahalla_village_map`).
 *
 * That code is myorg's and CBU's own numbering, not a GRKI code. One code has
 * one name everywhere it appears (no exception across 120k companies), so it
 * is resolved once per code, not once per company.
 */
export interface VillageMapEntry {
  mahallaCode: string | null;
  status: VillageMapStatus;
  tier: string | null;
  villageName?: string | null;
}

/** auto: resolved and used · review: a proposal a person should confirm ·
 * manual: set by a person, never overwritten · none: nothing found. */
export type VillageMapStatus = 'auto' | 'review' | 'manual' | 'none';

export type MahallaSource =
  | 'cbu_address'
  | 'cbu_village_code'
  | 'registry_address'
  | 'registry_village_code'
  | 'registry_village_name';

/**
 * Why a company has no mahalla. `unknown_district` means the classifier is
 * behind — the company's SOATO names a district `public.territory` does not
 * have yet (a new district), not that its address is unreadable.
 */
export type MahallaMissReason =
  | 'no_district'
  | 'unknown_district'
  | 'no_mahalla_given'
  | 'ambiguous'
  | 'not_found';

export interface CompanyMahallaResult {
  inn: string;
  mahalla_code: string | null;
  district_code: string | null;
  region_code: string | null;
  source: MahallaSource | null;
  tier: string | null;
  matched_name: string | null;
  /** A later source's different answer — a disagreement worth a look. */
  alt_mahalla_code: string | null;
  reason: MahallaMissReason | null;
  /**
   * For a company with no mahalla: the name that was tried first and matched
   * nothing ("Istiqbol", "4-SON"). Null when a mahalla was found or no name
   * was given. It is what GET /company-mahalla/unmatched groups, so the most
   * common misses can be looked at by name instead of guessed at.
   */
  tried_name: string | null;
}

export interface ResolutionStep {
  source: MahallaSource;
  district: string | null;
  input: string | null;
  code: string | null;
  tier: string | null;
  note: string | null;
}

type Lookup = (villageCode: string) => VillageMapEntry | undefined;

/**
 * Which mahalla a company is in, with every step that was tried — the
 * `explain` endpoint shows the steps, the fill stores the result.
 *
 * Order, first answer wins:
 *   1. CBU street line — "Lolazor MFY, …" in CBU's district
 *   2. CBU village code, through the village map
 *   3. company_info street line, when it differs from CBU's
 *   4. company_info village code, through the village map
 *   5. company_info village name, matched directly — only for a company with
 *      no village code: a code the map does not trust is not got round
 *      through its own name
 * Steps 3-5 run only when company_info's district is CBU's too (or there is
 * no CBU row): a registry row pointing at another district is one the
 * company has left.
 *
 * The street is asked before the village field because it is what the
 * company wrote when it last registered. The village fields are a classifier
 * that stopped updating — "SHAYTONKOʻL" there, "Oltin koʻl MFY" in the
 * street, and спр.125 agrees with the street.
 */
export function explainCompanyMahalla(
  input: CompanyLocationInput,
  matcher: MahallaMatcher,
  villageMap: Lookup,
): { result: CompanyMahallaResult; steps: ResolutionStep[] } {
  const cbuDistrict = districtOfSoato(input.cbuSoato);
  const ciDistrict =
    districtOfSoato(input.soato) ?? districtOfSoato(input.nsSoato);
  const hasCbu = Boolean(
    cbuDistrict || input.cbuVillageCode || input.cbuStreet,
  );
  const registryUsable =
    !hasCbu || !cbuDistrict || !ciDistrict || ciDistrict === cbuDistrict;

  const steps: ResolutionStep[] = [];
  let sawAmbiguous = false;
  let sawInput = false;

  const byText = (
    source: MahallaSource,
    district: string | null,
    text: string | null,
  ) => {
    const step: ResolutionStep = {
      source,
      district,
      input: text,
      code: null,
      tier: null,
      note: null,
    };
    if (text) sawInput = true;
    if (district && text) {
      const m = matcher.resolve(district, text);
      if (m.code && m.tier && SAFE_TIERS.has(m.tier as MahallaTier)) {
        step.code = m.code;
        step.tier = m.tier;
      } else {
        step.note = m.miss ?? 'not_found';
        if (m.miss === 'ambiguous') sawAmbiguous = true;
      }
    } else if (text) step.note = 'no_district';
    steps.push(step);
  };

  const byCode = (
    source: MahallaSource,
    district: string | null,
    villageCode: string | null,
  ) => {
    const step: ResolutionStep = {
      source,
      district,
      input: villageCode,
      code: null,
      tier: null,
      note: null,
    };
    if (villageCode) sawInput = true;
    const entry = villageCode ? villageMap(villageCode) : undefined;
    if (!villageCode) {
      // nothing to look up
    } else if (!entry) step.note = 'not_in_map';
    else if (
      !entry.mahallaCode ||
      (entry.status !== 'auto' && entry.status !== 'manual')
    ) {
      step.note = `map_${entry.status}`;
    } else if (
      district &&
      matcher.regionOf(entry.mahallaCode) !== matcher.regionOfDistrict(district)
    ) {
      // The code's mahalla is in another region than the address — one of
      // the two is wrong, and nothing here says which.
      step.note = 'other_region';
    } else {
      step.code = entry.mahallaCode;
      step.tier = entry.status === 'manual' ? 'manual' : entry.tier;
    }
    steps.push(step);
  };

  if (hasCbu) {
    byText('cbu_address', cbuDistrict, mahallaFromAddress(input.cbuStreet));
    byCode('cbu_village_code', cbuDistrict, input.cbuVillageCode);
  }
  if (registryUsable) {
    const registryDistrict = ciDistrict ?? cbuDistrict;
    if (!hasCbu || (input.street ?? '') !== (input.cbuStreet ?? '')) {
      byText(
        'registry_address',
        registryDistrict,
        mahallaFromAddress(input.street),
      );
    }
    byCode('registry_village_code', registryDistrict, input.villageCode);
    // The village name is the same registry field the code stands for. A
    // company that has a code the code step could not use — under review,
    // refused by the companies' own street lines, unknown, in another
    // region — is not matched by the name either: that would hand back the
    // answer the code was refused for (166 companies on dev, 2026-09-29).
    // Only a company with no code at all is matched by its name.
    const codeStep = steps[steps.length - 1];
    if (input.villageCode && !codeStep.code) {
      steps.push({
        source: 'registry_village_name',
        district: registryDistrict,
        input: input.villageName,
        code: null,
        tier: null,
        note: input.villageName ? 'code_not_trusted' : null,
      });
    } else {
      byText('registry_village_name', registryDistrict, input.villageName);
    }
  }

  const winner = steps.find((s) => s.code);
  const alt = winner
    ? steps.find((s) => s.code && s.code !== winner.code)
    : undefined;
  const district = winner
    ? matcher.districtOf(winner.code as string)
    : (cbuDistrict ?? ciDistrict);

  let reason: MahallaMissReason | null = null;
  let triedName: string | null = null;
  if (!winner) {
    if (!cbuDistrict && !ciDistrict) reason = 'no_district';
    else if (!matcher.hasDistrict(district)) reason = 'unknown_district';
    else if (!sawInput) reason = 'no_mahalla_given';
    else if (sawAmbiguous) reason = 'ambiguous';
    else reason = 'not_found';

    // The first name the steps tried, in their order. A village code counts
    // by the name its map entry carries; a code with none has no name to show.
    for (const s of steps) {
      if (!s.input) continue;
      const name = s.source.endsWith('village_code')
        ? (villageMap(s.input)?.villageName ?? null)
        : s.input;
      if (name) {
        triedName = name.trim().slice(0, 200);
        break;
      }
    }
  }

  return {
    result: {
      inn: input.inn,
      mahalla_code: winner?.code ?? null,
      district_code: district,
      region_code: winner
        ? matcher.regionOf(winner.code as string)
        : matcher.regionOfDistrict(district),
      source: winner?.source ?? null,
      tier: winner?.tier ?? null,
      matched_name: winner
        ? winner.source.endsWith('village_code')
          ? (villageMap(winner.input as string)?.villageName ?? winner.input)
          : winner.input
        : null,
      alt_mahalla_code: alt?.code ?? null,
      reason,
      tried_name: triedName,
    },
    steps,
  };
}

export function resolveCompanyMahalla(
  input: CompanyLocationInput,
  matcher: MahallaMatcher,
  villageMap: Lookup,
): CompanyMahallaResult {
  return explainCompanyMahalla(input, matcher, villageMap).result;
}

// ── the village map ─────────────────────────────────────────────────────────

/** What the fill gathers about one village code before deciding its place. */
export interface VillageCodeEvidence {
  /** name → companies carrying it (one name in practice). */
  names: Map<string, number>;
  /** district → companies carrying the code there. */
  districts: Map<string, number>;
  companies: number;
  /** GRKI code → companies whose street line names it (safe tiers only). */
  votes: Map<string, number>;
}

export interface VillageMapDecision {
  villageCode: string;
  mahallaCode: string | null;
  status: Exclude<VillageMapStatus, 'manual'>;
  tier: string | null;
  villageName: string | null;
  districtCode: string | null;
  companies: number;
  streetVotes: number;
  streetAgree: number;
}

/**
 * Street votes needed, and the share the leader must hold, to decide alone.
 * 0.8, not a bare majority: every company that has only the village code gets
 * the answer, and a code whose street lines split 3 to 2 is two places, not
 * one (user decision 2026-09-28: no mahalla rather than a wrong one).
 */
export const VOTE_MIN = 3;
export const VOTE_SHARE = 0.8;

function top<K>(m: Map<K, number>): [K, number] | null {
  let best: [K, number] | null = null;
  for (const e of m) if (!best || e[1] > best[1]) best = e;
  return best;
}

/**
 * One village code's GRKI mahalla.
 *
 * The name is matched in the district most of its companies are in. A safe
 * match is used unless the street lines contradict it — two or more of them
 * naming a mahalla, fewer than half naming this one ("OʻTKIR", 0 of 4 on
 * dev): the registry field stopped following those companies, so it is not
 * trusted for the ones that have nothing else. Otherwise the companies' own
 * street lines vote, and a clear majority (≥3 votes, ≥80%) decides — that
 * is how renamed mahallas are found: "SHAYTONKOʻL" matches nothing, and 15
 * of 15 street lines say "Oltin koʻl". A one-letter-off or suffix match that
 * every street line naming a mahalla agrees with (one vote is enough when
 * none disagrees — "SHAYX SHIVLI" / "Shayx Shibli", 2 of 2) is used too; the
 * district-wide guess (`region`) still needs the full majority. A review
 * match the votes do not confirm, or a safe one they contradict, is kept as a
 * proposal (`review`) and not used.
 */
export function decideVillageCode(
  villageCode: string,
  ev: VillageCodeEvidence,
  matcher: MahallaMatcher,
): VillageMapDecision {
  const name = top(ev.names)?.[0] ?? null;
  const district = top(ev.districts)?.[0] ?? null;
  const m = name
    ? matcher.resolve(district, name, { review: true })
    : { code: null, tier: null };
  const totalVotes = [...ev.votes.values()].reduce((a, b) => a + b, 0);
  const leader = top(ev.votes);

  let mahallaCode: string | null = null;
  let status: VillageMapDecision['status'] = 'none';
  let tier: string | null = null;

  const agree = m.code ? (ev.votes.get(m.code) ?? 0) : 0;
  const unanimous = m.code !== null && totalVotes > 0 && agree === totalVotes;
  const contradicted =
    m.code !== null && totalVotes >= 2 && agree * 2 < totalVotes;

  if (m.code && m.tier && SAFE_TIERS.has(m.tier) && !contradicted) {
    mahallaCode = m.code;
    status = 'auto';
    tier = m.tier;
  } else if (
    m.code &&
    (m.tier === 'fuzzy' || m.tier === 'suffix') &&
    unanimous
  ) {
    mahallaCode = m.code;
    status = 'auto';
    tier = m.tier;
  } else if (
    leader &&
    totalVotes >= VOTE_MIN &&
    leader[1] / totalVotes >= VOTE_SHARE
  ) {
    mahallaCode = leader[0];
    status = 'auto';
    tier = m.code === leader[0] ? m.tier : 'street_vote';
  } else if (m.code) {
    mahallaCode = m.code;
    status = 'review';
    tier = m.tier;
  }

  return {
    villageCode,
    mahallaCode,
    status,
    tier,
    villageName: name,
    districtCode: district,
    companies: ev.companies,
    streetVotes: totalVotes,
    streetAgree: mahallaCode ? (ev.votes.get(mahallaCode) ?? 0) : 0,
  };
}
