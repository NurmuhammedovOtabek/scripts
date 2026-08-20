import { Jimp, intToRGBA } from 'jimp';

/**
 * Reading the captcha image itself, for the two things OCR gets wrong.
 *
 * The images are 300x50, black text on white, no noise or distortion — easy to
 * read by eye. Two properties of them defeated the OCR pipeline anyway.
 */

/** A pixel dark enough to count as ink. */
const isInk = (img: any, x: number, y: number): boolean => {
  const { r, g, b } = intToRGBA(img.getPixelColor(x, y));
  return (r + g + b) / 3 < 128;
};

/**
 * The 2px frame drawn around every captcha.
 *
 * This is what was costing most of the reads. A closed rectangle enclosing the
 * whole image gives the line segmenter a box to interpret, and Tesseract
 * returned an empty string for two of the first three captchas at every
 * preprocessing setting and page-segmentation mode tried. Cropping it took the
 * same three images from one readable to three.
 */
export function cropFrame(img: any, px = 2): any {
  const { width, height } = img.bitmap;
  if (width <= px * 2 || height <= px * 2) return img;
  return img.crop({ x: px, y: px, w: width - px * 2, h: height - px * 2 });
}

interface Blob {
  x0: number;
  width: number;
  height: number;
  top: number;
  bottom: number;
}

/** Ink grouped into runs of columns separated by blank columns. */
function blobs(img: any): Blob[] {
  const { width, height } = img.bitmap;
  const out: Blob[] = [];
  let start: number | null = null;

  for (let x = 0; x <= width; x++) {
    let inked = false;
    if (x < width) {
      for (let y = 0; y < height; y++) {
        if (isInk(img, x, y)) {
          inked = true;
          break;
        }
      }
    }
    if (inked && start === null) start = x;
    if (!inked && start !== null) {
      let top: number | null = null;
      let bottom = 0;
      for (let y = 0; y < height; y++) {
        for (let x2 = start; x2 < x; x2++) {
          if (isInk(img, x2, y)) {
            if (top === null) top = y;
            bottom = y;
            break;
          }
        }
      }
      out.push({
        x0: start,
        width: x - start,
        height: bottom - (top ?? 0) + 1,
        top: top ?? 0,
        bottom,
      });
      start = null;
    }
  }
  return out;
}

/**
 * Which operation the captcha is asking for, measured rather than recognised.
 *
 * OCR cannot be trusted with this character and the cost of being wrong is
 * high: reading `-` where the image says `+` produces a confident wrong answer
 * that gets submitted. Across sampled captchas it dropped the `+` entirely
 * twice and once reported it as `-`.
 *
 * The shapes settle it without recognising anything. Letters in this font are
 * 16px tall and the trailing `=` is 14 wide by 11 tall. A minus is a lone
 * horizontal bar — 9 wide, 4 tall, centred — and nothing else in the image is
 * that flat. A plus is tall enough to be indistinguishable from a letter by
 * height, so it is not looked for directly: its absence is what identifies it.
 *
 * Returns null when the image cannot be read at all, so the caller can fetch a
 * fresh captcha rather than guess.
 */
export function detectOperator(img: any): '+' | '-' | null {
  const found = blobs(img);
  if (found.length < 3) return null;

  const heights = found.map((b) => b.height).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)];
  if (!median) return null;

  const { width, height } = img.bitmap;
  const bar = found.find(
    (b) =>
      b.height <= Math.max(6, median * 0.4) &&
      b.width <= median &&
      // Vertically centred, which a comma or a full stop is not.
      Math.abs((b.top + b.bottom) / 2 - height / 2) <= height * 0.15 &&
      // Before the trailing `=`, which is also flat-ish but sits at the end.
      b.x0 < width * 0.8,
  );

  return bar ? '-' : '+';
}

/** Loads, crops the frame, and reports the operator. */
export async function readOperator(buffer: Buffer): Promise<'+' | '-' | null> {
  try {
    const img = await Jimp.read(buffer);
    return detectOperator(cropFrame(img));
  } catch {
    return null;
  }
}
