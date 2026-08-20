"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cropFrame = cropFrame;
exports.detectOperator = detectOperator;
exports.readOperator = readOperator;
const jimp_1 = require("jimp");
const isInk = (img, x, y) => {
    const { r, g, b } = (0, jimp_1.intToRGBA)(img.getPixelColor(x, y));
    return (r + g + b) / 3 < 128;
};
function cropFrame(img, px = 2) {
    const { width, height } = img.bitmap;
    if (width <= px * 2 || height <= px * 2)
        return img;
    return img.crop({ x: px, y: px, w: width - px * 2, h: height - px * 2 });
}
function blobs(img) {
    const { width, height } = img.bitmap;
    const out = [];
    let start = null;
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
        if (inked && start === null)
            start = x;
        if (!inked && start !== null) {
            let top = null;
            let bottom = 0;
            for (let y = 0; y < height; y++) {
                for (let x2 = start; x2 < x; x2++) {
                    if (isInk(img, x2, y)) {
                        if (top === null)
                            top = y;
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
function detectOperator(img) {
    const found = blobs(img);
    if (found.length < 3)
        return null;
    const heights = found.map((b) => b.height).sort((a, b) => a - b);
    const median = heights[Math.floor(heights.length / 2)];
    if (!median)
        return null;
    const { width, height } = img.bitmap;
    const bar = found.find((b) => b.height <= Math.max(6, median * 0.4) &&
        b.width <= median &&
        Math.abs((b.top + b.bottom) / 2 - height / 2) <= height * 0.15 &&
        b.x0 < width * 0.8);
    return bar ? '-' : '+';
}
async function readOperator(buffer) {
    try {
        const img = await jimp_1.Jimp.read(buffer);
        return detectOperator(cropFrame(img));
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=mib-captcha.image.js.map