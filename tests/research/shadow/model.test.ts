import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  evaluateLateScoreSignal,
  lateScoreFeatures,
  parseLateScoreModel,
  predictHomeProbability,
  walkBook
} from "../../../src/research/shadow/model.js";
import type { LateScoreModel } from "../../../src/research/shadow/model.js";
import type { OrderbookSnapshot } from "../../../src/domain/types.js";

const fixture = JSON.parse(readFileSync(resolve("tests/fixtures/shadow/late-score-model.json"), "utf8")) as unknown;
const synthetic: LateScoreModel = parseLateScoreModel(fixture);

function modelWith(probability: number): LateScoreModel {
  const intercept = Math.log(probability / (1 - probability));
  return parseLateScoreModel({
    ...(fixture as Record<string, unknown>),
    coefficients: [intercept, 0, 0, 0, 0, 0],
    mean: [0, 0, 0, 0, 0],
    scale: [1, 1, 1, 1, 1],
    selfTest: []
  });
}

function book(tokenId: string, asks: Array<[number, number]>, bids: Array<[number, number]> = [[0.5, 100]]): OrderbookSnapshot {
  return { tokenId, asks: asks.map(([price, size]) => ({ price, size })), bids: bids.map(([price, size]) => ({ price, size })) };
}

const signalOptions = { windowSeconds: 180, minProbability: 0.9, minEdge: 0.03, limitOffset: 0.01, maxPrice: 0.99, shares: 5 };

describe("late score model", () => {
  test("reproduces the Python feature transform and probabilities", () => {
    for (const check of synthetic.selfTest) {
      const features = lateScoreFeatures(
        { period: check.period, clockSeconds: check.clock === "15:00" ? 900 : check.clock === "12:00" ? 720 : check.clock === "3:00" ? 180 : check.clock === "0:45" ? 45 : check.clock === "0:05" ? 5 : 240, homeScore: check.homeScore, awayScore: check.awayScore },
        synthetic
      );
      expect(features).not.toBeNull();
      expect(features!).toHaveLength(5);
      check.features.forEach((expected, index) => expect(features![index]!).toBeCloseTo(expected, 9));
      expect(predictHomeProbability(synthetic, features!)).toBeCloseTo(check.probability, 10);
    }
  });

  test("refuses a model whose embedded self-test disagrees", () => {
    const tampered = JSON.parse(JSON.stringify(fixture)) as { selfTest: Array<{ probability: number }> };
    tampered.selfTest[0]!.probability += 0.01;
    expect(() => parseLateScoreModel(tampered)).toThrow(/SHADOW_MODEL_SELFTEST_FAILED/);
  });

  test("rejects malformed artifacts", () => {
    expect(() => parseLateScoreModel({ ...(fixture as object), featureSpec: ["wrong"] })).toThrow(/SHADOW_MODEL_INVALID/);
    expect(() => parseLateScoreModel({ ...(fixture as object), coefficients: [1, 2] })).toThrow(/SHADOW_MODEL_INVALID/);
    expect(() => parseLateScoreModel(null)).toThrow(/SHADOW_MODEL_INVALID/);
  });

  test("returns null outside the final twelve minutes or without a usable clock", () => {
    expect(lateScoreFeatures({ period: 4, clockSeconds: 901, homeScore: 24, awayScore: 20 }, synthetic)).toBeNull();
    expect(lateScoreFeatures({ period: 3, clockSeconds: 300, homeScore: 24, awayScore: 20 }, synthetic)).toBeNull();
    expect(lateScoreFeatures({ period: 0, clockSeconds: 60, homeScore: 0, awayScore: 0 }, synthetic)).toBeNull();
  });

  test("treats overtime as the research script does", () => {
    const features = lateScoreFeatures({ period: 5, clockSeconds: 240, homeScore: 20, awayScore: 20 }, synthetic);
    expect(features).toEqual([0, 0, 0, 1 / Math.sqrt(241 / 60), 1]);
  });
});

describe("walkBook", () => {
  test("walks ask levels up to the limit and reports the worst price", () => {
    const fill = walkBook(book("A", [[0.88, 3], [0.9, 5], [0.95, 100]]), 0.92, 6);
    expect(fill.filledShares).toBe(6);
    expect(fill.cost).toBeCloseTo(3 * 0.88 + 3 * 0.9, 9);
    expect(fill.averagePrice).toBeCloseTo(0.89, 9);
    expect(fill.worstPrice).toBe(0.9);
    expect(fill.complete).toBe(true);
  });

  test("reports a partial fill when displayed size is short", () => {
    const fill = walkBook(book("A", [[0.9, 2]]), 0.92, 5);
    expect(fill.filledShares).toBe(2);
    expect(fill.complete).toBe(false);
    expect(fill.worstPrice).toBe(0.9);
  });

  test("fills nothing when no ask is at or below the limit", () => {
    const fill = walkBook(book("A", [[0.95, 100]]), 0.92, 5);
    expect(fill.filledShares).toBe(0);
    expect(fill.cost).toBe(0);
    expect(fill.averagePrice).toBeNull();
    expect(fill.worstPrice).toBeNull();
    expect(fill.complete).toBe(false);
  });
});

describe("evaluateLateScoreSignal", () => {
  const state = { period: 4, clockSeconds: 60, homeScore: 27, awayScore: 20 };
  const market = { homeTokenId: "HOME", awayTokenId: "AWAY" };

  function evaluate(probability: number, homeBook: OrderbookSnapshot, awayBook = book("AWAY", [[0.9, 100]])) {
    return evaluateLateScoreSignal({
      state, model: modelWith(probability), market,
      books: { home: homeBook, away: awayBook }, options: signalOptions
    });
  }

  test("fires when the favourite is late, cheap and deep enough to fill", () => {
    const result = evaluate(0.93, book("HOME", [[0.88, 10]]));
    expect(result.fire).toBe(true);
    expect(result.reason).toBe("fire");
    expect(result.side).toBe("home");
    expect(result.pHome).toBeCloseTo(0.93, 9);
    expect(result.sides.home.ask).toBe(0.88);
    expect(result.sides.home.edge).toBeCloseTo(0.05, 9);
    expect(result.sides.home.limit).toBeCloseTo(0.92, 9);
    expect(result.sides.home.fill.filledShares).toBe(5);
    expect(result.sides.home.fill.averagePrice).toBeCloseTo(0.88, 9);
    expect(result.remainingSeconds).toBe(60);
  });

  test("does not fire outside the final three minutes", () => {
    const result = evaluateLateScoreSignal({
      state: { ...state, clockSeconds: 200 }, model: modelWith(0.93), market,
      books: { home: book("HOME", [[0.8, 10]]), away: book("AWAY", [[0.9, 100]]) }, options: signalOptions
    });
    expect(result.fire).toBe(false);
    expect(result.reason).toBe("outside-window");
    expect(result.remainingSeconds).toBe(200);
  });

  test("reports probability, edge, price and missing-ask reasons", () => {
    expect(evaluate(0.85, book("HOME", [[0.8, 10]])).reason).toBe("probability-below-minimum");
    expect(evaluate(0.93, book("HOME", [[0.91, 10]])).reason).toBe("edge-too-small");
    expect(evaluate(0.93, book("HOME", [[0.925, 100]])).reason).toBe("ask-above-limit");
    expect(evaluate(0.93, book("HOME", [])).reason).toBe("no-ask");
  });

  test("fails closed when the state cannot produce features", () => {
    const result = evaluateLateScoreSignal({
      state: { ...state, period: 0 }, model: modelWith(0.93), market,
      books: { home: book("HOME", [[0.8, 10]]), away: book("AWAY", [[0.9, 100]]) }, options: signalOptions
    });
    expect(result.fire).toBe(false);
    expect(result.reason).toBe("state-unusable");
  });

  test("evaluates overtime on the overtime clock", () => {
    const result = evaluateLateScoreSignal({
      state: { period: 5, clockSeconds: 90, homeScore: 20, awayScore: 20 }, model: modelWith(0.93), market,
      books: { home: book("HOME", [[0.88, 10]]), away: book("AWAY", [[0.9, 100]]) }, options: signalOptions
    });
    expect(result.remainingSeconds).toBe(90);
    expect(result.fire).toBe(true);
  });
});
