import { CsCell, CsRow } from '../common/cs-egov';
import {
  OKED_LEVELS,
  OkedLevel,
  OkedTreeNode,
  levelRank,
} from '../../oked/oked-tree';

/**
 * cs.egov.uz 082-3-004 — Statistics' OKED rev.2, as `public.oked_tree` rows.
 *
 * The dataset is one table of 1,103 rows (2026-10-08), one per printed line
 * of the classifier, and each row fills one of four code columns:
 * - `DIVISION` holds the section ("Секция A", "Section A", "A seksiyasi") or
 *   the two-digit division ("01");
 * - `GROUP` "01.1", `CLASS` "01.11", `SUBCLASS` "01.11.1".
 *
 * A class with a single subclass is printed once: 576 rows carry both
 * `CLASS` "01.12" and `SUBCLASS` "01.12.0" under one name. Both are nodes —
 * a company is registered under the subclass, and the class is what a
 * class-level question asks for — and they share the name, as on paper.
 *
 * `groupname` is not the parent: a class row names its division there
 * ("01.11" → "01"), not its group. The parent is read off the code instead,
 * and only a division needs `groupname` — the letter of its section.
 *
 * The `oked` column is the code in OKED **rev.1**, not this one; it is left
 * alone.
 */

export interface ParsedOkedTree {
  nodes: OkedTreeNode[];
  /** Codes left out because the node above them is not in the dataset. */
  orphans: string[];
  /** Codes printed twice; the first (or the row of its own) is kept. */
  duplicates: string[];
  /** Rows with no code the parser recognises. */
  unreadable: number;
}

const LANG_KEYS = ['rusText', 'engText', 'uzbText', 'uzbKrText'] as const;

/** A cell's code: the same in every language, "-" when the column is empty. */
function codeText(cell: CsCell | undefined): string | null {
  if (!cell) return null;
  const t = cell.text;
  const candidates: unknown[] =
    typeof t === 'string'
      ? [t]
      : t && typeof t === 'object'
        ? LANG_KEYS.map((k) => t[k])
        : [];
  candidates.push(cell.default);
  for (const c of candidates) {
    if (typeof c !== 'string') continue;
    const v = c.trim();
    if (v && v !== '-') return v;
  }
  return null;
}

/** One language of a cell, trimmed; "-" and blank are no name. */
function textIn(cell: CsCell | undefined, key: string): string | null {
  const t = cell?.text;
  const raw = t && typeof t === 'object' ? t[key] : null;
  const v = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  return v && v !== '-' ? v : null;
}

/** "Section A" / "Секция A" / "A seksiyasi" → "A". */
function sectionLetter(cell: CsCell | undefined): string | null {
  const t = cell?.text;
  const texts =
    typeof t === 'string'
      ? [t]
      : t && typeof t === 'object'
        ? LANG_KEYS.map((k) => t[k])
        : [];
  for (const raw of texts) {
    if (typeof raw !== 'string') continue;
    const s = raw.trim();
    const m =
      s.match(/^(?:Section|Секция|Секцияси)\s+([A-Z])$/i) ??
      s.match(/^([A-Z])\s+(?:seksiyasi|секцияси)$/i);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

interface Pending {
  node: Omit<OkedTreeNode, 'section_code'>;
  /** Printed on a row of its own (a class shares one with its subclass). */
  own: boolean;
}

export function parseOkedDataset(rows: CsRow[]): ParsedOkedTree {
  const byCode = new Map<string, Pending>();
  const duplicates: string[] = [];
  let unreadable = 0;

  const add = (
    code: string,
    level: OkedLevel,
    parent: string | null,
    cols: Record<string, CsCell>,
    own: boolean,
  ) => {
    const node = {
      code,
      level,
      parent_code: parent,
      name_uz: textIn(cols.name, 'uzbText'),
      name_uz_cyrl: textIn(cols.name, 'uzbKrText'),
      name_ru: textIn(cols.name, 'rusText'),
      name_en: textIn(cols.name, 'engText'),
    };
    const held = byCode.get(code);
    if (!held) {
      byCode.set(code, { node, own });
      return;
    }
    duplicates.push(code);
    // A class's own row names it better than its subclass's shared one.
    if (own && !held.own) byCode.set(code, { node, own });
  };

  for (const row of rows) {
    const cols = row.tableColumn ?? {};
    let read = false;

    const section = sectionLetter(cols.DIVISION);
    const division = codeText(cols.DIVISION);
    if (section) {
      add(section, 'section', null, cols, true);
      read = true;
    } else if (division && /^\d{2}$/.test(division)) {
      const letter = codeText(cols.groupname);
      add(
        division,
        'division',
        letter && /^[A-Z]$/.test(letter) ? letter : null,
        cols,
        true,
      );
      read = true;
    }

    const group = codeText(cols.GROUP);
    if (group && /^\d{2}\.\d$/.test(group)) {
      const code = group.replace('.', '');
      add(code, 'group', code.slice(0, 2), cols, true);
      read = true;
    }

    const subclass = codeText(cols.SUBCLASS);
    const hasSubclass = Boolean(
      subclass && /^\d{2}\.\d{2}\.\d$/.test(subclass),
    );
    const klass = codeText(cols.CLASS);
    if (klass && /^\d{2}\.\d{2}$/.test(klass)) {
      const code = klass.replace('.', '');
      add(code, 'class', code.slice(0, 3), cols, !hasSubclass);
      read = true;
    }
    if (hasSubclass) {
      const code = subclass!.replace(/\./g, '');
      add(code, 'subclass', code.slice(0, 4), cols, true);
      read = true;
    }

    if (!read) unreadable++;
  }

  // Broadest first, so a node whose parent was left out is left out too.
  const kept = new Map<string, OkedTreeNode>();
  const orphans: string[] = [];
  const pending = [...byCode.values()]
    .map((p) => p.node)
    .sort(
      (a, b) =>
        levelRank(a.level) - levelRank(b.level) || a.code.localeCompare(b.code),
    );
  for (const node of pending) {
    if (node.level === 'section') {
      kept.set(node.code, { ...node, section_code: node.code });
      continue;
    }
    const parent = node.parent_code ? kept.get(node.parent_code) : undefined;
    const expected = OKED_LEVELS[levelRank(node.level) - 1];
    if (!parent || parent.level !== expected) {
      orphans.push(node.code);
      continue;
    }
    kept.set(node.code, { ...node, section_code: parent.section_code });
  }

  return { nodes: [...kept.values()], orphans, duplicates, unreadable };
}
