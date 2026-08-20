"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.solveMathCaptcha = solveMathCaptcha;
const UZ_NUMBERS = {
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
    елти: 6,
    сакиз: 8,
    тукқиз: 9,
    тукгиз: 9,
};
function fold(word) {
    return word
        .toLowerCase()
        .replace(/ў/g, 'у')
        .replace(/қ/g, 'к')
        .replace(/ғ/g, 'г')
        .replace(/ҳ/g, 'х')
        .replace(/[’‘'`´]/g, '')
        .replace(/[^a-zа-яё0-9]/g, '');
}
const FOLDED = Object.entries(UZ_NUMBERS).reduce((acc, [word, value]) => {
    acc[fold(word)] = value;
    return acc;
}, {});
const OPERATORS = {
    '+': (a, b) => a + b,
    '-': (a, b) => a - b,
    '*': (a, b) => a * b,
    х: (a, b) => a * b,
    x: (a, b) => a * b,
};
function solveMathCaptcha(text, operatorHint) {
    const cleaned = text
        .toLowerCase()
        .replace(/[=?]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    let operator = operatorHint ?? null;
    const words = cleaned
        .split(/[+\-*xх]/)
        .map((s) => s.trim())
        .filter(Boolean);
    if (!operator) {
        const found = cleaned.match(/[+\-*xх]/);
        if (found)
            operator = found[0];
    }
    if (!operator)
        return null;
    let left = words[0];
    let right = words[1];
    if (words.length === 1) {
        const tokens = words[0].split(/\s+/).filter(Boolean);
        if (tokens.length !== 2)
            return null;
        [left, right] = tokens;
    }
    const a = parseUzNumber(left);
    const b = parseUzNumber(right);
    if (a === null || b === null)
        return null;
    const fn = OPERATORS[operator];
    if (!fn)
        return null;
    const answer = fn(a, b);
    return answer < 0 ? null : answer;
}
function parseUzNumber(phrase) {
    const trimmed = phrase.trim().toLowerCase();
    if (/^\d+$/.test(trimmed))
        return parseInt(trimmed, 10);
    const tokens = trimmed.split(/\s+/).map(fold).filter(Boolean);
    if (!tokens.length)
        return null;
    if (tokens.length === 1) {
        const single = tokens[0];
        if (single in FOLDED)
            return FOLDED[single];
        for (const [word, value] of Object.entries(FOLDED)) {
            if (value === 10 &&
                single.startsWith(word) &&
                single.length > word.length) {
                const rest = single.slice(word.length);
                if (rest in FOLDED)
                    return 10 + FOLDED[rest];
            }
        }
        return null;
    }
    const [first, second] = tokens;
    if (FOLDED[first] === 10 && second in FOLDED)
        return 10 + FOLDED[second];
    if (first in FOLDED)
        return FOLDED[first];
    if (second in FOLDED)
        return FOLDED[second];
    return null;
}
//# sourceMappingURL=mib-captcha.solver.js.map