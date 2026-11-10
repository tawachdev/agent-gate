import { SignJWT, jwtVerify, errors } from "jose";

const ISSUER = "agent-gate";
const AUDIENCE = "agent-gate/pending-action/v1";
const MIN_SECRET_BYTES = 32;

export interface PendingClaims {
  tokenId: string;
  actorId: string;
  tool: string;
  input: unknown;
  expiresAt: Date;
}

export type VerifyFailure = "invalid_token" | "expired";

export function readSecret(secret: string | Uint8Array): Uint8Array<ArrayBuffer> {
  const raw = typeof secret === "string" ? new TextEncoder().encode(secret) : new Uint8Array(secret);
  if (raw.byteLength < MIN_SECRET_BYTES) {
    throw new RangeError(`agent-gate: secret must be at least ${MIN_SECRET_BYTES} bytes`);
  }
  return raw;
}

export async function deriveSigningKey(raw: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const purpose = new TextEncoder().encode(AUDIENCE);
  return new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, purpose));
}

export async function signPending(
  key: Uint8Array,
  claims: Omit<PendingClaims, "tokenId" | "expiresAt">,
  ttlSeconds: number,
): Promise<{ token: string; tokenId: string; expiresAt: Date }> {
  const tokenId = crypto.randomUUID();
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = new Date((issuedAt + ttlSeconds) * 1000);
  const token = await new SignJWT({ tool: claims.tool, input: claims.input })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(claims.actorId)
    .setJti(tokenId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ttlSeconds)
    .sign(key);
  return { token, tokenId, expiresAt };
}

export async function verifyPending(
  key: Uint8Array,
  token: string,
): Promise<{ ok: true; claims: PendingClaims } | { ok: false; reason: VerifyFailure }> {
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: AUDIENCE,
      requiredClaims: ["sub", "jti", "exp", "tool"],
    });
    if (typeof payload.tool !== "string" || !payload.sub || !payload.jti || !payload.exp) {
      return { ok: false, reason: "invalid_token" };
    }
    return {
      ok: true,
      claims: {
        tokenId: payload.jti,
        actorId: payload.sub,
        tool: payload.tool,
        input: payload.input,
        expiresAt: new Date(payload.exp * 1000),
      },
    };
  } catch (error) {
    if (error instanceof errors.JWTExpired) return { ok: false, reason: "expired" };
    if (error instanceof errors.JOSEError) return { ok: false, reason: "invalid_token" };
    throw error;
  }
}
