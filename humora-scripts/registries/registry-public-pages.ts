import { Labels } from './registry-types';

/**
 * Where each register is published — the page a reader can open to check an
 * entry for themselves. The company page names it under the register (user
 * decision 2026-10-19: every section says where its data comes from, so the
 * reader does not take Humora for the guarantor of its accuracy), and so does
 * the partner answer (`source` per register).
 *
 * Public pages, not the APIs the adapters read. Kept beside the adapters
 * rather than in them; `registry-public-pages.spec.ts` fails when a register
 * has no page here.
 */
export interface RegistryPublicPage {
  name: Labels;
  url: string;
}

const L = (uz: string, ru: string, en: string): Labels => ({ uz, ru, en });

const EGOV = L(
  "Ochiq ma'lumotlar portali",
  'Портал открытых данных',
  'Open data portal',
);
const CBU = L('Markaziy bank', 'Центральный банк', 'Central Bank');
const NAPP = L(
  'Istiqbolli loyihalar milliy agentligi',
  'Национальное агентство перспективных проектов',
  'National Agency of Perspective Projects',
);
const PHARMAGENCY = L(
  "Farmatsevtika tarmog'ini rivojlantirish agentligi",
  'Агентство по развитию фармацевтической отрасли',
  'Pharmaceutical Industry Development Agency',
);
const UZPHARM = L(
  'Farmatsevtika mahsulotlari xavfsizligi markazi',
  'Центр безопасности фармацевтической продукции',
  'Centre for Pharmaceutical Product Safety',
);
const MINFIN = L(
  'Iqtisodiyot va moliya vazirligi',
  'Министерство экономики и финансов',
  'Ministry of Economy and Finance',
);
const TOURISM = L(
  "Turizm qo'mitasi",
  'Комитет по туризму',
  'Tourism Committee',
);

const egov = (id: string): RegistryPublicPage => ({
  name: EGOV,
  url: `https://data.egov.uz/data/${id}`,
});
const cbu = (page: string): RegistryPublicPage => ({
  name: CBU,
  url: `https://cbu.uz/uz/credit-organizations/${page}/`,
});
/** A register published as a document on gov.uz (the adapters' `documentId`). */
const govDoc = (
  name: Labels,
  authority: string,
  documentId: number,
): RegistryPublicPage => ({
  name,
  url: `https://gov.uz/oz/${authority}/sections/view/${documentId}`,
});

export const REGISTRY_PUBLIC_PAGES: Record<string, RegistryPublicPage> = {
  // data.egov.uz — the dataset each adapter reads.
  customs_benefit: egov('61cae24eae25c8ecefc7a5de'),
  tax_customs_benefit: egov('61641e6aec71c8d08438430c'),
  subsoil_licence: egov('61713c87c90c443f4dfb7dcd'),
  telecom_licence: egov('6107d3fa2a2e256d868e86f6'),
  customs_warehouse: egov('610258012a2e256d868e82dd'),
  free_warehouse: egov('610257632a2e256d868e82d9'),
  duty_free_shop: egov('610257982a2e256d868e82db'),
  tour_operator_licence: egov('6627583e2f776a551cc8b7c4'),
  hotel_certificate: egov('662758862f776a551cc8b7c6'),
  publisher_registration: egov('6163d319ec71c8d0843838f4'),
  education_licence_2022: egov('61110fe9db32b99538e08216'),
  tax_audit: egov('616ecdd1ec71c8d0845cf0e7'),
  road_carrier_licence: egov('61024d652a2e256d868e82ac'),
  ppp_project: egov('64dc9c7fb04a41cb2e29d597'),
  iso_certified: egov('610d1c371a64fdd0373a9114'),
  natural_monopoly: egov('610b8a641a64fdd0373a8f56'),

  // cbu.uz — the credit organisations' pages.
  microfinance_licence: cbu('microcredit'),
  pawnshop_licence: cbu('pawn-shops'),
  factoring_company: cbu('factoring'),
  guarantee_provider: cbu('guarantee'),
  mortgage_refinancing_company: cbu('mortgage'),
  credit_bureau_licence: cbu('bureaus'),

  capital_market_participant: {
    name: NAPP,
    url: 'https://napp.uz/uz/pages/qimmatli-qog-ozlar-bozori-professional-ishtirokchilarining-reestri',
  },
  capital_market_special_regime: {
    name: NAPP,
    url: 'https://napp.uz/uz/pages/kapital-bozori-sohasidagi-maxsus-rejim-ishtirokchilari-reyestri',
  },

  pharma_gpp: { name: PHARMAGENCY, url: 'https://pharmagency.uz' },
  pharma_gdp: { name: PHARMAGENCY, url: 'https://pharmagency.uz' },
  pharma_gmp: { name: PHARMAGENCY, url: 'https://pharmagency.uz' },
  pharma_licence_manufacture: {
    name: UZPHARM,
    url: 'https://uzpharm-control.uz',
  },
  pharma_licence_wholesale: {
    name: UZPHARM,
    url: 'https://uzpharm-control.uz',
  },
  pharma_licence_retail: { name: UZPHARM, url: 'https://uzpharm-control.uz' },

  ngo_registration: {
    name: L('NNT portali', 'Портал ННО', 'NGO portal'),
    url: 'https://e-ngo.uz',
  },
  advocacy_entity: {
    name: L('Advokatlar palatasi', 'Палата адвокатов', 'Chamber of Advocates'),
    url: 'https://e-advokat.uz',
  },
  itpark_resident: {
    name: L('IT Park', 'IT Park', 'IT Park'),
    url: 'https://www.it-park.uz/ru/itpark/residents/itpark-residents',
  },

  // gov.uz documents (gov-pdf.adapters.ts: `authority` / `documentId`).
  audit_firm: govDoc(MINFIN, 'imv', 111717),
  public_interest_entity: govDoc(MINFIN, 'imv', 121389),
  tourism_accommodation: govDoc(TOURISM, 'uzbektourism', 208214),
  hostel_registration: govDoc(TOURISM, 'uzbektourism', 208212),
  medical_wellness_institution: govDoc(TOURISM, 'uzbektourism', 208229),
  // One document a quarter, so the section that lists them.
  sanitary_import_conclusion: {
    name: L(
      "Sanitariya-epidemiologik osoyishtalik qo'mitasi",
      'Комитет санитарно-эпидемиологического благополучия',
      'Sanitary and Epidemiological Welfare Committee',
    ),
    url: 'https://gov.uz/oz/sanepid/sections/sanepid-xulosa',
  },
};
