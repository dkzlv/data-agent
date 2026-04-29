import { describe, expect, it } from "vitest";
import {
  decryptCredentials,
  encryptCredentials,
  generateMasterKey,
  type EncryptedRecord,
} from "./encryption";

const MASTER = generateMasterKey();

describe("envelope encryption", () => {
  it("round-trips a credential bundle", async () => {
    const aad = { tenantId: "tenant_a", dbProfileId: "profile_1" };
    const plaintext = {
      user: "neondb_owner",
      password: "supersecret",
      host: "ep-x.eu-central-1.aws.neon.tech",
    };
    const enc = await encryptCredentials(MASTER, plaintext, aad);
    expect(enc.ciphertext).toBeInstanceOf(Uint8Array);
    expect(enc.encryptedDek).toBeInstanceOf(Uint8Array);
    expect(enc.keyVersion).toBe(1);
    const dec = await decryptCredentials(MASTER, enc, aad);
    expect(dec).toEqual(plaintext);
  });

  it("rejects ciphertext with mismatched AAD (cross-tenant guard)", async () => {
    const aad = { tenantId: "tenant_a", dbProfileId: "profile_1" };
    const enc = await encryptCredentials(MASTER, { secret: "x" }, aad);
    await expect(
      decryptCredentials(MASTER, enc, { tenantId: "tenant_b", dbProfileId: "profile_1" })
    ).rejects.toThrow();
  });

  it("rejects with a different master key", async () => {
    const aad = { tenantId: "t", dbProfileId: "p" };
    const enc = await encryptCredentials(MASTER, { x: 1 }, aad);
    const other = generateMasterKey();
    await expect(decryptCredentials(other, enc, aad)).rejects.toThrow();
  });

  it("rejects when the encrypted DEK is swapped between records", async () => {
    const aad = { tenantId: "t", dbProfileId: "p1" };
    const aad2 = { tenantId: "t", dbProfileId: "p2" };
    const enc1 = await encryptCredentials(MASTER, { v: "one" }, aad);
    const enc2 = await encryptCredentials(MASTER, { v: "two" }, aad2);
    const swapped: EncryptedRecord = {
      ciphertext: enc1.ciphertext,
      encryptedDek: enc2.encryptedDek,
      keyVersion: enc1.keyVersion,
    };
    await expect(decryptCredentials(MASTER, swapped, aad)).rejects.toThrow();
  });
});
