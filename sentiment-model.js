// The model behind GET /sentiment: where it comes from, which files it needs
// and what each one must hash to. Shared by scripts/fetch-sentiment-model.js
// (downloads it during `npm install`, i.e. Render's build command) and
// server.js (loads it from disk at boot), so the two can never disagree about
// which model is live. To change models, change this file and nothing else.
import { fileURLToPath } from "node:url";

// The owner's own copy, duplicated on 2026-11-25 from
// 9mark9/finbert-minilm-sentiment at b17b64a (the version that was benchmarked;
// all 18 files verified identical). A copy we control, so the build does not
// depend on a third party keeping their repo up. MIT licensed.
export const SENTIMENT_MODEL_ID = "looky/finbert-minilm-sentiment";
export const SENTIMENT_MODEL_REVISION = "32cb91e5338baafe0302e0c4e3ff2e319b178d40";

// Transformers.js reads <MODELS_DIR>/<SENTIMENT_MODEL_ID>/... when loading.
// Gitignored: the files arrive at build time, not through git.
export const MODELS_DIR = fileURLToPath(new URL("./models/", import.meta.url));

// Only what an int8 text-classification run needs, plus the license, which the
// MIT terms ask to travel with copies of the model. The pinned commit fixes the
// bytes; the hashes catch a corrupted or substituted download.
export const SENTIMENT_MODEL_FILES = [
  { path: "config.json", bytes: 874, sha256: "976b19d93da6e6de515241e450f9baf363a5c1c8906812cacf51606653d5dd47" },
  { path: "tokenizer.json", bytes: 711659, sha256: "c3bbeac7c7669ec478d44bac871031a47b39935533558d252d5b7699e7d4d457" },
  { path: "tokenizer_config.json", bytes: 350, sha256: "b11380122f79e6ca63b0dba8be8ba337aa17394f3f3e9532221f0de944e66b28" },
  { path: "onnx/model_quantized.onnx", bytes: 33974960, sha256: "b85fd2d5b85ea7d3ad201e8d84e5162866fe635b1134c6d2652f814ccedc6c1b" },
  { path: "LICENSE", bytes: 1071, sha256: "8335841a4a17bea254caa05233e90cd38edad0c6ee9bb6a2031637918468b876" },
];
