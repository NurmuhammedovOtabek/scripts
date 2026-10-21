/**
 * The source's own "deleted" flag on a branch (mysoliq `isDeleted`:
 * 0 = active, 1 = deleted), as the smallint `company_branches.is_deleted`
 * holds it. null when the source did not say, so a write can keep what is
 * stored instead of guessing "active".
 */
export function sourceDeletedFlag(branch: {
  isDeleted?: unknown;
}): number | null {
  const v = branch?.isDeleted;
  if (v === undefined || v === null || v === '') return null;
  return Number(v) === 1 ? 1 : 0;
}
