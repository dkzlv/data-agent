import { describe, expect, it } from "vitest";
import { mintChatToken, verifyChatToken } from "./jwt";

const SECRET = "S6IyArqQyKkN+ZRXyHAa9bRtkuuiLmf8ZgfTbZ5+gxQ=";

describe("chat token", () => {
  it("round-trips a valid token", async () => {
    const token = await mintChatToken(SECRET, {
      userId: "user_1",
      chatId: "chat_a",
      tenantId: "tenant_x",
    });
    expect(typeof token).toBe("string");
    const claims = await verifyChatToken(SECRET, token, { chatId: "chat_a" });
    expect(claims).toEqual({
      userId: "user_1",
      chatId: "chat_a",
      tenantId: "tenant_x",
    });
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await mintChatToken(SECRET, {
      userId: "u",
      chatId: "c",
      tenantId: "t",
    });
    await expect(
      verifyChatToken("wrong-secret-1234567890", token, { chatId: "c" })
    ).rejects.toThrow();
  });

  it("rejects when chatId doesn't match", async () => {
    const token = await mintChatToken(SECRET, {
      userId: "u",
      chatId: "chat_a",
      tenantId: "t",
    });
    await expect(verifyChatToken(SECRET, token, { chatId: "chat_b" })).rejects.toThrow(
      /chatId mismatch/
    );
  });

  it("rejects an expired token", async () => {
    const token = await mintChatToken(
      SECRET,
      { userId: "u", chatId: "c", tenantId: "t" },
      0 // expires immediately
    );
    // Wait a moment so exp < now
    await new Promise((r) => setTimeout(r, 50));
    await expect(verifyChatToken(SECRET, token, { chatId: "c" })).rejects.toThrow();
  });
});
