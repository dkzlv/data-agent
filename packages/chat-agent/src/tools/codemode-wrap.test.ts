import { describe, expect, it, vi } from "vitest";
import {
  buildTruncatedMarker,
  DEFAULT_RESULT_CHAR_CAP,
  maybeTruncateResult,
  wrapCodemodeTool,
  type CodemodeWrapEvent,
} from "./codemode-wrap";

// Minimal stand-in for the AI SDK's `Tool` type. The wrapper only
// touches `.execute` so a plain object is sufficient.
type FakeTool = {
  description: string;
  inputSchema: { type: "object" };
  execute: (input: unknown, ctx?: unknown) => Promise<unknown>;
};

function makeTool(execute: FakeTool["execute"]): FakeTool {
  return {
    description: "fake codemode tool",
    inputSchema: { type: "object" },
    execute,
  };
}

describe("maybeTruncateResult", () => {
  it("returns the value unchanged when under the cap", () => {
    const r = maybeTruncateResult({ ok: 1 }, 100);
    expect(r.truncated).toBe(false);
    expect(r.value).toEqual({ ok: 1 });
  });

  it("replaces the value with a marker when over the cap", () => {
    const big = { rows: Array.from({ length: 1000 }, (_, i) => ({ id: i })) };
    const r = maybeTruncateResult(big, 100);
    expect(r.truncated).toBe(true);
    if (r.truncated) {
      expect(r.originalChars).toBeGreaterThan(100);
      const v = r.value as ReturnType<typeof buildTruncatedMarker>;
      expect(v._truncated).toBe(true);
      expect(v.cap).toBe(100);
      expect(v.originalChars).toBe(r.originalChars);
      expect(v.hint).toMatch(/LIMIT|aggregate|GROUP BY/);
    }
  });

  it("handles non-serializable inputs (circular)", () => {
    const a: { self?: unknown } = {};
    a.self = a;
    const r = maybeTruncateResult(a, 100);
    expect(r.truncated).toBe(true);
    if (r.truncated) {
      expect((r.value as { _truncated: boolean })._truncated).toBe(true);
    }
  });

  it("treats undefined as fits-under-cap (JSON.stringify returns undefined)", () => {
    // `undefined` is what executors might return when the user code
    // returns nothing. Don't replace it — let it pass through.
    const r = maybeTruncateResult(undefined, 100);
    expect(r.truncated).toBe(false);
    expect(r.value).toBeUndefined();
  });

  it("respects the boundary exactly at the cap", () => {
    // Pick a string whose JSON length is exactly N.
    const s = "x".repeat(98); // JSON.stringify adds 2 quotes → length 100
    const r = maybeTruncateResult(s, 100);
    expect(r.truncated).toBe(false);
    const r2 = maybeTruncateResult(`${s}y`, 100);
    expect(r2.truncated).toBe(true);
  });
});

describe("wrapCodemodeTool — happy path", () => {
  it("passes results through unchanged when small", async () => {
    const tool = makeTool(async () => ({
      code: "() => 1+1",
      result: 2,
      logs: ["computed"],
    }));
    const wrapped = wrapCodemodeTool(tool);
    const out = await wrapped.execute({ code: "()=>1+1" });
    expect(out).toEqual({ code: "() => 1+1", result: 2, logs: ["computed"] });
  });

  it("returns the tool unmodified if it has no execute", () => {
    // biome-ignore lint/suspicious/noExplicitAny: fixture
    const noExec = { description: "x", inputSchema: { type: "object" } } as any;
    const wrapped = wrapCodemodeTool(noExec);
    expect(wrapped).toBe(noExec);
  });

  it("does not mutate the input tool", async () => {
    const tool = makeTool(async () => ({ code: "", result: 1 }));
    const original = tool.execute;
    wrapCodemodeTool(tool);
    expect(tool.execute).toBe(original);
  });
});

describe("wrapCodemodeTool — truncation", () => {
  it("replaces oversized result with a marker and emits an event", async () => {
    const big = { rows: Array.from({ length: 5000 }, (_, i) => ({ i, name: `row_${i}` })) };
    const tool = makeTool(async () => ({ code: "()=>rows", result: big }));
    const events: CodemodeWrapEvent[] = [];
    const wrapped = wrapCodemodeTool(tool, {
      maxResultChars: 1000,
      onEvent: (e) => events.push(e),
    });
    const out = (await wrapped.execute({ code: "x" })) as {
      code: string;
      result: { _truncated: true; originalChars: number; cap: number };
    };
    expect(out.result._truncated).toBe(true);
    expect(out.result.cap).toBe(1000);
    expect(out.result.originalChars).toBeGreaterThan(1000);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "truncated", cap: 1000 });
  });

  it("uses the default cap when none is specified", async () => {
    const big = { s: "x".repeat(DEFAULT_RESULT_CHAR_CAP + 100) };
    const tool = makeTool(async () => ({ code: "", result: big }));
    const wrapped = wrapCodemodeTool(tool);
    const out = (await wrapped.execute({ code: "x" })) as {
      result: { _truncated: true; cap: number };
    };
    expect(out.result.cap).toBe(DEFAULT_RESULT_CHAR_CAP);
  });

  it("preserves code + logs when truncating", async () => {
    const tool = makeTool(async () => ({
      code: "()=>data",
      result: "x".repeat(2000),
      logs: ["ran query"],
    }));
    const wrapped = wrapCodemodeTool(tool, { maxResultChars: 100 });
    const out = (await wrapped.execute({ code: "x" })) as {
      code: string;
      logs: string[];
      result: unknown;
    };
    expect(out.code).toBe("()=>data");
    expect(out.logs).toEqual(["ran query"]);
    expect((out.result as { _truncated: boolean })._truncated).toBe(true);
  });
});

describe("wrapCodemodeTool — sandbox errors", () => {
  it("turns thrown errors into a structured result", async () => {
    const tool = makeTool(async () => {
      throw new Error("Code execution failed: chart.histogram is not a function");
    });
    const wrapped = wrapCodemodeTool(tool);
    const out = (await wrapped.execute({
      code: "() => chart.histogram({})",
    })) as {
      code: string;
      error: string;
      result: null;
      recoverable: true;
    };
    expect(out.error).toMatch(/chart\.histogram/);
    expect(out.result).toBeNull();
    expect(out.recoverable).toBe(true);
    // Code is preserved so the persisted message is debuggable.
    expect(out.code).toContain("chart.histogram");
  });

  it("emits a sandbox_error event", async () => {
    const tool = makeTool(async () => {
      throw new Error("boom");
    });
    const events: CodemodeWrapEvent[] = [];
    const wrapped = wrapCodemodeTool(tool, { onEvent: (e) => events.push(e) });
    await wrapped.execute({ code: "x" });
    expect(events).toEqual([{ kind: "sandbox_error", message: "boom" }]);
  });

  it("handles non-Error throws (string, plain object, null)", async () => {
    const cases = ["string error", { code: "EBADTHING" }, null, undefined, 42];
    const outs = await Promise.all(
      cases.map((thrown) => {
        const tool = makeTool(async () => {
          throw thrown;
        });
        const wrapped = wrapCodemodeTool(tool);
        return wrapped.execute({ code: "x" });
      })
    );
    for (const out of outs as Array<{ error: string }>) {
      expect(typeof out.error).toBe("string");
      expect(out.error.length).toBeGreaterThan(0);
    }
  });

  it("still continues to work after a previous call threw", async () => {
    let n = 0;
    const tool = makeTool(async () => {
      n++;
      if (n === 1) throw new Error("first time fails");
      return { code: "", result: { ok: true } };
    });
    const wrapped = wrapCodemodeTool(tool);
    const a = (await wrapped.execute({ code: "" })) as { error: string };
    const b = (await wrapped.execute({ code: "" })) as { result: { ok: boolean } };
    expect(a.error).toBe("first time fails");
    expect(b.result.ok).toBe(true);
  });

  it("truncates very long error messages", async () => {
    const long = "boom ".repeat(500); // 2500 chars
    const tool = makeTool(async () => {
      throw new Error(long);
    });
    const wrapped = wrapCodemodeTool(tool);
    const out = (await wrapped.execute({ code: "x" })) as { error: string };
    // describeThrown caps at 800 chars + ellipsis.
    expect(out.error.length).toBeLessThanOrEqual(801);
  });
});

describe("wrapCodemodeTool — observability", () => {
  it("does not crash if onEvent throws", async () => {
    // Belt-and-braces: a buggy logger must never block a turn.
    // Mirrors the "audit failures never block requests" convention.
    const tool = makeTool(async () => ({
      code: "",
      result: "x".repeat(10_000),
    }));
    const onEvent = vi.fn().mockImplementation(() => {
      throw new Error("logger crash");
    });
    const wrapped = wrapCodemodeTool(tool, {
      maxResultChars: 100,
      onEvent,
    });
    const out = (await wrapped.execute({ code: "x" })) as {
      result: { _truncated: true };
    };
    expect(out.result._truncated).toBe(true);
    expect(onEvent).toHaveBeenCalledOnce();
  });

  it("does not crash if onEvent throws on sandbox error path", async () => {
    const tool = makeTool(async () => {
      throw new Error("kaboom");
    });
    const onEvent = vi.fn().mockImplementation(() => {
      throw new Error("logger crash");
    });
    const wrapped = wrapCodemodeTool(tool, { onEvent });
    const out = (await wrapped.execute({ code: "x" })) as { error: string };
    expect(out.error).toBe("kaboom");
    expect(onEvent).toHaveBeenCalledOnce();
  });
});
