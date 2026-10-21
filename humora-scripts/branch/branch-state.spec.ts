import { sourceDeletedFlag } from './branch-state';

describe('sourceDeletedFlag', () => {
  it('reads the source flag, numeric or string', () => {
    expect(sourceDeletedFlag({ isDeleted: 1 })).toBe(1);
    expect(sourceDeletedFlag({ isDeleted: '1' })).toBe(1);
    expect(sourceDeletedFlag({ isDeleted: 0 })).toBe(0);
    expect(sourceDeletedFlag({ isDeleted: '0' })).toBe(0);
  });

  it('is null when the source did not say, so the stored flag is kept', () => {
    expect(sourceDeletedFlag({})).toBeNull();
    expect(sourceDeletedFlag({ isDeleted: null })).toBeNull();
    expect(sourceDeletedFlag({ isDeleted: '' })).toBeNull();
  });
});
