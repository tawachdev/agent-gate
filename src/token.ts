import { SignJWT, jwtVerify, errors, type JWTPayload } from "jose";
import * as z from "zod";
import type { ActionSummary } from "./tool.js";

const ISSUER = "agent-gate";
const AUDIENCE = "agent-gate/pending-action/v1";
const TOKEN_TYPE = "agent-gate+jwt";
const MIN_SECRET_BYTES = 32;
const MAX_SECRETS = 5;

export type Secret = string | Uint8Array;

const signedClaimsSchema = z.object({
  sub: z.string().min(1),
  jti: z.string().min(1),
  exp: z.number().int(),
  tool: z.string().min(1),
  scp: z.string().optional(),
  sum: z.object({ action: z.string(), target: z.string(), danger: z.boolean() }),
});

export interface PendingClaims {
  tokenId: string;
  actorId: string;
  scope: string | undefined;
  tool: string;
  input: unknown;
  summary: ActionSummary;
  expiresAt: Date;
}

export type VerifyFailure = "invalid_token" | "expired";

function readSecret(secret: Secret): Uint8Array<ArrayBuffer> {
  const raw = typeof secret === "string" ? new TextEncoder().encode(secret) : new Uint8Array(secret);
  if (raw.byteLength < MIN_SECRET_BYTES) {
    throw new RangeError(`agent-gate: secret must be at least ${MIN_SECRET_BYTES} bytes`);
  }
  return raw;
}

export function readSecrets(secret: Secret | readonly Secret[]): Uint8Array<ArrayBuffer>[] {
  const list = typeof secret === "string" || secret instanceof Uint8Array ? [secret] : [...secret];
  if (list.length < 1 || list.length > MAX_SECRETS) {
    throw new RangeError(`agent-gate: give between 1 and ${MAX_SECRETS} secrets`);
  }
  return list.map(readSecret);
}

async function deriveSigningKey(raw: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode(AUDIENCE) },
    material,
    256,
  );
  return new Uint8Array(bits);
}

export function deriveSigningKeys(secrets: Uint8Array<ArrayBuffer>[]): Promise<Uint8Array[]> {
  return Promise.all(secrets.map(deriveSigningKey));
}

export async function signPending(
  key: Uint8Array,
  claims: Omit<PendingClaims, "tokenId" | "expiresAt">,
  ttlSeconds: number,
): Promise<{ token: string; tokenId: string; expiresAt: Date }> {
  const tokenId = crypto.randomUUID();
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = new Date((issuedAt + ttlSeconds) * 1000);
  const payload: JWTPayload = { tool: claims.tool, input: claims.input, sum: claims.summary };
  if (claims.scope !== undefined) payload.scp = claims.scope;
  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: TOKEN_TYPE })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(claims.actorId)
    .setJti(tokenId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ttlSeconds)
    .sign(key);
  return { token, tokenId, expiresAt };
}

async function verifySignature(
  keys: Uint8Array[],
  token: string,
): Promise<{ ok: true; payload: JWTPayload } | { ok: false; reason: VerifyFailure }> {
  for (const key of keys) {
    try {
      const { payload } = await jwtVerify(token, key, {
        algorithms: ["HS256"],
        typ: TOKEN_TYPE,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      return { ok: true, payload };
    } catch (error) {
      if (error instanceof errors.JWSSignatureVerificationFailed) continue;
      if (error instanceof errors.JWTExpired) return { ok: false, reason: "expired" };
      if (error instanceof errors.JOSEError) return { ok: false, reason: "invalid_token" };
      throw error;
    }
  }
  return { ok: false, reason: "invalid_token" };
}

export async function verifyPending(
  keys: Uint8Array[],
  token: string,
): Promise<{ ok: true; claims: PendingClaims } | { ok: false; reason: VerifyFailure }> {
  const verified = await verifySignature(keys, token);
  if (!verified.ok) return verified;
  const { payload } = verified;
  const parsed = signedClaimsSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, reason: "invalid_token" };
  const claims = parsed.data;
  return {
    ok: true,
    claims: {
      tokenId: claims.jti,
      actorId: claims.sub,
      scope: claims.scp,
      tool: claims.tool,
      input: payload.input,
      summary: claims.sum,
      expiresAt: new Date(claims.exp * 1000),
    },
  };
}
