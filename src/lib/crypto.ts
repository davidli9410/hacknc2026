// AES-256-GCM for secrets at rest (Google tokens).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "../config.ts";

let warned = false;
function key(): Buffer {
  const material = config.encryptionKey ?? config.photon.projectSecret;
  if (!material && !warned) {
    warned = true;
    console.warn("[crypto] ENCRYPTION_KEY is not set; using a development key. Set it before storing real tokens.");
  }
  return createHash("sha256").update(material ?? "foodie-dev-only-key").digest();
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}

export function decrypt(sealed: string): string {
  const [v, iv, tag, body] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !body) throw new Error("bad ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
}

export function randomCode(length: number, alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"): string {
  const bytes = randomBytes(length);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}
