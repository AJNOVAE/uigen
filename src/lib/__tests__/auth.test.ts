// @vitest-environment node
import { describe, test, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// Mock server-only so the import doesn't throw in jsdom
vi.mock("server-only", () => ({}));

// Mock next/headers cookies()
const mockGet = vi.fn();
const mockSet = vi.fn();
const mockDelete = vi.fn();
vi.mock("next/headers", () => ({
  cookies: vi.fn(() =>
    Promise.resolve({ get: mockGet, set: mockSet, delete: mockDelete })
  ),
}));

// Keep real SignJWT (node env has no Uint8Array cross-realm issue);
// only mock jwtVerify to control return values in read-path tests.
const mockJwtVerify = vi.fn();
vi.mock("jose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jose")>();
  return { ...actual, jwtVerify: mockJwtVerify };
});

// Import after mocks are set up
const { getSession, createSession, deleteSession, verifySession } =
  await import("@/lib/auth");

// ---------------------------------------------------------------------------
// Helper: build a minimal NextRequest-shaped object for verifySession
// ---------------------------------------------------------------------------
function makeRequest(cookieValue?: string): NextRequest {
  return {
    cookies: {
      get: vi.fn((_name: string) =>
        cookieValue !== undefined ? { value: cookieValue } : undefined
      ),
    },
  } as unknown as NextRequest;
}

// ---------------------------------------------------------------------------
// createSession
// ---------------------------------------------------------------------------
describe("createSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "test");
  });

  test("sets a cookie named 'auth-token'", async () => {
    await createSession("user-1", "a@example.com");

    expect(mockSet).toHaveBeenCalledWith(
      "auth-token",
      expect.any(String),
      expect.anything()
    );
  });

  test("cookie value is a signed JWT with three base64url segments", async () => {
    await createSession("user-1", "a@example.com");

    const token: string = mockSet.mock.calls[0][1];
    expect(token.split(".")).toHaveLength(3);
  });

  test("sets httpOnly: true", async () => {
    await createSession("user-1", "a@example.com");

    expect(mockSet).toHaveBeenCalledWith(
      "auth-token",
      expect.any(String),
      expect.objectContaining({ httpOnly: true })
    );
  });

  test("sets sameSite: 'lax' and path: '/'", async () => {
    await createSession("user-1", "a@example.com");

    expect(mockSet).toHaveBeenCalledWith(
      "auth-token",
      expect.any(String),
      expect.objectContaining({ sameSite: "lax", path: "/" })
    );
  });

  test("sets secure: false outside production", async () => {
    vi.stubEnv("NODE_ENV", "test");

    await createSession("user-1", "a@example.com");

    expect(mockSet).toHaveBeenCalledWith(
      "auth-token",
      expect.any(String),
      expect.objectContaining({ secure: false })
    );
  });

  test("sets secure: true in production", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await createSession("user-1", "a@example.com");

    expect(mockSet).toHaveBeenCalledWith(
      "auth-token",
      expect.any(String),
      expect.objectContaining({ secure: true })
    );
  });

  test("sets cookie expiry approximately 7 days in the future", async () => {
    const before = Date.now();
    await createSession("user-1", "a@example.com");
    const after = Date.now();

    const { expires } = mockSet.mock.calls[0][2] as { expires: Date };
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    expect(expires.getTime()).toBeGreaterThanOrEqual(before + sevenDaysMs - 1000);
    expect(expires.getTime()).toBeLessThanOrEqual(after + sevenDaysMs + 1000);
  });
});

// ---------------------------------------------------------------------------
// getSession
// ---------------------------------------------------------------------------
describe("getSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("returns null when no auth-token cookie is present", async () => {
    mockGet.mockReturnValue(undefined);

    const session = await getSession();

    expect(session).toBeNull();
    expect(mockJwtVerify).not.toHaveBeenCalled();
  });

  test("returns null when the cookie value is an empty string", async () => {
    mockGet.mockReturnValue({ value: "" });

    const session = await getSession();

    expect(session).toBeNull();
    expect(mockJwtVerify).not.toHaveBeenCalled();
  });

  test("returns the session payload when the token is valid", async () => {
    const payload = {
      userId: "user-123",
      email: "test@example.com",
      expiresAt: new Date("2026-04-21T00:00:00.000Z"),
    };
    mockGet.mockReturnValue({ value: "valid.jwt.token" });
    mockJwtVerify.mockResolvedValue({ payload });

    const session = await getSession();

    expect(session).toEqual(payload);
    expect(mockJwtVerify).toHaveBeenCalledWith(
      "valid.jwt.token",
      expect.anything()
    );
  });

  test("returns null when jwtVerify throws (expired token)", async () => {
    mockGet.mockReturnValue({ value: "expired.jwt.token" });
    mockJwtVerify.mockRejectedValue(new Error("JWTExpired"));

    const session = await getSession();

    expect(session).toBeNull();
  });

  test("returns null when jwtVerify throws (invalid signature)", async () => {
    mockGet.mockReturnValue({ value: "tampered.jwt.token" });
    mockJwtVerify.mockRejectedValue(new Error("JWSInvalidSignature"));

    const session = await getSession();

    expect(session).toBeNull();
  });

  test("reads the cookie using the correct cookie name", async () => {
    mockGet.mockReturnValue(undefined);

    await getSession();

    expect(mockGet).toHaveBeenCalledWith("auth-token");
  });
});

// ---------------------------------------------------------------------------
// deleteSession
// ---------------------------------------------------------------------------
describe("deleteSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("deletes the auth-token cookie", async () => {
    await deleteSession();

    expect(mockDelete).toHaveBeenCalledWith("auth-token");
  });

  test("only deletes one cookie", async () => {
    await deleteSession();

    expect(mockDelete).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// verifySession
// ---------------------------------------------------------------------------
describe("verifySession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("returns null when no auth-token cookie is present on the request", async () => {
    const request = makeRequest(undefined);

    const session = await verifySession(request);

    expect(session).toBeNull();
    expect(mockJwtVerify).not.toHaveBeenCalled();
  });

  test("returns null when the cookie value is an empty string", async () => {
    const request = makeRequest("");

    const session = await verifySession(request);

    expect(session).toBeNull();
    expect(mockJwtVerify).not.toHaveBeenCalled();
  });

  test("returns the session payload when the token is valid", async () => {
    const payload = {
      userId: "user-456",
      email: "verify@example.com",
      expiresAt: new Date("2026-04-21T00:00:00.000Z"),
    };
    mockJwtVerify.mockResolvedValue({ payload });
    const request = makeRequest("valid.jwt.token");

    const session = await verifySession(request);

    expect(session).toEqual(payload);
    expect(mockJwtVerify).toHaveBeenCalledWith(
      "valid.jwt.token",
      expect.anything()
    );
  });

  test("returns null when jwtVerify throws (expired token)", async () => {
    mockJwtVerify.mockRejectedValue(new Error("JWTExpired"));
    const request = makeRequest("expired.jwt.token");

    const session = await verifySession(request);

    expect(session).toBeNull();
  });

  test("returns null when jwtVerify throws (invalid signature)", async () => {
    mockJwtVerify.mockRejectedValue(new Error("JWSInvalidSignature"));
    const request = makeRequest("tampered.jwt.token");

    const session = await verifySession(request);

    expect(session).toBeNull();
  });

  test("reads the cookie using the correct cookie name", async () => {
    const request = makeRequest(undefined);

    await verifySession(request);

    expect(request.cookies.get).toHaveBeenCalledWith("auth-token");
  });

  test("does not touch next/headers cookies (uses request cookies only)", async () => {
    const request = makeRequest("some.token");
    mockJwtVerify.mockResolvedValue({ payload: { userId: "u", email: "e", expiresAt: new Date() } });

    await verifySession(request);

    // next/headers mockGet should never be called — verifySession reads from the request
    expect(mockGet).not.toHaveBeenCalled();
  });
});
