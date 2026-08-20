/**
 * MIB.uz matematik captcha yechuvchi
 *
 * Captcha formati: "ikki + sakkiz =" yoki "олти - тўрт ="
 * Javob: raqamda (masalan: 10)
 */

// O'zbek raqam so'zlari (lotin va kirill, OCR xatolari bilan)
const UZ_NUMBERS: Record<string, number> = {
  // Lotin
  nol: 0,
  bir: 1,
  ikki: 2,
  uch: 3,
  "to'rt": 4,
  tort: 4,
  besh: 5,
  olti: 6,
  yetti: 7,
  sakkiz: 8,
  "to'qqiz": 9,
  toqqiz: 9,
  "o'n": 10,
  on: 10,

  // Kirill
  нол: 0,
  бир: 1,
  икки: 2,
  уч: 3,
  тўрт: 4,
  турт: 4,
  тырт: 4,
  беш: 5,
  олти: 6,
  етти: 7,
  саккиз: 8,
  тўққиз: 9,
  туққиз: 9,
  ўн: 10,
  ун: 10,

  // OCR xatolari uchun qo'shimcha variantlar
  елти: 6, // OCR olti ni "елти" deb o'qishi mumkin
  сакиз: 8, // bitta k bilan
  тукқиз: 9,
  тукгиз: 9,
};

/**
 * Folds the letters Uzbek Cyrillic has and Russian does not.
 *
 * The OCR model reads `ў қ ғ ҳ` as `у к г х` whenever it is running Russian
 * data — those glyphs are simply not in that alphabet — so `тўққиз` arrives as
 * `туккиз` and misses a dictionary that spells it correctly. Hand-adding
 * misspellings was the previous answer and it covered `тукқиз` and `тукгиз`
 * while missing `туккиз`, which is the one that actually turned up.
 *
 * Folding both sides instead makes the whole class of substitution harmless,
 * and it stays correct if the model is upgraded to one that reads the letters
 * properly: `тўққиз` and `туккиз` both fold to `туккиз`.
 *
 * Latin apostrophes are folded away for the same reason — `to'rt`, `to‘rt`,
 * `to’rt` and `tort` are one word as far as this is concerned.
 */
function fold(word: string): string {
  return word
    .toLowerCase()
    .replace(/ў/g, 'у')
    .replace(/қ/g, 'к')
    .replace(/ғ/g, 'г')
    .replace(/ҳ/g, 'х')
    .replace(/[’‘'`´]/g, '')
    .replace(/[^a-zа-яё0-9]/g, '');
}

/** The dictionary above, keyed by folded form. */
const FOLDED: Record<string, number> = Object.entries(UZ_NUMBERS).reduce(
  (acc, [word, value]) => {
    acc[fold(word)] = value;
    return acc;
  },
  {} as Record<string, number>,
);

// Operatsiya belgilari
const OPERATORS: Record<string, (a: number, b: number) => number> = {
  '+': (a, b) => a + b,
  '-': (a, b) => a - b,
  '*': (a, b) => a * b,
  х: (a, b) => a * b, // kirill x
  x: (a, b) => a * b, // lotin x
};

/**
 * OCR dan olingan matnni parse qilib javob berish
 * Misol: "ikki + sakkiz =" -> 10
 */
export function solveMathCaptcha(
  text: string,
  /**
   * The operation, measured off the image by `detectOperator`.
   *
   * Given, it wins over anything OCR produced — OCR drops this character or
   * mistakes `+` for `-`, and a wrong sign is worse than no answer because it
   * is submitted with confidence.
   */
  operatorHint?: '+' | '-' | null,
): number | null {
  const cleaned = text
    .toLowerCase()
    .replace(/[=?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let operator: string | null = operatorHint ?? null;

  // Words are whatever is left once the operators and stray marks are gone.
  // Splitting on the characters rather than matching a shape survives OCR
  // gluing the sign to a word ("ун+ туккиз") and losing it altogether.
  const words = cleaned
    .split(/[+\-*xх]/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (!operator) {
    const found = cleaned.match(/[+\-*xх]/);
    if (found) operator = found[0];
  }

  if (!operator) return null;

  let left = words[0];
  let right = words[1];

  // OCR drops the sign more often than it reads it — five of six sampled
  // captchas came back as one run of words with nothing between them. The
  // operation is known from the image by then, so the only thing missing is
  // where to cut, and whitespace says it.
  //
  // Only an exact pair is accepted. Three tokens are genuinely ambiguous —
  // "ун икки уч" is either 10 and 23 or 12 and 3 — and guessing there would
  // submit a confident wrong answer, where refusing costs one fresh captcha.
  if (words.length === 1) {
    const tokens = words[0].split(/\s+/).filter(Boolean);
    if (tokens.length !== 2) return null;
    [left, right] = tokens;
  }

  const a = parseUzNumber(left);
  const b = parseUzNumber(right);
  if (a === null || b === null) return null;

  const fn = OPERATORS[operator];
  if (!fn) return null;

  const answer = fn(a, b);
  // mib.uz never asks for a negative result; one means the pair was read in
  // the wrong order or the sign is wrong, and submitting it wastes an attempt.
  return answer < 0 ? null : answer;
}

/**
 * O'zbek so'zni raqamga o'girish
 */
function parseUzNumber(phrase: string): number | null {
  const trimmed = phrase.trim().toLowerCase();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);

  // "ўн икки" is two words; so is "ун  икки" after OCR mangles the spacing.
  const tokens = trimmed.split(/\s+/).map(fold).filter(Boolean);
  if (!tokens.length) return null;

  if (tokens.length === 1) {
    const single = tokens[0];
    if (single in FOLDED) return FOLDED[single];

    // Written closed up: "уникки". Only teens are formed this way here.
    for (const [word, value] of Object.entries(FOLDED)) {
      if (
        value === 10 &&
        single.startsWith(word) &&
        single.length > word.length
      ) {
        const rest = single.slice(word.length);
        if (rest in FOLDED) return 10 + FOLDED[rest];
      }
    }
    return null;
  }

  // Two tokens: a teen, or a stray mark next to a number word.
  const [first, second] = tokens;
  if (FOLDED[first] === 10 && second in FOLDED) return 10 + FOLDED[second];
  if (first in FOLDED) return FOLDED[first];
  if (second in FOLDED) return FOLDED[second];
  return null;
}
