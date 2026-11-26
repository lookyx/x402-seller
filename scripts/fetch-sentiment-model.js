// Downloads the /sentiment model into ./models. Runs as the `postinstall`
// script, so Render's build command (`npm install`) fetches it on every build
// and the running server never has to contact Hugging Face.
//
// Each file comes from the pinned commit and must match its SHA-256 in
// sentiment-model.js. A file already on disk with the right hash is kept, so a
// local `npm install` only downloads once.
//
// If a download still fails after retries this exits non-zero, which fails the
// build. That is deliberate: Render then keeps the previous deploy live rather
// than shipping a server whose /sentiment can only answer 503. If Hugging Face
// is down and something else has to ship, set SKIP_SENTIMENT_MODEL=1 in the
// environment: the build succeeds, the server boots, and /sentiment answers 503
// (not billed) until a build with the model goes out.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  MODELS_DIR,
  SENTIMENT_MODEL_FILES,
  SENTIMENT_MODEL_ID,
  SENTIMENT_MODEL_REVISION,
} from "../sentiment-model.js";

const ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 120_000;
const log = (msg) => console.log(`[sentiment-model] ${msg}`);

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function alreadyThere(dest, expected) {
  try {
    return sha256(await readFile(dest)) === expected;
  } catch {
    return false;
  }
}

async function download(file, dest) {
  const url = `https://huggingface.co/${SENTIMENT_MODEL_ID}/resolve/${SENTIMENT_MODEL_REVISION}/${file.path}`;
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      const body = Buffer.from(await res.arrayBuffer());
      const got = sha256(body);
      if (got !== file.sha256) throw new Error(`checksum mismatch: expected ${file.sha256}, got ${got}`);
      // Write beside the target and rename, so an interrupted build never
      // leaves a truncated file that a later run could mistake for the model.
      const partial = `${dest}.partial`;
      await writeFile(partial, body);
      await rename(partial, dest);
      return;
    } catch (err) {
      lastError = err;
      if (attempt < ATTEMPTS) {
        log(`${file.path}: attempt ${attempt} failed (${err.message}); retrying`);
        await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
      }
    }
  }
  throw new Error(`${file.path}: ${lastError.message}`);
}

async function main() {
  if (process.env.SKIP_SENTIMENT_MODEL === "1") {
    log("SKIP_SENTIMENT_MODEL=1, not downloading. /sentiment will answer 503 until a build includes the model.");
    return;
  }
  const dir = path.join(MODELS_DIR, SENTIMENT_MODEL_ID);
  let downloaded = 0;
  for (const file of SENTIMENT_MODEL_FILES) {
    const dest = path.join(dir, file.path);
    if (await alreadyThere(dest, file.sha256)) continue;
    await mkdir(path.dirname(dest), { recursive: true });
    await download(file, dest);
    downloaded++;
  }
  log(
    `${SENTIMENT_MODEL_ID}@${SENTIMENT_MODEL_REVISION.slice(0, 7)} ready ` +
      `(${downloaded} file(s) downloaded, ${SENTIMENT_MODEL_FILES.length - downloaded} already present)`,
  );
}

main().catch((err) => {
  console.error(`[sentiment-model] download failed: ${err.message}`);
  console.error("[sentiment-model] To build without the model, set SKIP_SENTIMENT_MODEL=1 (/sentiment then answers 503).");
  process.exit(1);
});
