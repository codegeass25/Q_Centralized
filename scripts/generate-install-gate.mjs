/* =====================================================================
   Generates install-gate.js verification data from the environment
   variable QLOG_INSTALLATION_PASSWORD (supplied by the GitHub Actions
   repository secret of the same name).

   - Reads the plaintext password ONLY from the environment.
   - Writes ONLY a random salt + an iterated SHA-256 digest.
   - Never prints the password (or any part of it) to stdout/stderr.

   Usage:  node scripts/generate-install-gate.mjs [outputFile]
   ===================================================================== */
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

const OUT = process.argv[2] || "install-gate.js";
const ITERATIONS = 25000;

const password = process.env.QLOG_INSTALLATION_PASSWORD;
if (!password || !password.trim()) {
  console.error(
    "ERROR: QLOG_INSTALLATION_PASSWORD is not set.\n" +
      "Add it in GitHub: Settings > Secrets and variables > Actions > Secrets > New repository secret.\n" +
      "See INSTALLATION_PASSWORD_GITHUB_SETUP.md."
  );
  process.exit(1);
}

const sha256 = (str) => createHash("sha256").update(Buffer.from(str, "latin1")).digest("hex");

/* Must match _authDerive() in index.html exactly. */
function derive(pw, salt, iterations) {
  const utf8AsLatin1 = Buffer.from(pw, "utf8").toString("latin1");
  let h = sha256(salt + "|" + utf8AsLatin1);
  for (let i = 1; i < iterations; i++) h = sha256(h + salt);
  return h;
}

const salt = randomBytes(16).toString("hex");
const hash = derive(password, salt, ITERATIONS);
const built = new Date().toISOString();

const file = `/* GENERATED AT BUILD TIME - DO NOT EDIT, DO NOT COMMIT.
   Contains only a random salt and a one-way iterated SHA-256 digest of the
   Installation Password. The plaintext password is not recoverable from here. */
window.QLOG_INSTALL_GATE = {
  v: 1,
  s: ${JSON.stringify(salt)},
  h: ${JSON.stringify(hash)},
  i: ${ITERATIONS},
  built: ${JSON.stringify(built)}
};
`;

writeFileSync(OUT, file, "utf8");
console.log(
  `Installation gate data written to ${OUT} (salt ${salt.slice(0, 8)}..., ${ITERATIONS} iterations, fingerprint ${sha256("qlog-gate|" + salt + "|" + hash).slice(0, 32)}, built ${built}).`
);
