import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function signSessionPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function sessionTokenHash(opaqueToken: string): string {
  return createHash("sha256").update(opaqueToken).digest("hex");
}

export function verifiedSessionToken(value: string | null, secret: string): { opaqueToken: string } | null {
  if (!value) return null;
  const [version, opaqueToken, suppliedSignature, extra] = value.split(".");
  if (version !== "v2" || !opaqueToken || !suppliedSignature || extra !== undefined
    || !/^[A-Za-z0-9_-]{43}$/.test(opaqueToken)) return null;
  const payload = `${version}.${opaqueToken}`;
  return safeEqual(suppliedSignature, signSessionPayload(payload, secret)) ? { opaqueToken } : null;
}

export function csrfToken(sessionCookieValue: string, secret: string): string {
  return signSessionPayload(`csrf|${sessionCookieValue}`, secret);
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function cookie(header: string | undefined, name: string): string | null {
  for (const part of header?.split(";") ?? []) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

export function sessionCookie(value: string, maximumAgeSeconds: number, secure: boolean): string {
  return `dop_ops_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maximumAgeSeconds}${secure ? "; Secure" : ""}`;
}
