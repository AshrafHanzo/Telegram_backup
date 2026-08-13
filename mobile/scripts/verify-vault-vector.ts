// Standalone check against the desktop code's own known-answer test vector
// (app/src-tauri/src/crypto/envelope/vectors.rs::deterministic_one_byte_known_answer_vector).
// Run with: npx tsx scripts/verify-vault-vector.ts
import { parseEnvelopeHeader, unwrapDekRaw } from "../src/vault/format";
import { decryptEnvelope } from "../src/vault/format";
import { bytesToUtf8 } from "../src/vault/bytes";

const VECTOR_UUID = new Uint8Array(16).fill(0x11);
const VECTOR_WRAP_NONCE = new Uint8Array(24).fill(0x33);
const VECTOR_SALT = new Uint8Array(16).fill(0x44);
const VECTOR_WRAPPING_KEY = new Uint8Array(32).fill(0x66);

const EXPECTED_BASE64 =
  "VERFTkMyAgARERERERERERERERERERERAQDqAAAAAAAQAGgAAAAgAAAAAQAAAAAAAAAiIiIiIiIiIiIiIiIiIiIit7z2o+7K5i1I6DhWw93RdHY1nkOZL15ujAqL/DRTUQ0BAAIAAAAAAAAAAAAAAAAARERERERERERERERERERERDMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM33Ea/edQkku0qAFd1z1ZR2k5Drbm+nJC8OQkgqXailEtBOVbUKzXSMZTQI+0vnEIzU2fDg9e99NJajCjcaW99v8ZDZebH4aULrpyo4itvmOf3V27qdJ0D7GhcJWpazjEPJsBs8n3H0/ceGIsz4mIoIFD9KqGpGz93yGEfGPmaUiPkrOlCn6zWFS5dOzdmTAxHBP3l1td3fyb0PZZbdfgLeG/dX0yA==";

function main() {
  const ciphertext = Uint8Array.from(Buffer.from(EXPECTED_BASE64, "base64"));

  const header = parseEnvelopeHeader(ciphertext);
  console.log("Header parsed OK. Slots:", header.keySlots.length);

  const slot = header.keySlots[0];
  const dek = unwrapDekRaw(slot, header.core.fileUuid, VECTOR_WRAPPING_KEY);
  console.log("DEK unwrapped OK, length:", dek.length);

  const result = decryptEnvelope(ciphertext, dek);
  const plaintext = bytesToUtf8(result.plaintext);
  const metadata = bytesToUtf8(result.metadata);

  console.log("Plaintext:", JSON.stringify(plaintext));
  console.log("Metadata:", JSON.stringify(metadata));

  const uuidMatches = result.fileUuid.every((b, i) => b === VECTOR_UUID[i]);
  const ok = plaintext === "X" && metadata === '{"name":"x.txt"}' && uuidMatches;

  if (!ok) {
    console.error("MISMATCH — implementation does not match the known-answer vector.");
    process.exit(1);
  }
  console.log("MATCH — implementation is byte-exact against the desktop known-answer vector.");
}

main();
