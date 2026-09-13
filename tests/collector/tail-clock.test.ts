import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { scanTailCatalog, tailOptions } from "../../src/collector/tail-catalog.js";
import { replayTail } from "../../src/collector/tail-replay.js";
import type { TailBookChange, TailOptions, TailSecond } from "../../src/collector/tail-types.js";
import type { JournalRecord } from "../../src/collector/types.js";
import { book, fixtureRecords, journalRecord, writeFixture } from "./tail-fixture.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function writeRun(records: JournalRecord[]): Promise<string> {
  const root = await writeFixture(records);
  roots.push(root);
  return join(root, "run");
}
function clockRecords(high = 13_620, low = high - 131): JournalRecord[] {
  const records = fixtureRecords();
  const previous = journalRecord(1, high, "clob", "ws_message", "PONG", "clob");
  const current = journalRecord(1, low, "clob", "ws_message", "PONG", "clob-other");
  records.splice(records.findIndex(record => record.receivedAtMs >= high), 0, previous, current);
  records.forEach((record, index) => {
    record.sequence = index + 1;
    record.monotonicNs = String(BigInt(record.receivedAtMs) * 1_000_000n + BigInt(index));
  });
  current.monotonicNs = String(BigInt(previous.monotonicNs) + 16_513_000n);
  records.at(-1)!.kind = "checkpoint_end";
  records.at(-1)!.data = { sealed: true };
  return records;
}
function receipt(record: JournalRecord) {
  const { sequence, receivedAt, receivedAtMs, monotonicNs, source, kind } = record;
  return { sequence, receivedAt, receivedAtMs, monotonicNs, source, kind, connectionId: record.connectionId ?? null };
}
function expectedIssue(records: JournalRecord[]) {
  const index = records.findIndex((record, i) => i > 0 && record.receivedAtMs < records[i - 1]!.receivedAtMs);
  return {
    kind: "receipt-wall-clock-backstep", startAtMs: records[index]!.receivedAtMs, endAtMs: records[index - 1]!.receivedAtMs,
    previous: receipt(records[index - 1]!), current: receipt(records[index]!)
  };
}
async function replay(records: JournalRecord[], extra: Partial<TailOptions> = {}) {
  const runDirectory = await writeRun(records);
  const before = await readFile(join(runDirectory, "1970-01-01-000000.ndjson"), "utf8");
  const seconds: TailSecond[] = [], changes: TailBookChange[] = [], raw: JournalRecord[] = [];
  const summary = await replayTail({ runDirectory, clockPolicy: "flag-backsteps", maxFeedSilenceMs: 600_000,
    sportsStaleAfterMs: 600_000, ...extra }, {
    second: row => { seconds.push(row); }, change: row => { changes.push(row); },
    audit: () => {}, stateChange: () => {}, rawRecord: record => { raw.push(record); }
  });
  expect(await readFile(join(runDirectory, "1970-01-01-000000.ndjson"), "utf8")).toBe(before);
  return { summary, seconds, changes, raw };
}

describe("bounded receipt wall clock backsteps", () => {
  test("strict remains the default and rejects the exact continuous-checkpoint witness", async () => {
    const records = [
      { ...journalRecord(1_622_887, 1_789_318_743_620, "clob", "ws_message", "PONG", "clob-1"), monotonicNs: "36794184855041" },
      { ...journalRecord(1_622_888, 1_789_318_743_489, "clob", "ws_message", "PONG", "clob-2"), monotonicNs: "36794201368041" },
      { ...journalRecord(1_622_889, 1_789_318_744_000, "collector", "checkpoint_end", { sealed: true }), monotonicNs: "36794564855041" }
    ];
    const runDirectory = await writeRun(records);
    await expect(scanTailCatalog(tailOptions({ runDirectory }))).rejects.toThrow("TAIL_CLOCK_ORDER");
    await expect(scanTailCatalog(tailOptions({ runDirectory, clockPolicy: "strict" }))).rejects.toThrow("TAIL_CLOCK_ORDER");
    expect(tailOptions({ runDirectory }).clockPolicy).toBe("strict");
    const catalog = await scanTailCatalog(tailOptions({ runDirectory, clockPolicy: "flag-backsteps" }));
    expect(catalog.clockPolicy).toBe("flag-backsteps");
    expect(catalog.clockIssues).toEqual([expectedIssue(records)]);
  });

  test("a backstep before the window preserves fully qualified later seconds", async () => {
    const records = clockRecords(3620, 3489);
    const { summary, seconds } = await replay(records);
    expect(summary.clockPolicy).toBe("flag-backsteps");
    expect(summary.clockIssues).toEqual([expectedIssue(records)]);
    expect(summary.windows[0]?.clockIssues).toEqual([]);
    expect(summary.tokens.every(token => token.readyForReplay && token.observedWindowComplete && token.clockAffectedSeconds === 0)).toBe(true);
    expect(seconds.every(second => second.wholeSecondValid)).toBe(true);
  });

  test("an interior backstep flags only its second and retains visible observed depth", async () => {
    const records = clockRecords();
    const { summary, seconds } = await replay(records);
    expect(summary.windows[0]?.clockIssues).toEqual([expectedIssue(records)]);
    const affected = seconds.filter(second => second.startAtMs === 13_000);
    expect(affected).toHaveLength(2);
    for (const second of affected) {
      expect(second).toMatchObject({ status: "partial", wholeSecondValid: false, clockIssueSequences: [expectedIssue(records).current.sequence] });
      expect(second.reasons).toContain("receipt-wall-clock-backstep");
      expect(second.bids).not.toBeNull();
    }
    expect(seconds.filter(second => second.startAtMs !== 13_000).every(second => second.wholeSecondValid)).toBe(true);
    for (const token of summary.tokens) {
      expect(token).toMatchObject({ clockAffectedSeconds: 1, validSeconds: 299, partialSeconds: 1,
        snapshotAuditPassed: true, observedWindowComplete: false, readyForReplay: false });
      expect(token.reasons).toContain("receipt-wall-clock-backstep");
    }
  });

  test.each([13_010, 13_000])("pre-scan flags both sides of a second boundary, including an upper endpoint at %i", async high => {
    const { seconds, summary } = await replay(clockRecords(high));
    expect(seconds.filter(second => second.tokenId === "A" && !second.wholeSecondValid).map(second => second.startAtMs)).toEqual([12_000, 13_000]);
    expect(summary.tokens.every(token => token.clockAffectedSeconds === 2 && !token.observedWindowComplete && !token.readyForReplay)).toBe(true);
  });

  test.each([10_010, 310_010])("an interval crossing the window edge at %i still flags the affected second", async high => {
    const records = clockRecords(high);
    const { seconds, summary, raw } = await replay(records);
    const affectedStart = high < 20_000 ? 10_000 : 309_000;
    expect(seconds.filter(second => second.tokenId === "A" && !second.wholeSecondValid).map(second => second.startAtMs)).toEqual([affectedStart]);
    expect(summary.tokens.every(token => token.clockAffectedSeconds === 1 && !token.observedWindowComplete)).toBe(true);
    expect(raw).toEqual(records.filter(record => record.receivedAtMs >= 10_000 && record.receivedAtMs < 310_000));
  });

  test("clock-affected closed seconds cannot complete an otherwise usable window", async () => {
    const records = clockRecords();
    const event = (records[1]!.data as { event: { markets: Record<string, unknown>[] } }).event;
    event.markets.push({ id: "closed", slug: "closed", conditionId: "closed-condition", question: "Closed side market",
      outcomes: ["Over", "Under"], clobTokenIds: ["O", "U"], sportsMarketType: "totals", closed: true });
    const { seconds, summary } = await replay(records);
    expect(seconds.find(second => second.tokenId === "O" && second.startAtMs === 13_000))
      .toMatchObject({ status: "closed", wholeSecondValid: false, bids: null, asks: null, reasons: expect.arrayContaining(["receipt-wall-clock-backstep"]) });
    expect(summary.tokens.find(token => token.tokenId === "O"))
      .toMatchObject({ clockAffectedSeconds: 1, closedSeconds: 299, partialSeconds: 1, observedWindowComplete: false, readyForReplay: false });
  });

  test("raw delivery keeps original sequence, receipt and source timestamps, and complete data", async () => {
    const records = clockRecords(13_010);
    const current = records.find(record => record.receivedAtMs === 12_879)!;
    current.connectionId = "clob";
    current.data = book("A", ".93", ".97", 12_878, "original-hash");
    const { raw, changes, seconds } = await replay(records);
    expect(raw).toEqual(records.filter(record => record.receivedAtMs >= 10_000 && record.receivedAtMs < 310_000));
    expect(changes.find(change => change.sequence === current.sequence)).toMatchObject({ observedAtMs: 12_879, sourceAtMs: 12_878,
      data: JSON.parse(current.data as string) });
    expect(seconds.find(second => second.tokenId === "A" && second.startAtMs === 13_000))
      .toMatchObject({ bookObservedAtMs: 12_879, bookSourceAtMs: 12_878, bookHash: "original-hash", bestBid: "0.93", wholeSecondValid: false });
  });

  test("monotonic regression remains fatal before any sink output", async () => {
    const records = clockRecords();
    const current = records.find(record => record.receivedAtMs === 13_489)!;
    current.monotonicNs = "0";
    const runDirectory = await writeRun(records);
    let delivered = 0;
    const output = () => { delivered++; };
    await expect(replayTail({ runDirectory, clockPolicy: "flag-backsteps" }, {
      second: output, change: output, audit: output, stateChange: output, rawRecord: output
    })).rejects.toThrow("TAIL_CLOCK_ORDER");
    expect(delivered).toBe(0);
  });

  test("absolute wall versus monotonic drift remains fatal with the opt-in policy", async () => {
    const records = clockRecords();
    const last = records.at(-1)!;
    last.receivedAtMs += 6000;
    last.receivedAt = new Date(last.receivedAtMs).toISOString();
    const runDirectory = await writeRun(records);
    await expect(scanTailCatalog(tailOptions({ runDirectory, clockPolicy: "flag-backsteps" }))).rejects.toThrow("TAIL_CLOCK_DISCONTINUITY");
  });

  test("an individual backstep exceeding the drift limit is fatal even within the absolute drift envelope", async () => {
    const records = [
      { ...journalRecord(1, 0, "collector", "session_start", {}), monotonicNs: "0" },
      { ...journalRecord(2, 14_000, "clob", "ws_message", "PONG", "clob"), monotonicNs: "10000000000" },
      { ...journalRecord(3, 8000, "collector", "checkpoint_end", { sealed: true }), monotonicNs: "10016513000" }
    ];
    const runDirectory = await writeRun(records);
    await expect(scanTailCatalog(tailOptions({ runDirectory, clockPolicy: "flag-backsteps" }))).rejects.toThrow("TAIL_CLOCK_DISCONTINUITY");
  });

  test("the configured drift limit also bounds accepted backsteps", async () => {
    const runDirectory = await writeRun(clockRecords());
    await expect(scanTailCatalog(tailOptions({ runDirectory, clockPolicy: "flag-backsteps", maxClockDriftMs: 100 })))
      .rejects.toThrow("TAIL_CLOCK_DISCONTINUITY");
  });

  test("sequence regressions and duplicates remain fatal", async () => {
    for (const sequence of [13, 14]) {
      const records = clockRecords();
      records[14]!.sequence = sequence;
      const runDirectory = await writeRun(records);
      await expect(scanTailCatalog(tailOptions({ runDirectory, clockPolicy: "flag-backsteps" }))).rejects.toThrow("TAIL_SEQUENCE_ORDER");
    }
  });

  test("invalid API clock policies fail explicitly", () => {
    expect(() => tailOptions({ runDirectory: "unused", clockPolicy: "ignore" as NonNullable<TailOptions["clockPolicy"]> })).toThrow("TAIL_OPTIONS_INVALID: clockPolicy");
  });

  test("overlapping backsteps retain every original witness without double-counting seconds", async () => {
    const records = clockRecords();
    const index = records.findIndex(record => record.receivedAtMs === 13_489);
    const previous = records[index]!;
    records.splice(index + 1, 0,
      { ...journalRecord(1, 13_600, "clob", "ws_message", "PONG", "clob"), monotonicNs: String(BigInt(previous.monotonicNs) + 1n) },
      { ...journalRecord(1, 13_480, "clob", "ws_message", "PONG", "clob-other"), monotonicNs: String(BigInt(previous.monotonicNs) + 2n) }
    );
    records.forEach((record, i) => { record.sequence = i + 1; });
    const { summary, seconds } = await replay(records);
    expect(summary.clockIssues).toHaveLength(2);
    expect(summary.clockIssues?.[1]).toEqual({ kind: "receipt-wall-clock-backstep", startAtMs: 13_480, endAtMs: 13_600,
      previous: receipt(records[index + 1]!), current: receipt(records[index + 2]!) });
    expect(seconds.find(second => second.tokenId === "A" && second.startAtMs === 13_000)?.clockIssueSequences)
      .toEqual([previous.sequence, records[index + 2]!.sequence]);
    expect(summary.tokens.every(token => token.clockAffectedSeconds === 1)).toBe(true);
  });

  test("retains 1024 original issues and fails explicitly on the next instead of discarding evidence", async () => {
    for (const count of [1024, 1025]) {
      const records = [journalRecord(1, 0, "collector", "session_start", {})];
      for (let index = 0; index < count; index++) {
        const high = (index + 1) * 1000;
        const previous = journalRecord(records.length + 1, high, "clob", "ws_message", "PONG", "clob-1");
        records.push(previous, { ...journalRecord(records.length + 2, high - 1, "clob", "ws_message", "PONG", "clob-2"),
          monotonicNs: String(BigInt(previous.monotonicNs) + 1n) });
      }
      records.push(journalRecord(records.length + 1, (count + 1) * 1000, "collector", "checkpoint_end", { sealed: true }));
      const runDirectory = await writeRun(records);
      const scan = scanTailCatalog(tailOptions({ runDirectory, clockPolicy: "flag-backsteps" }));
      if (count > 1024) await expect(scan).rejects.toThrow("TAIL_CLOCK_ISSUE_LIMIT_EXCEEDED");
      else {
        const catalog = await scan;
        expect(catalog.clockIssues).toHaveLength(count);
        expect(catalog.clockIssues[0]).toEqual(expectedIssue(records));
        expect(catalog.clockIssues.at(-1)?.current).toEqual(receipt(records.at(-2)!));
      }
    }
  });
});
