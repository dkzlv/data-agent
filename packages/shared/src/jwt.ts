/**
 * Internal JWT minting + validation. Used by api-gateway to authenticate
 * requests forwarded to ChatAgent via service binding.
 *
 * HS256 with the shared `INTERNAL_JWT_SIGNING_KEY` from Secrets Store.
 * Tokens are short-lived (5 min default) and bound to a specific chat.
 */
import { SignJWT, jwtVerify } from "jose";

export interface ChatTokenClaims {
  /** Authenticated user id (better-auth user.id). */
  userId: string;
  /** Chat id this token is scoped to. */
  chatId: string;
  /** Tenant id, for downstream authorization. */
  tenantId: string;
}

const ISSUER = "data-agent.api-gateway";
const AUDIENCE = "data-agent.chat-agent";
const DEFAULT_TTL_SECONDS = 300; // 5 minutes

function keyFromString(secret: string): Uint8Array {
  // Accepts base64 or raw — base64 is the convention in our .dev.vars.
  if (/^[A-Za-z0-9+/=]+$/.test(secret) && secret.length >= 40) {
    try {
      return Uint8Array.from(atob(secret), (c) => c.charCodeAt(0));
    } catch {
      // fall through
    }
  }
  return new TextEncoder().encode(secret);
}

export async function mintChatToken(
  secret: string,
  claims: ChatTokenClaims,
  ttlSeconds = DEFAULT_TTL_SECONDS
): Promise<string> {
  const key = keyFromString(secret);
  return await new SignJWT({
    chatId: claims.chatId,
    tenantId: claims.tenantId,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(claims.userId)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key);
}

export async function verifyChatToken(
  secret: string,
  token: string,
  expected: { chatId: string }
): Promise<ChatTokenClaims> {
  const key = keyFromString(secret);
  const { payload } = await jwtVerify(token, key, {
    issuer: ISSUER,
    audience: AUDIENCE,
  });

  const userId = payload.sub;
  const chatId = payload.chatId as unknown;
  const tenantId = payload.tenantId as unknown;

  if (typeof userId !== "string" || !userId) {
    throw new Error("invalid token: missing sub");
  }
  if (typeof chatId !== "string" || !chatId) {
    throw new Error("invalid token: missing chatId");
  }
  if (typeof tenantId !== "string" || !tenantId) {
    throw new Error("invalid token: missing tenantId");
  }
  if (chatId !== expected.chatId) {
    throw new Error(
      `invalid token: chatId mismatch (token=${chatId}, expected=${expected.chatId})`
    );
  }

  return { userId, chatId, tenantId };
}
