# humora-scripts — a copy of humora-backend's scripts (archive)

This folder is a **copy**, kept for reference only. It is not built, not
linted, not tested and never runs on this box:

- `tsconfig.json`, `tsconfig.build.json` and `eslint.config.mjs` exclude it;
- jest reads `src/` only;
- the imports inside point at humora-backend's own modules
  (`../../org/...`, `../../common/...`), which this repository does not have.

**The source of truth is humora-backend** (`src/scripts/`). Change the code
there, not here. This copy goes stale the day after it is made.

## Snapshot

| | |
|---|---|
| Copied from | humora-backend `origin/test`, commit `b65462d` |
| Date | 2026-10-21 |
| What | every `src/scripts/<module>` this box does not have, plus `common` and `scripts.module.ts` |
| Changes | none — files as they are in humora-backend |

Modules that this box already runs itself (`birdarcha`, `court-cases`,
`davreestr`, `ejarima`, `garov`, `large-taxpayer`, `license`, `mehnat`, `mib`,
`sert`, `stat-registry`, `tax-debtor`, `tax-risk`) were not copied: the box has
its own versions under `src/`.

## What is here

`SCRIPTS.md` is humora-backend's own description of each script (source,
table, captcha). In short:

| Folder | Source | What it keeps |
|---|---|---|
| `accreditation` | akkred.uz | accredited labs and bodies (`company_accreditations`) |
| `auction` | xarid-api-auction.uzex.uz | auction deals (`company_auction_deals`) |
| `bad-suppliers` | xt-xarid.uz | unfair suppliers list |
| `bank`, `bank-registry` | cs.egov.uz | banks and bank branches |
| `branch` | mysoliq proxy | company branches |
| `cbu-sync` | CBU | company card, founders, addresses |
| `chamber` | chamber.uz | trust rating, large taxpayer |
| `company-mahalla` | our tables + спр.125 | each company's mahalla |
| `construction-rating` | reyting.mc.uz | construction ratings |
| `contact-fill` | registr.stat.uz | phones and e-mails |
| `court-documents` | adolatapi1.sud.uz | court decision PDFs |
| `debt-fill` | old.soliq.uz, mib.uz | the no-tax-debt and no-MIB-debt flags, register-wide |
| `itpark` | it-park.uz | IT Park residents |
| `job-control` | — | stop / unlock of long jobs (`/api/jobs`) |
| `mib-registry` | mib.uz | wanted-person and alimony lists |
| `nds` | mysoliq proxy | VAT status |
| `new-company-scan` | mysoliq | new companies by STIR, every two hours |
| `ns-soato-map` | cs.egov.uz | tax office pair → SOATO |
| `oked-sync` | cs.egov.uz | OKED classifier |
| `openinfo` | openinfo.uz | joint-stock company disclosures |
| `postcode` | OPdata export, UzPost, EMU | postal codes by mahalla |
| `procurement` | etender / xarid.uzex.uz | tenders and deals |
| `proxy` | public proxy lists | proxy rotation for davreestr |
| `registries` | data.egov.uz, cbu.uz, napp.uz, gov.uz PDFs, … | ~30 open registers |
| `remote-scraper` | this box | humora's client for this box |
| `soato` | bundled JSON | regions, districts, settlements |
| `state-assets`, `state-participation` | data.egov.uz | state assets and shares |
| `vendor-rating` | xarid.uzex.uz | supplier ratings |
| `yatt-crawl` | myorg (off since 2026-10-12) | trader register walk |
| `yatt-scan` | soliq | trader search by STIR, nightly |

## Refreshing the copy

From the box repository root, with humora-backend next to it:

```bash
git -C ../humora-backend fetch origin
git -C ../humora-backend archive origin/test src/scripts/<module> | tar -x -C humora-scripts --strip-components=2
```

Then update the commit and date in the table above.
