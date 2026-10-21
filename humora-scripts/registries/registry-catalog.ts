import { CBU_ADAPTERS } from './adapters/cbu.adapters';
import { CIVIL_ADAPTERS } from './adapters/civil.adapters';
import { EGOV_ADAPTERS } from './adapters/egov.adapters';
import { GOV_PDF_ADAPTERS } from './adapters/gov-pdf.adapters';
import { MANUAL_ADAPTERS } from './adapters/manual.adapters';
import { NAPP_ADAPTERS } from './adapters/napp.adapters';
import { PHARMA_ADAPTERS } from './adapters/pharma.adapters';
import { RegistryAdapter } from './registry-types';

/**
 * Every register the sync reads, in the order a run reads them. A register
 * added here is seeded into `registry_sources` at the next run.
 */
export const REGISTRY_ADAPTERS: RegistryAdapter[] = [
  ...EGOV_ADAPTERS,
  ...CBU_ADAPTERS,
  ...NAPP_ADAPTERS,
  ...PHARMA_ADAPTERS,
  ...CIVIL_ADAPTERS,
  ...GOV_PDF_ADAPTERS,
  ...MANUAL_ADAPTERS,
];

export function adapterByCode(code: string): RegistryAdapter | undefined {
  return REGISTRY_ADAPTERS.find((a) => a.meta.code === code);
}
