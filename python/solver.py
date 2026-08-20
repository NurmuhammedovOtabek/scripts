"""
Captcha solver — long-lived child process.

Reads JSON-lines from stdin, writes JSON-lines to stdout.
Each request: {"id": int, "image_base64": str, "type"?: "digits"|"alpha"|"alnum", "length"?: int}
Each response: {"id": int, "code": str, "length": int} or {"id": int, "error": str}

The ONNX model is loaded once at startup — subsequent solves are ~10-30ms.
"""

import base64
import json
import re
import sys

import ddddocr

_FILTERS = {
    "digits": re.compile(r"[^0-9]"),
    "alpha":  re.compile(r"[^a-zA-Z]"),
    "alnum":  re.compile(r"[^a-zA-Z0-9]"),
}


def _emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> None:
    # Load model once. Logs go to stderr so Node sees them; stdout is the protocol.
    print("[solver] loading ddddocr model...", file=sys.stderr, flush=True)
    ocr = ddddocr.DdddOcr(show_ad=False)
    print("[solver] ready", file=sys.stderr, flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")

            image_b64 = req.get("image_base64")
            if not image_b64:
                _emit({"id": req_id, "error": "image_base64 is required"})
                continue

            if "," in image_b64 and image_b64.startswith("data:"):
                image_b64 = image_b64.split(",", 1)[1]

            image_bytes = base64.b64decode(image_b64.strip())
            raw = ocr.classification(image_bytes)

            charset = req.get("type", "alnum")
            filter_re = _FILTERS.get(charset)
            code = filter_re.sub("", raw) if filter_re else raw

            expected_length = req.get("length")
            if expected_length and len(code) != int(expected_length):
                _emit({
                    "id": req_id,
                    "error": f"length mismatch: got {len(code)} expected {expected_length}",
                    "code": code,
                })
                continue

            _emit({"id": req_id, "code": code, "length": len(code)})
        except Exception as e:
            _emit({"id": req_id, "error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    main()
