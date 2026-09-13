import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { JournalReplay, readJournalRecords, replayRecords, type ReplayInvalidation, type ReplayJournalRecord } from "../../src/collector/replay.js";
import { createJournal } from "../../src/collector/journal.js";

function rec(sequence: number, source: ReplayJournalRecord["source"], kind: string, data: unknown, connectionId?: string): ReplayJournalRecord {
  return {
    schemaVersion: 1, runId: "audit", sequence, receivedAt: new Date(sequence * 1000).toISOString(),
    receivedAtMs: sequence * 1000, monotonicNs: String(BigInt(sequence) * 1_000_000_000n),
    source, kind, data, ...(connectionId ? { connectionId } : {})
  };
}
const ws = (sequence: number, data: unknown, connectionId = "clob-0-e1") => rec(sequence, "clob", "ws_message", typeof data === "string" ? data : JSON.stringify(data), connectionId);
const book = (price = "0.70", size = "4", timestamp = "1000") => ({ event_type: "book", asset_id: "t", timestamp, bids: [], asks: [{ price, size }] });
const change = (price: string, size: string, timestamp = "2000") => ({ event_type: "price_change", timestamp, price_changes: [{ asset_id: "t", side: "SELL", price, size }] });
const metadata = () => rec(1, "gamma", "event_metadata", { normalized: {
  eventId: "a", eventSlug: "game-a", gameId: "10",
  markets: [{ marketId: "m", conditionId: "c", tokenIds: ["t"], outcomes: ["Yes"] }]
} });
const twoSidedBook = () => ({ ...book(), bids: [{ price: "0.40", size: "5" }] });

interface CapturedBatch {
  name: string;
  root: number;
  checkpoint: ReplayJournalRecord;
  records: ReplayJournalRecord[];
}
// Pinned from tail5m-validation-20260912/2026-09-11-000000.ndjson.
// Checkpoints contain ALL depth reconstructed immediately before these raw sequences;
// they are replay checkpoints, not fabricated upstream snapshots. Raw records are unchanged.
// Tests rebase only journal sequence numbers to make each excerpt independently replayable.
const capturedBatches: CapturedBatch[] = [
  {
    name: "ask cancellation",
    root: 2267,
    checkpoint: {
      "schemaVersion": 1,
      "runId": "tail5m-validation-20260912",
      "sequence": 2264,
      "receivedAt": "2026-09-11T19:53:33.931Z",
      "receivedAtMs": 1789156413931,
      "monotonicNs": "366100654866041",
      "source": "clob",
      "kind": "ws_message",
      "connectionId": "clob-0-e1",
      data: [
        {
          "event_type": "book",
          "asset_id": "89103662922399853582210727094555628545682161257465140653230183411405552444242",
          "timestamp": "1789156413823",
          "hash": "ca73d90ed6e41849c6f79bb5cec80e42eeb6b8e7",
          "bids": [
            {"price":"0.63","size":"10.7"}, {"price":"0.627","size":"59.76"}, {"price":"0.626","size":"59.76"}, {"price":"0.625","size":"10.7"},
            {"price":"0.624","size":"10.7"}, {"price":"0.623","size":"10"}, {"price":"0.62","size":"95.28"}, {"price":"0.61","size":"1940.56"},
            {"price":"0.601","size":"25"}, {"price":"0.6","size":"190.56"}, {"price":"0.598","size":"50"}, {"price":"0.592","size":"150"},
            {"price":"0.58","size":"62"}, {"price":"0.56","size":"2000"}, {"price":"0.552","size":"11622.99"}, {"price":"0.551","size":"11623"},
            {"price":"0.54","size":"6562.28"}, {"price":"0.531","size":"40"}, {"price":"0.53","size":"390.56"}, {"price":"0.521","size":"5061"},
            {"price":"0.52","size":"2190.56"}, {"price":"0.51","size":"22.5"}, {"price":"0.46","size":"27"}, {"price":"0.45","size":"300"},
            {"price":"0.44","size":"5053.71"}, {"price":"0.43","size":"52"}, {"price":"0.41","size":"5"}, {"price":"0.36","size":"32"},
            {"price":"0.34","size":"22"}, {"price":"0.331","size":"5149.06"}, {"price":"0.33","size":"222"}, {"price":"0.29","size":"1551.71"},
            {"price":"0.27","size":"925.92"}, {"price":"0.262","size":"5369.6"}, {"price":"0.26","size":"2999.98"}, {"price":"0.252","size":"32.74"},
            {"price":"0.25","size":"1200"}, {"price":"0.234","size":"10116"}, {"price":"0.233","size":"13547.58"}, {"price":"0.22","size":"2636.35"},
            {"price":"0.2","size":"22140"}, {"price":"0.18","size":"1498.88"}, {"price":"0.17","size":"4705.86"}, {"price":"0.15","size":"11466.66"},
            {"price":"0.133","size":"25286.96"}, {"price":"0.131","size":"55"}, {"price":"0.13","size":"155"}, {"price":"0.12","size":"2500"},
            {"price":"0.11","size":"17272.7"}, {"price":"0.09","size":"2222.22"}, {"price":"0.081","size":"50980"}, {"price":"0.08","size":"90105"},
            {"price":"0.05","size":"16400"}, {"price":"0.03","size":"43998.33"}, {"price":"0.02","size":"261000"}, {"price":"0.01","size":"126680"},
            {"price":"0.001","size":"5199.99"},
          ],
          "asks": [
            {"price":"0.637","size":"10"}, {"price":"0.638","size":"49.06"}, {"price":"0.639","size":"49.06"}, {"price":"0.64","size":"104.72"},
            {"price":"0.644","size":"17"}, {"price":"0.65","size":"209.44"}, {"price":"0.659","size":"25"}, {"price":"0.66","size":"239.44"},
            {"price":"0.663","size":"11623"}, {"price":"0.664","size":"11622.99"}, {"price":"0.67","size":"30"}, {"price":"0.68","size":"2000"},
            {"price":"0.687","size":"143.04"}, {"price":"0.689","size":"3550"}, {"price":"0.69","size":"32"}, {"price":"0.7","size":"30"},
            {"price":"0.71","size":"35"}, {"price":"0.72","size":"2000"}, {"price":"0.759","size":"49"}, {"price":"0.76","size":"1000"},
            {"price":"0.77","size":"104.72"}, {"price":"0.78","size":"209.44"}, {"price":"0.79","size":"209.44"}, {"price":"0.809","size":"5061"},
            {"price":"0.81","size":"2453.15"}, {"price":"0.83","size":"104.72"}, {"price":"0.839","size":"47"}, {"price":"0.84","size":"2093.44"},
            {"price":"0.85","size":"209.44"}, {"price":"0.86","size":"27.5"}, {"price":"0.87","size":"56"}, {"price":"0.878","size":"10116"},
            {"price":"0.879","size":"18845.23"}, {"price":"0.9","size":"6500"}, {"price":"0.92","size":"16250"}, {"price":"0.95","size":"12005"},
            {"price":"0.96","size":"52500"}, {"price":"0.979","size":"50980"}, {"price":"0.98","size":"186180"}, {"price":"0.99","size":"127667.66"},
            {"price":"0.995","size":"25"}, {"price":"0.999","size":"16398.67"},
          ],
        },
        {
          "event_type": "book",
          "asset_id": "81991637217769173167120472548201162753479510171986166836308777400146642216229",
          "timestamp": "1789156413823",
          "hash": "8d3749f1963cf84ff3828beec608757d9f9d1158",
          "bids": [
            {"price":"0.363","size":"10"}, {"price":"0.362","size":"49.06"}, {"price":"0.361","size":"49.06"}, {"price":"0.36","size":"104.72"},
            {"price":"0.356","size":"17"}, {"price":"0.35","size":"209.44"}, {"price":"0.341","size":"25"}, {"price":"0.34","size":"239.44"},
            {"price":"0.337","size":"11623"}, {"price":"0.336","size":"11622.99"}, {"price":"0.33","size":"30"}, {"price":"0.32","size":"2000"},
            {"price":"0.313","size":"143.04"}, {"price":"0.311","size":"3550"}, {"price":"0.31","size":"32"}, {"price":"0.3","size":"30"},
            {"price":"0.29","size":"35"}, {"price":"0.28","size":"2000"}, {"price":"0.241","size":"49"}, {"price":"0.24","size":"1000"},
            {"price":"0.23","size":"104.72"}, {"price":"0.22","size":"209.44"}, {"price":"0.21","size":"209.44"}, {"price":"0.191","size":"5061"},
            {"price":"0.19","size":"2453.15"}, {"price":"0.17","size":"104.72"}, {"price":"0.161","size":"47"}, {"price":"0.16","size":"2093.44"},
            {"price":"0.15","size":"209.44"}, {"price":"0.14","size":"27.5"}, {"price":"0.13","size":"56"}, {"price":"0.122","size":"10116"},
            {"price":"0.121","size":"18845.23"}, {"price":"0.1","size":"6500"}, {"price":"0.08","size":"16250"}, {"price":"0.05","size":"12005"},
            {"price":"0.04","size":"52500"}, {"price":"0.021","size":"50980"}, {"price":"0.02","size":"186180"}, {"price":"0.01","size":"127667.66"},
            {"price":"0.005","size":"25"}, {"price":"0.001","size":"16398.67"},
          ],
          "asks": [
            {"price":"0.37","size":"10.7"}, {"price":"0.373","size":"59.76"}, {"price":"0.374","size":"59.76"}, {"price":"0.375","size":"10.7"},
            {"price":"0.376","size":"10.7"}, {"price":"0.377","size":"10"}, {"price":"0.38","size":"95.28"}, {"price":"0.39","size":"1940.56"},
            {"price":"0.399","size":"25"}, {"price":"0.4","size":"190.56"}, {"price":"0.402","size":"50"}, {"price":"0.408","size":"150"},
            {"price":"0.42","size":"62"}, {"price":"0.44","size":"2000"}, {"price":"0.448","size":"11622.99"}, {"price":"0.449","size":"11623"},
            {"price":"0.46","size":"6562.28"}, {"price":"0.469","size":"40"}, {"price":"0.47","size":"390.56"}, {"price":"0.479","size":"5061"},
            {"price":"0.48","size":"2190.56"}, {"price":"0.49","size":"22.5"}, {"price":"0.54","size":"27"}, {"price":"0.55","size":"300"},
            {"price":"0.56","size":"5053.71"}, {"price":"0.57","size":"52"}, {"price":"0.59","size":"5"}, {"price":"0.64","size":"32"},
            {"price":"0.66","size":"22"}, {"price":"0.669","size":"5149.06"}, {"price":"0.67","size":"222"}, {"price":"0.71","size":"1551.71"},
            {"price":"0.73","size":"925.92"}, {"price":"0.738","size":"5369.6"}, {"price":"0.74","size":"2999.98"}, {"price":"0.748","size":"32.74"},
            {"price":"0.75","size":"1200"}, {"price":"0.766","size":"10116"}, {"price":"0.767","size":"13547.58"}, {"price":"0.78","size":"2636.35"},
            {"price":"0.8","size":"22140"}, {"price":"0.82","size":"1498.88"}, {"price":"0.83","size":"4705.86"}, {"price":"0.85","size":"11466.66"},
            {"price":"0.867","size":"25286.96"}, {"price":"0.869","size":"55"}, {"price":"0.87","size":"155"}, {"price":"0.88","size":"2500"},
            {"price":"0.89","size":"17272.7"}, {"price":"0.91","size":"2222.22"}, {"price":"0.919","size":"50980"}, {"price":"0.92","size":"90105"},
            {"price":"0.95","size":"16400"}, {"price":"0.97","size":"43998.33"}, {"price":"0.98","size":"261000"}, {"price":"0.99","size":"126680"},
            {"price":"0.999","size":"5199.99"},
          ],
        },
      ],
    },
    records: [
      {"schemaVersion":1,"runId":"tail5m-validation-20260912","sequence":2265,"receivedAt":"2026-09-11T19:53:33.937Z","receivedAtMs":1789156413937,"monotonicNs":"366100660672875","source":"clob","kind":"ws_message","data":"{\"market\":\"0x86964402baab9700a765594e0856dcfce5120b44e0016d98e01801f0856f9118\", \"asset_id\":\"89103662922399853582210727094555628545682161257465140653230183411405552444242\", \"best_bid\":\"0.63\", \"best_ask\":\"0.638\", \"spread\":\"0.008\", \"timestamp\":\"1789156413830\", \"event_type\":\"best_bid_ask\"}","connectionId":"clob-0-e1"},
      {"schemaVersion":1,"runId":"tail5m-validation-20260912","sequence":2266,"receivedAt":"2026-09-11T19:53:33.937Z","receivedAtMs":1789156413937,"monotonicNs":"366100660726583","source":"clob","kind":"ws_message","data":"{\"market\":\"0x86964402baab9700a765594e0856dcfce5120b44e0016d98e01801f0856f9118\", \"asset_id\":\"81991637217769173167120472548201162753479510171986166836308777400146642216229\", \"best_bid\":\"0.362\", \"best_ask\":\"0.37\", \"spread\":\"0.008\", \"timestamp\":\"1789156413830\", \"event_type\":\"best_bid_ask\"}","connectionId":"clob-0-e1"},
      {"schemaVersion":1,"runId":"tail5m-validation-20260912","sequence":2267,"receivedAt":"2026-09-11T19:53:33.937Z","receivedAtMs":1789156413937,"monotonicNs":"366100660855250","source":"clob","kind":"ws_message","data":"{\"market\":\"0x86964402baab9700a765594e0856dcfce5120b44e0016d98e01801f0856f9118\", \"price_changes\":[{\"asset_id\":\"89103662922399853582210727094555628545682161257465140653230183411405552444242\", \"price\":\"0.644\", \"size\":\"0\", \"side\":\"SELL\", \"hash\":\"caab9fea204d5ce8d2eca8410ae7d71f107bab10\", \"best_bid\":\"0.63\", \"best_ask\":\"0.638\"}, {\"asset_id\":\"81991637217769173167120472548201162753479510171986166836308777400146642216229\", \"price\":\"0.356\", \"size\":\"0\", \"side\":\"BUY\", \"hash\":\"940e801a077ef393c9f9ec6dbdb86a1be3cc5a0b\", \"best_bid\":\"0.362\", \"best_ask\":\"0.37\"}], \"timestamp\":\"1789156413830\", \"event_type\":\"price_change\"}","connectionId":"clob-0-e1"},
      {"schemaVersion":1,"runId":"tail5m-validation-20260912","sequence":2268,"receivedAt":"2026-09-11T19:53:33.937Z","receivedAtMs":1789156413937,"monotonicNs":"366100660889666","source":"clob","kind":"ws_message","data":"{\"market\":\"0x86964402baab9700a765594e0856dcfce5120b44e0016d98e01801f0856f9118\", \"price_changes\":[{\"asset_id\":\"89103662922399853582210727094555628545682161257465140653230183411405552444242\", \"price\":\"0.637\", \"size\":\"0\", \"side\":\"SELL\", \"hash\":\"caab9fea204d5ce8d2eca8410ae7d71f107bab10\", \"best_bid\":\"0.63\", \"best_ask\":\"0.638\"}, {\"asset_id\":\"81991637217769173167120472548201162753479510171986166836308777400146642216229\", \"price\":\"0.363\", \"size\":\"0\", \"side\":\"BUY\", \"hash\":\"940e801a077ef393c9f9ec6dbdb86a1be3cc5a0b\", \"best_bid\":\"0.362\", \"best_ask\":\"0.37\"}], \"timestamp\":\"1789156413830\", \"event_type\":\"price_change\"}","connectionId":"clob-0-e1"},
      {"schemaVersion":1,"runId":"tail5m-validation-20260912","sequence":2269,"receivedAt":"2026-09-11T19:53:33.937Z","receivedAtMs":1789156413937,"monotonicNs":"366100660908375","source":"clob","kind":"ws_message","data":"{\"market\":\"0x86964402baab9700a765594e0856dcfce5120b44e0016d98e01801f0856f9118\", \"price_changes\":[{\"asset_id\":\"81991637217769173167120472548201162753479510171986166836308777400146642216229\", \"price\":\"0.341\", \"size\":\"0\", \"side\":\"BUY\", \"hash\":\"940e801a077ef393c9f9ec6dbdb86a1be3cc5a0b\", \"best_bid\":\"0.362\", \"best_ask\":\"0.37\"}, {\"asset_id\":\"89103662922399853582210727094555628545682161257465140653230183411405552444242\", \"price\":\"0.659\", \"size\":\"0\", \"side\":\"SELL\", \"hash\":\"caab9fea204d5ce8d2eca8410ae7d71f107bab10\", \"best_bid\":\"0.63\", \"best_ask\":\"0.638\"}], \"timestamp\":\"1789156413830\", \"event_type\":\"price_change\"}","connectionId":"clob-0-e1"},
      {"schemaVersion":1,"runId":"tail5m-validation-20260912","sequence":2270,"receivedAt":"2026-09-11T19:53:33.937Z","receivedAtMs":1789156413937,"monotonicNs":"366100660924583","source":"clob","kind":"ws_message","data":"{\"market\":\"0x86964402baab9700a765594e0856dcfce5120b44e0016d98e01801f0856f9118\", \"price_changes\":[{\"asset_id\":\"89103662922399853582210727094555628545682161257465140653230183411405552444242\", \"price\":\"0.659\", \"size\":\"0\", \"side\":\"SELL\", \"hash\":\"caab9fea204d5ce8d2eca8410ae7d71f107bab10\", \"best_bid\":\"0.63\", \"best_ask\":\"0.638\"}, {\"asset_id\":\"81991637217769173167120472548201162753479510171986166836308777400146642216229\", \"price\":\"0.341\", \"size\":\"0\", \"side\":\"BUY\", \"hash\":\"940e801a077ef393c9f9ec6dbdb86a1be3cc5a0b\", \"best_bid\":\"0.362\", \"best_ask\":\"0.37\"}], \"timestamp\":\"1789156413830\", \"event_type\":\"price_change\"}","connectionId":"clob-0-e1"},
      {"schemaVersion":1,"runId":"tail5m-validation-20260912","sequence":2271,"receivedAt":"2026-09-11T19:53:33.943Z","receivedAtMs":1789156413943,"monotonicNs":"366100667305166","source":"clob","kind":"ws_message","data":"{\"market\":\"0x86964402baab9700a765594e0856dcfce5120b44e0016d98e01801f0856f9118\", \"price_changes\":[{\"asset_id\":\"81991637217769173167120472548201162753479510171986166836308777400146642216229\", \"price\":\"0.34\", \"size\":\"209.44\", \"side\":\"BUY\", \"hash\":\"3543e596e259b83256f6f5c9fddef5a61b5a5139\", \"best_bid\":\"0.362\", \"best_ask\":\"0.37\"}, {\"asset_id\":\"89103662922399853582210727094555628545682161257465140653230183411405552444242\", \"price\":\"0.66\", \"size\":\"209.44\", \"side\":\"SELL\", \"hash\":\"a82ac4a37356fe081674f721a7aa348c3b2a17a7\", \"best_bid\":\"0.63\", \"best_ask\":\"0.638\"}], \"timestamp\":\"1789156413836\", \"event_type\":\"price_change\"}","connectionId":"clob-0-e1"},
    ],
  },
  {
    name: "bid cancellation",
    root: 6223,
    checkpoint: {
      "schemaVersion": 1,
      "runId": "tail5m-validation-20260912",
      "sequence": 6220,
      "receivedAt": "2026-09-11T19:54:13.413Z",
      "receivedAtMs": 1789156453413,
      "monotonicNs": "366140136510750",
      "source": "clob",
      "kind": "ws_message",
      "connectionId": "clob-0-e1",
      data: [
        {
          "event_type": "book",
          "asset_id": "89103662922399853582210727094555628545682161257465140653230183411405552444242",
          "timestamp": "1789156453209",
          "hash": "9aaf8ffe77792496ab446ea614da76b514ae6b83",
          "bids": [
            {"price":"0.554","size":"10.7"}, {"price":"0.553","size":"10.7"}, {"price":"0.552","size":"10.7"}, {"price":"0.551","size":"10.7"},
            {"price":"0.546","size":"30.7"}, {"price":"0.544","size":"90"}, {"price":"0.543","size":"4938"}, {"price":"0.542","size":"341.09"},
            {"price":"0.541","size":"5061"}, {"price":"0.54","size":"142.28"}, {"price":"0.531","size":"25"}, {"price":"0.53","size":"220.56"},
            {"price":"0.527","size":"50"}, {"price":"0.522","size":"1000"}, {"price":"0.521","size":"300"}, {"price":"0.52","size":"190.56"},
            {"price":"0.51","size":"52.5"}, {"price":"0.5","size":"32"}, {"price":"0.498","size":"10116"}, {"price":"0.497","size":"11623"},
            {"price":"0.496","size":"11622.99"}, {"price":"0.49","size":"95.28"}, {"price":"0.48","size":"2190.56"}, {"price":"0.47","size":"190.56"},
            {"price":"0.441","size":"40"}, {"price":"0.44","size":"2330"}, {"price":"0.43","size":"5"}, {"price":"0.42","size":"19"},
            {"price":"0.41","size":"5"}, {"price":"0.4","size":"1880"}, {"price":"0.36","size":"32"}, {"price":"0.332","size":"47"},
            {"price":"0.33","size":"672"}, {"price":"0.28","size":"25"}, {"price":"0.27","size":"925.92"}, {"price":"0.262","size":"5369.6"},
            {"price":"0.26","size":"2999.98"}, {"price":"0.252","size":"32.74"}, {"price":"0.25","size":"1200"}, {"price":"0.233","size":"13547.58"},
            {"price":"0.22","size":"2636.35"}, {"price":"0.2","size":"20390"}, {"price":"0.18","size":"1498.88"}, {"price":"0.17","size":"4705.86"},
            {"price":"0.15","size":"11466.66"}, {"price":"0.133","size":"21903.51"}, {"price":"0.13","size":"155"}, {"price":"0.12","size":"2500"},
            {"price":"0.11","size":"17272.7"}, {"price":"0.09","size":"2222.22"}, {"price":"0.081","size":"50980"}, {"price":"0.08","size":"73855"},
            {"price":"0.051","size":"55"}, {"price":"0.05","size":"16400"}, {"price":"0.03","size":"43998.33"}, {"price":"0.02","size":"261000"},
            {"price":"0.01","size":"126680"}, {"price":"0.001","size":"5199.99"},
          ],
          "asks": [
            {"price":"0.559","size":"4892.52"}, {"price":"0.56","size":"170.72"}, {"price":"0.565","size":"17"}, {"price":"0.569","size":"4938"},
            {"price":"0.57","size":"209.44"}, {"price":"0.575","size":"176.9"}, {"price":"0.576","size":"16684"}, {"price":"0.577","size":"11622.99"},
            {"price":"0.58","size":"209.44"}, {"price":"0.588","size":"150"}, {"price":"0.592","size":"50"}, {"price":"0.6","size":"2030"},
            {"price":"0.63","size":"32"}, {"price":"0.632","size":"10"}, {"price":"0.638","size":"3550"}, {"price":"0.639","size":"61096"},
            {"price":"0.64","size":"2030"}, {"price":"0.645","size":"11622.99"}, {"price":"0.646","size":"11623"}, {"price":"0.65","size":"134.72"},
            {"price":"0.66","size":"279.44"}, {"price":"0.67","size":"239.44"}, {"price":"0.68","size":"30"}, {"price":"0.71","size":"5"},
            {"price":"0.74","size":"2889.22"}, {"price":"0.769","size":"47"}, {"price":"0.77","size":"104.72"}, {"price":"0.78","size":"209.44"},
            {"price":"0.79","size":"209.44"}, {"price":"0.82","size":"1388.88"}, {"price":"0.83","size":"14072.31"}, {"price":"0.84","size":"9"},
            {"price":"0.85","size":"2000"}, {"price":"0.86","size":"27.5"}, {"price":"0.879","size":"30770.8"}, {"price":"0.89","size":"7727.26"},
            {"price":"0.93","size":"17142.83"}, {"price":"0.95","size":"113285"}, {"price":"0.97","size":"10000"}, {"price":"0.98","size":"61000"},
            {"price":"0.99","size":"162667.66"}, {"price":"0.995","size":"25"}, {"price":"0.999","size":"16398.67"},
          ],
        },
        {
          "event_type": "book",
          "asset_id": "81991637217769173167120472548201162753479510171986166836308777400146642216229",
          "timestamp": "1789156453209",
          "hash": "9d9ec7017db2bea4f8d5de1ac4bd828072e923c7",
          "bids": [
            {"price":"0.441","size":"4892.52"}, {"price":"0.44","size":"170.72"}, {"price":"0.435","size":"17"}, {"price":"0.431","size":"4938"},
            {"price":"0.43","size":"209.44"}, {"price":"0.425","size":"176.9"}, {"price":"0.424","size":"16684"}, {"price":"0.423","size":"11622.99"},
            {"price":"0.42","size":"209.44"}, {"price":"0.412","size":"150"}, {"price":"0.408","size":"50"}, {"price":"0.4","size":"2030"},
            {"price":"0.37","size":"32"}, {"price":"0.368","size":"10"}, {"price":"0.362","size":"3550"}, {"price":"0.361","size":"61096"},
            {"price":"0.36","size":"2030"}, {"price":"0.355","size":"11622.99"}, {"price":"0.354","size":"11623"}, {"price":"0.35","size":"134.72"},
            {"price":"0.34","size":"279.44"}, {"price":"0.33","size":"239.44"}, {"price":"0.32","size":"30"}, {"price":"0.29","size":"5"},
            {"price":"0.26","size":"2889.22"}, {"price":"0.231","size":"47"}, {"price":"0.23","size":"104.72"}, {"price":"0.22","size":"209.44"},
            {"price":"0.21","size":"209.44"}, {"price":"0.18","size":"1388.88"}, {"price":"0.17","size":"14072.31"}, {"price":"0.16","size":"9"},
            {"price":"0.15","size":"2000"}, {"price":"0.14","size":"27.5"}, {"price":"0.121","size":"30770.8"}, {"price":"0.11","size":"7727.26"},
            {"price":"0.07","size":"17142.83"}, {"price":"0.05","size":"113285"}, {"price":"0.03","size":"10000"}, {"price":"0.02","size":"61000"},
            {"price":"0.01","size":"162667.66"}, {"price":"0.005","size":"25"}, {"price":"0.001","size":"16398.67"},
          ],
          "asks": [
            {"price":"0.446","size":"10.7"}, {"price":"0.447","size":"10.7"}, {"price":"0.448","size":"10.7"}, {"price":"0.449","size":"10.7"},
            {"price":"0.454","size":"30.7"}, {"price":"0.456","size":"90"}, {"price":"0.457","size":"4938"}, {"price":"0.458","size":"341.09"},
            {"price":"0.459","size":"5061"}, {"price":"0.46","size":"142.28"}, {"price":"0.469","size":"25"}, {"price":"0.47","size":"220.56"},
            {"price":"0.473","size":"50"}, {"price":"0.478","size":"1000"}, {"price":"0.479","size":"300"}, {"price":"0.48","size":"190.56"},
            {"price":"0.49","size":"52.5"}, {"price":"0.5","size":"32"}, {"price":"0.502","size":"10116"}, {"price":"0.503","size":"11623"},
            {"price":"0.504","size":"11622.99"}, {"price":"0.51","size":"95.28"}, {"price":"0.52","size":"2190.56"}, {"price":"0.53","size":"190.56"},
            {"price":"0.559","size":"40"}, {"price":"0.56","size":"2330"}, {"price":"0.57","size":"5"}, {"price":"0.58","size":"19"},
            {"price":"0.59","size":"5"}, {"price":"0.6","size":"1880"}, {"price":"0.64","size":"32"}, {"price":"0.668","size":"47"},
            {"price":"0.67","size":"672"}, {"price":"0.72","size":"25"}, {"price":"0.73","size":"925.92"}, {"price":"0.738","size":"5369.6"},
            {"price":"0.74","size":"2999.98"}, {"price":"0.748","size":"32.74"}, {"price":"0.75","size":"1200"}, {"price":"0.767","size":"13547.58"},
            {"price":"0.78","size":"2636.35"}, {"price":"0.8","size":"20390"}, {"price":"0.82","size":"1498.88"}, {"price":"0.83","size":"4705.86"},
            {"price":"0.85","size":"11466.66"}, {"price":"0.867","size":"21903.51"}, {"price":"0.87","size":"155"}, {"price":"0.88","size":"2500"},
            {"price":"0.89","size":"17272.7"}, {"price":"0.91","size":"2222.22"}, {"price":"0.919","size":"50980"}, {"price":"0.92","size":"73855"},
            {"price":"0.949","size":"55"}, {"price":"0.95","size":"16400"}, {"price":"0.97","size":"43998.33"}, {"price":"0.98","size":"261000"},
            {"price":"0.99","size":"126680"}, {"price":"0.999","size":"5199.99"},
          ],
        },
      ],
    },
    records: [
      {"schemaVersion":1,"runId":"tail5m-validation-20260912","sequence":6221,"receivedAt":"2026-09-11T19:54:13.413Z","receivedAtMs":1789156453413,"monotonicNs":"366140136531333","source":"clob","kind":"ws_message","data":"{\"market\":\"0x86964402baab9700a765594e0856dcfce5120b44e0016d98e01801f0856f9118\", \"asset_id\":\"89103662922399853582210727094555628545682161257465140653230183411405552444242\", \"best_bid\":\"0.546\", \"best_ask\":\"0.559\", \"spread\":\"0.013\", \"timestamp\":\"1789156453210\", \"event_type\":\"best_bid_ask\"}","connectionId":"clob-0-e1"},
      {"schemaVersion":1,"runId":"tail5m-validation-20260912","sequence":6222,"receivedAt":"2026-09-11T19:54:13.413Z","receivedAtMs":1789156453413,"monotonicNs":"366140136556916","source":"clob","kind":"ws_message","data":"{\"market\":\"0x86964402baab9700a765594e0856dcfce5120b44e0016d98e01801f0856f9118\", \"asset_id\":\"81991637217769173167120472548201162753479510171986166836308777400146642216229\", \"best_bid\":\"0.441\", \"best_ask\":\"0.454\", \"spread\":\"0.013\", \"timestamp\":\"1789156453210\", \"event_type\":\"best_bid_ask\"}","connectionId":"clob-0-e1"},
      {"schemaVersion":1,"runId":"tail5m-validation-20260912","sequence":6223,"receivedAt":"2026-09-11T19:54:13.413Z","receivedAtMs":1789156453413,"monotonicNs":"366140136574208","source":"clob","kind":"ws_message","data":"{\"market\":\"0x86964402baab9700a765594e0856dcfce5120b44e0016d98e01801f0856f9118\", \"price_changes\":[{\"asset_id\":\"89103662922399853582210727094555628545682161257465140653230183411405552444242\", \"price\":\"0.554\", \"size\":\"0\", \"side\":\"BUY\", \"hash\":\"90ad28d07ca4c9c0a1b0977db1ef6c13c939d5bb\", \"best_bid\":\"0.546\", \"best_ask\":\"0.559\"}, {\"asset_id\":\"81991637217769173167120472548201162753479510171986166836308777400146642216229\", \"price\":\"0.446\", \"size\":\"0\", \"side\":\"SELL\", \"hash\":\"e046dd0be55d991a694731eacaef62b1c68dce26\", \"best_bid\":\"0.441\", \"best_ask\":\"0.454\"}], \"timestamp\":\"1789156453209\", \"event_type\":\"price_change\"}","connectionId":"clob-0-e1"},
      {"schemaVersion":1,"runId":"tail5m-validation-20260912","sequence":6224,"receivedAt":"2026-09-11T19:54:13.413Z","receivedAtMs":1789156453413,"monotonicNs":"366140136603208","source":"clob","kind":"ws_message","data":"{\"market\":\"0x86964402baab9700a765594e0856dcfce5120b44e0016d98e01801f0856f9118\", \"price_changes\":[{\"asset_id\":\"89103662922399853582210727094555628545682161257465140653230183411405552444242\", \"price\":\"0.553\", \"size\":\"0\", \"side\":\"BUY\", \"hash\":\"90ad28d07ca4c9c0a1b0977db1ef6c13c939d5bb\", \"best_bid\":\"0.546\", \"best_ask\":\"0.559\"}, {\"asset_id\":\"81991637217769173167120472548201162753479510171986166836308777400146642216229\", \"price\":\"0.447\", \"size\":\"0\", \"side\":\"SELL\", \"hash\":\"e046dd0be55d991a694731eacaef62b1c68dce26\", \"best_bid\":\"0.441\", \"best_ask\":\"0.454\"}], \"timestamp\":\"1789156453209\", \"event_type\":\"price_change\"}","connectionId":"clob-0-e1"},
      {"schemaVersion":1,"runId":"tail5m-validation-20260912","sequence":6225,"receivedAt":"2026-09-11T19:54:13.413Z","receivedAtMs":1789156453413,"monotonicNs":"366140136620666","source":"clob","kind":"ws_message","data":"{\"market\":\"0x86964402baab9700a765594e0856dcfce5120b44e0016d98e01801f0856f9118\", \"price_changes\":[{\"asset_id\":\"89103662922399853582210727094555628545682161257465140653230183411405552444242\", \"price\":\"0.552\", \"size\":\"0\", \"side\":\"BUY\", \"hash\":\"90ad28d07ca4c9c0a1b0977db1ef6c13c939d5bb\", \"best_bid\":\"0.546\", \"best_ask\":\"0.559\"}, {\"asset_id\":\"81991637217769173167120472548201162753479510171986166836308777400146642216229\", \"price\":\"0.448\", \"size\":\"0\", \"side\":\"SELL\", \"hash\":\"e046dd0be55d991a694731eacaef62b1c68dce26\", \"best_bid\":\"0.441\", \"best_ask\":\"0.454\"}], \"timestamp\":\"1789156453209\", \"event_type\":\"price_change\"}","connectionId":"clob-0-e1"},
      {"schemaVersion":1,"runId":"tail5m-validation-20260912","sequence":6226,"receivedAt":"2026-09-11T19:54:13.413Z","receivedAtMs":1789156453413,"monotonicNs":"366140136637083","source":"clob","kind":"ws_message","data":"{\"market\":\"0x86964402baab9700a765594e0856dcfce5120b44e0016d98e01801f0856f9118\", \"price_changes\":[{\"asset_id\":\"89103662922399853582210727094555628545682161257465140653230183411405552444242\", \"price\":\"0.551\", \"size\":\"0\", \"side\":\"BUY\", \"hash\":\"90ad28d07ca4c9c0a1b0977db1ef6c13c939d5bb\", \"best_bid\":\"0.546\", \"best_ask\":\"0.559\"}, {\"asset_id\":\"81991637217769173167120472548201162753479510171986166836308777400146642216229\", \"price\":\"0.449\", \"size\":\"0\", \"side\":\"SELL\", \"hash\":\"e046dd0be55d991a694731eacaef62b1c68dce26\", \"best_bid\":\"0.441\", \"best_ask\":\"0.454\"}], \"timestamp\":\"1789156453209\", \"event_type\":\"price_change\"}","connectionId":"clob-0-e1"},
    ],
  },
  {
    name: "crossed fill",
    root: 11775,
    checkpoint: {
      "schemaVersion": 1,
      "runId": "tail5m-validation-20260912",
      "sequence": 11772,
      "receivedAt": "2026-09-11T19:54:57.005Z",
      "receivedAtMs": 1789156497005,
      "monotonicNs": "366183728309291",
      "source": "clob",
      "kind": "ws_message",
      "connectionId": "clob-0-e1",
      data: [
        {
          "event_type": "book",
          "asset_id": "89103662922399853582210727094555628545682161257465140653230183411405552444242",
          "timestamp": "1789156496898",
          "hash": "be9d7d64320e6a26ff165577f3f902b9d4ca5587",
          "bids": [
            {"price":"0.63","size":"91"}, {"price":"0.624","size":"100.7"}, {"price":"0.623","size":"4948.7"}, {"price":"0.622","size":"439.29"},
            {"price":"0.621","size":"5110.36"}, {"price":"0.62","size":"18986.33"}, {"price":"0.613","size":"2500"}, {"price":"0.612","size":"4938"},
            {"price":"0.61","size":"1961.56"}, {"price":"0.606","size":"10"}, {"price":"0.601","size":"1017"}, {"price":"0.6","size":"827"},
            {"price":"0.593","size":"25"}, {"price":"0.592","size":"300"}, {"price":"0.59","size":"927"}, {"price":"0.584","size":"25"},
            {"price":"0.58","size":"896"}, {"price":"0.56","size":"2000"}, {"price":"0.541","size":"10116"}, {"price":"0.54","size":"25093.14"},
            {"price":"0.53","size":"1186.28"}, {"price":"0.526","size":"90"}, {"price":"0.52","size":"2186.28"}, {"price":"0.51","size":"22.5"},
            {"price":"0.49","size":"95.28"}, {"price":"0.48","size":"190.56"}, {"price":"0.47","size":"190.56"}, {"price":"0.45","size":"300"},
            {"price":"0.44","size":"5075.71"}, {"price":"0.43","size":"52"}, {"price":"0.41","size":"5"}, {"price":"0.4","size":"1880"},
            {"price":"0.33","size":"672"}, {"price":"0.29","size":"9337.19"}, {"price":"0.27","size":"2037.03"}, {"price":"0.252","size":"32.74"},
            {"price":"0.25","size":"4320"}, {"price":"0.233","size":"13547.58"}, {"price":"0.22","size":"2636.35"}, {"price":"0.2","size":"22140"},
            {"price":"0.18","size":"1498.88"}, {"price":"0.17","size":"4705.86"}, {"price":"0.15","size":"11466.66"}, {"price":"0.133","size":"25286.96"},
            {"price":"0.13","size":"2517.69"}, {"price":"0.11","size":"17272.7"}, {"price":"0.09","size":"2222.22"}, {"price":"0.081","size":"50980"},
            {"price":"0.08","size":"90105"}, {"price":"0.05","size":"16400"}, {"price":"0.03","size":"43998.33"}, {"price":"0.02","size":"261000"},
            {"price":"0.01","size":"126680"}, {"price":"0.001","size":"5199.99"},
          ],
          "asks": [
            {"price":"0.631","size":"21"}, {"price":"0.632","size":"11"}, {"price":"0.633","size":"47.68"}, {"price":"0.634","size":"50"},
            {"price":"0.638","size":"4955"}, {"price":"0.64","size":"1269"}, {"price":"0.643","size":"12"}, {"price":"0.644","size":"5"},
            {"price":"0.648","size":"5059.4"}, {"price":"0.649","size":"5074"}, {"price":"0.65","size":"1104.72"}, {"price":"0.652","size":"50"},
            {"price":"0.658","size":"300"}, {"price":"0.66","size":"239.44"}, {"price":"0.67","size":"2285.44"}, {"price":"0.68","size":"2030"},
            {"price":"0.689","size":"2550"}, {"price":"0.69","size":"62"}, {"price":"0.699","size":"10"}, {"price":"0.7","size":"30"},
            {"price":"0.708","size":"1000"}, {"price":"0.709","size":"10116"}, {"price":"0.71","size":"25000"}, {"price":"0.72","size":"5000"},
            {"price":"0.759","size":"40"}, {"price":"0.76","size":"1106.86"}, {"price":"0.77","size":"213.72"}, {"price":"0.78","size":"213.72"},
            {"price":"0.81","size":"32"}, {"price":"0.83","size":"2484.11"}, {"price":"0.84","size":"56"}, {"price":"0.85","size":"2000"},
            {"price":"0.86","size":"27.5"}, {"price":"0.879","size":"18845.23"}, {"price":"0.89","size":"5909.08"}, {"price":"0.91","size":"4444.44"},
            {"price":"0.949","size":"50980"}, {"price":"0.95","size":"105285"}, {"price":"0.97","size":"10000"}, {"price":"0.98","size":"113500"},
            {"price":"0.99","size":"126000"}, {"price":"0.995","size":"25"}, {"price":"0.999","size":"16398.67"},
          ],
        },
        {
          "event_type": "book",
          "asset_id": "81991637217769173167120472548201162753479510171986166836308777400146642216229",
          "timestamp": "1789156496898",
          "hash": "a71df198f4f1827b9065c38459dcf43aea17203f",
          "bids": [
            {"price":"0.369","size":"21"}, {"price":"0.368","size":"11"}, {"price":"0.367","size":"47.68"}, {"price":"0.366","size":"50"},
            {"price":"0.362","size":"4955"}, {"price":"0.36","size":"1269"}, {"price":"0.357","size":"12"}, {"price":"0.356","size":"5"},
            {"price":"0.352","size":"5059.4"}, {"price":"0.351","size":"5074"}, {"price":"0.35","size":"1104.72"}, {"price":"0.348","size":"50"},
            {"price":"0.342","size":"300"}, {"price":"0.34","size":"239.44"}, {"price":"0.33","size":"2285.44"}, {"price":"0.32","size":"2030"},
            {"price":"0.311","size":"2550"}, {"price":"0.31","size":"62"}, {"price":"0.301","size":"10"}, {"price":"0.3","size":"30"},
            {"price":"0.292","size":"1000"}, {"price":"0.291","size":"10116"}, {"price":"0.29","size":"25000"}, {"price":"0.28","size":"5000"},
            {"price":"0.241","size":"40"}, {"price":"0.24","size":"1106.86"}, {"price":"0.23","size":"213.72"}, {"price":"0.22","size":"213.72"},
            {"price":"0.19","size":"32"}, {"price":"0.17","size":"2484.11"}, {"price":"0.16","size":"56"}, {"price":"0.15","size":"2000"},
            {"price":"0.14","size":"27.5"}, {"price":"0.121","size":"18845.23"}, {"price":"0.11","size":"5909.08"}, {"price":"0.09","size":"4444.44"},
            {"price":"0.051","size":"50980"}, {"price":"0.05","size":"105285"}, {"price":"0.03","size":"10000"}, {"price":"0.02","size":"113500"},
            {"price":"0.01","size":"126000"}, {"price":"0.005","size":"25"}, {"price":"0.001","size":"16398.67"},
          ],
          "asks": [
            {"price":"0.37","size":"91"}, {"price":"0.376","size":"100.7"}, {"price":"0.377","size":"4948.7"}, {"price":"0.378","size":"439.29"},
            {"price":"0.379","size":"5110.36"}, {"price":"0.38","size":"18986.33"}, {"price":"0.387","size":"2500"}, {"price":"0.388","size":"4938"},
            {"price":"0.39","size":"1961.56"}, {"price":"0.394","size":"10"}, {"price":"0.399","size":"1017"}, {"price":"0.4","size":"827"},
            {"price":"0.407","size":"25"}, {"price":"0.408","size":"300"}, {"price":"0.41","size":"927"}, {"price":"0.416","size":"25"},
            {"price":"0.42","size":"896"}, {"price":"0.44","size":"2000"}, {"price":"0.459","size":"10116"}, {"price":"0.46","size":"25093.14"},
            {"price":"0.47","size":"1186.28"}, {"price":"0.474","size":"90"}, {"price":"0.48","size":"2186.28"}, {"price":"0.49","size":"22.5"},
            {"price":"0.51","size":"95.28"}, {"price":"0.52","size":"190.56"}, {"price":"0.53","size":"190.56"}, {"price":"0.55","size":"300"},
            {"price":"0.56","size":"5075.71"}, {"price":"0.57","size":"52"}, {"price":"0.59","size":"5"}, {"price":"0.6","size":"1880"},
            {"price":"0.67","size":"672"}, {"price":"0.71","size":"9337.19"}, {"price":"0.73","size":"2037.03"}, {"price":"0.748","size":"32.74"},
            {"price":"0.75","size":"4320"}, {"price":"0.767","size":"13547.58"}, {"price":"0.78","size":"2636.35"}, {"price":"0.8","size":"22140"},
            {"price":"0.82","size":"1498.88"}, {"price":"0.83","size":"4705.86"}, {"price":"0.85","size":"11466.66"}, {"price":"0.867","size":"25286.96"},
            {"price":"0.87","size":"2517.69"}, {"price":"0.89","size":"17272.7"}, {"price":"0.91","size":"2222.22"}, {"price":"0.919","size":"50980"},
            {"price":"0.92","size":"90105"}, {"price":"0.95","size":"16400"}, {"price":"0.97","size":"43998.33"}, {"price":"0.98","size":"261000"},
            {"price":"0.99","size":"126680"}, {"price":"0.999","size":"5199.99"},
          ],
        },
      ],
    },
    records: [
      {"schemaVersion":1,"runId":"tail5m-validation-20260912","sequence":11773,"receivedAt":"2026-09-11T19:54:57.118Z","receivedAtMs":1789156497118,"monotonicNs":"366183840995500","source":"clob","kind":"ws_message","data":"{\"market\":\"0x86964402baab9700a765594e0856dcfce5120b44e0016d98e01801f0856f9118\", \"asset_id\":\"89103662922399853582210727094555628545682161257465140653230183411405552444242\", \"best_bid\":\"0.624\", \"best_ask\":\"0.63\", \"spread\":\"0.006\", \"timestamp\":\"1789156497003\", \"event_type\":\"best_bid_ask\"}","connectionId":"clob-0-e1"},
      {"schemaVersion":1,"runId":"tail5m-validation-20260912","sequence":11774,"receivedAt":"2026-09-11T19:54:57.118Z","receivedAtMs":1789156497118,"monotonicNs":"366183841047541","source":"clob","kind":"ws_message","data":"{\"market\":\"0x86964402baab9700a765594e0856dcfce5120b44e0016d98e01801f0856f9118\", \"asset_id\":\"81991637217769173167120472548201162753479510171986166836308777400146642216229\", \"best_bid\":\"0.37\", \"best_ask\":\"0.376\", \"spread\":\"0.006\", \"timestamp\":\"1789156497003\", \"event_type\":\"best_bid_ask\"}","connectionId":"clob-0-e1"},
      {"schemaVersion":1,"runId":"tail5m-validation-20260912","sequence":11775,"receivedAt":"2026-09-11T19:54:57.118Z","receivedAtMs":1789156497118,"monotonicNs":"366183841065083","source":"clob","kind":"ws_message","data":"{\"market\":\"0x86964402baab9700a765594e0856dcfce5120b44e0016d98e01801f0856f9118\", \"price_changes\":[{\"asset_id\":\"81991637217769173167120472548201162753479510171986166836308777400146642216229\", \"price\":\"0.37\", \"size\":\"9\", \"side\":\"BUY\", \"hash\":\"6bc823e46c7b36e55f34e56d83e7d7ee6f8c4bb7\", \"best_bid\":\"0.37\", \"best_ask\":\"0.376\"}, {\"asset_id\":\"89103662922399853582210727094555628545682161257465140653230183411405552444242\", \"price\":\"0.63\", \"size\":\"9\", \"side\":\"SELL\", \"hash\":\"54ba2d9b1da111427248986de06f9b22435b696f\", \"best_bid\":\"0.624\", \"best_ask\":\"0.63\"}], \"timestamp\":\"1789156497002\", \"event_type\":\"price_change\"}","connectionId":"clob-0-e1"},
      {"schemaVersion":1,"runId":"tail5m-validation-20260912","sequence":11776,"receivedAt":"2026-09-11T19:54:57.118Z","receivedAtMs":1789156497118,"monotonicNs":"366183841081666","source":"clob","kind":"ws_message","data":"{\"market\":\"0x86964402baab9700a765594e0856dcfce5120b44e0016d98e01801f0856f9118\", \"price_changes\":[{\"asset_id\":\"89103662922399853582210727094555628545682161257465140653230183411405552444242\", \"price\":\"0.63\", \"size\":\"0\", \"side\":\"BUY\", \"hash\":\"54ba2d9b1da111427248986de06f9b22435b696f\", \"best_bid\":\"0.624\", \"best_ask\":\"0.63\"}, {\"asset_id\":\"81991637217769173167120472548201162753479510171986166836308777400146642216229\", \"price\":\"0.37\", \"size\":\"0\", \"side\":\"SELL\", \"hash\":\"6bc823e46c7b36e55f34e56d83e7d7ee6f8c4bb7\", \"best_bid\":\"0.37\", \"best_ask\":\"0.376\"}], \"timestamp\":\"1789156497002\", \"event_type\":\"price_change\"}","connectionId":"clob-0-e1"},
      {"schemaVersion":1,"runId":"tail5m-validation-20260912","sequence":11777,"receivedAt":"2026-09-11T19:54:57.118Z","receivedAtMs":1789156497118,"monotonicNs":"366183841241291","source":"clob","kind":"ws_message","data":"{\"market\":\"0x86964402baab9700a765594e0856dcfce5120b44e0016d98e01801f0856f9118\", \"asset_id\":\"89103662922399853582210727094555628545682161257465140653230183411405552444242\", \"bids\":[{\"price\":\"0.001\", \"size\":\"5199.99\"}, {\"price\":\"0.01\", \"size\":\"126680\"}, {\"price\":\"0.02\", \"size\":\"261000\"}, {\"price\":\"0.03\", \"size\":\"43998.33\"}, {\"price\":\"0.05\", \"size\":\"16400\"}, {\"price\":\"0.08\", \"size\":\"90105\"}, {\"price\":\"0.081\", \"size\":\"50980\"}, {\"price\":\"0.09\", \"size\":\"2222.22\"}, {\"price\":\"0.11\", \"size\":\"17272.7\"}, {\"price\":\"0.13\", \"size\":\"2517.69\"}, {\"price\":\"0.133\", \"size\":\"25286.96\"}, {\"price\":\"0.15\", \"size\":\"11466.66\"}, {\"price\":\"0.17\", \"size\":\"4705.86\"}, {\"price\":\"0.18\", \"size\":\"1498.88\"}, {\"price\":\"0.2\", \"size\":\"22140\"}, {\"price\":\"0.22\", \"size\":\"2636.35\"}, {\"price\":\"0.233\", \"size\":\"13547.58\"}, {\"price\":\"0.25\", \"size\":\"4320\"}, {\"price\":\"0.252\", \"size\":\"32.74\"}, {\"price\":\"0.27\", \"size\":\"2037.03\"}, {\"price\":\"0.29\", \"size\":\"9337.19\"}, {\"price\":\"0.33\", \"size\":\"672\"}, {\"price\":\"0.4\", \"size\":\"1880\"}, {\"price\":\"0.41\", \"size\":\"5\"}, {\"price\":\"0.43\", \"size\":\"52\"}, {\"price\":\"0.44\", \"size\":\"5075.71\"}, {\"price\":\"0.45\", \"size\":\"300\"}, {\"price\":\"0.47\", \"size\":\"190.56\"}, {\"price\":\"0.48\", \"size\":\"190.56\"}, {\"price\":\"0.49\", \"size\":\"95.28\"}, {\"price\":\"0.51\", \"size\":\"22.5\"}, {\"price\":\"0.52\", \"size\":\"2186.28\"}, {\"price\":\"0.526\", \"size\":\"90\"}, {\"price\":\"0.53\", \"size\":\"1186.28\"}, {\"price\":\"0.54\", \"size\":\"25093.14\"}, {\"price\":\"0.541\", \"size\":\"10116\"}, {\"price\":\"0.56\", \"size\":\"2000\"}, {\"price\":\"0.58\", \"size\":\"896\"}, {\"price\":\"0.584\", \"size\":\"25\"}, {\"price\":\"0.59\", \"size\":\"927\"}, {\"price\":\"0.592\", \"size\":\"300\"}, {\"price\":\"0.593\", \"size\":\"25\"}, {\"price\":\"0.6\", \"size\":\"827\"}, {\"price\":\"0.601\", \"size\":\"1017\"}, {\"price\":\"0.606\", \"size\":\"10\"}, {\"price\":\"0.61\", \"size\":\"1961.56\"}, {\"price\":\"0.612\", \"size\":\"4938\"}, {\"price\":\"0.613\", \"size\":\"2500\"}, {\"price\":\"0.62\", \"size\":\"18986.33\"}, {\"price\":\"0.621\", \"size\":\"5110.36\"}, {\"price\":\"0.622\", \"size\":\"439.29\"}, {\"price\":\"0.623\", \"size\":\"4948.7\"}, {\"price\":\"0.624\", \"size\":\"100.7\"}], \"asks\":[{\"price\":\"0.999\", \"size\":\"16398.67\"}, {\"price\":\"0.995\", \"size\":\"25\"}, {\"price\":\"0.99\", \"size\":\"126000\"}, {\"price\":\"0.98\", \"size\":\"113500\"}, {\"price\":\"0.97\", \"size\":\"10000\"}, {\"price\":\"0.95\", \"size\":\"105285\"}, {\"price\":\"0.949\", \"size\":\"50980\"}, {\"price\":\"0.91\", \"size\":\"4444.44\"}, {\"price\":\"0.89\", \"size\":\"5909.08\"}, {\"price\":\"0.879\", \"size\":\"18845.23\"}, {\"price\":\"0.86\", \"size\":\"27.5\"}, {\"price\":\"0.85\", \"size\":\"2000\"}, {\"price\":\"0.84\", \"size\":\"56\"}, {\"price\":\"0.83\", \"size\":\"2484.11\"}, {\"price\":\"0.81\", \"size\":\"32\"}, {\"price\":\"0.78\", \"size\":\"213.72\"}, {\"price\":\"0.77\", \"size\":\"213.72\"}, {\"price\":\"0.76\", \"size\":\"1106.86\"}, {\"price\":\"0.759\", \"size\":\"40\"}, {\"price\":\"0.72\", \"size\":\"5000\"}, {\"price\":\"0.71\", \"size\":\"25000\"}, {\"price\":\"0.709\", \"size\":\"10116\"}, {\"price\":\"0.708\", \"size\":\"1000\"}, {\"price\":\"0.7\", \"size\":\"30\"}, {\"price\":\"0.699\", \"size\":\"10\"}, {\"price\":\"0.69\", \"size\":\"62\"}, {\"price\":\"0.689\", \"size\":\"2550\"}, {\"price\":\"0.68\", \"size\":\"2030\"}, {\"price\":\"0.67\", \"size\":\"2285.44\"}, {\"price\":\"0.66\", \"size\":\"239.44\"}, {\"price\":\"0.658\", \"size\":\"300\"}, {\"price\":\"0.652\", \"size\":\"50\"}, {\"price\":\"0.65\", \"size\":\"1104.72\"}, {\"price\":\"0.649\", \"size\":\"5074\"}, {\"price\":\"0.648\", \"size\":\"5059.4\"}, {\"price\":\"0.644\", \"size\":\"5\"}, {\"price\":\"0.643\", \"size\":\"12\"}, {\"price\":\"0.64\", \"size\":\"1269\"}, {\"price\":\"0.638\", \"size\":\"4955\"}, {\"price\":\"0.634\", \"size\":\"50\"}, {\"price\":\"0.633\", \"size\":\"47.68\"}, {\"price\":\"0.632\", \"size\":\"11\"}, {\"price\":\"0.631\", \"size\":\"21\"}, {\"price\":\"0.63\", \"size\":\"9\"}], \"hash\":\"54ba2d9b1da111427248986de06f9b22435b696f\", \"timestamp\":\"1789156497002\", \"event_type\":\"book\"}","connectionId":"clob-0-e1"},
      {"schemaVersion":1,"runId":"tail5m-validation-20260912","sequence":11778,"receivedAt":"2026-09-11T19:54:57.118Z","receivedAtMs":1789156497118,"monotonicNs":"366183841288500","source":"clob","kind":"ws_message","data":"{\"market\":\"0x86964402baab9700a765594e0856dcfce5120b44e0016d98e01801f0856f9118\", \"asset_id\":\"81991637217769173167120472548201162753479510171986166836308777400146642216229\", \"bids\":[{\"price\":\"0.001\", \"size\":\"16398.67\"}, {\"price\":\"0.005\", \"size\":\"25\"}, {\"price\":\"0.01\", \"size\":\"126000\"}, {\"price\":\"0.02\", \"size\":\"113500\"}, {\"price\":\"0.03\", \"size\":\"10000\"}, {\"price\":\"0.05\", \"size\":\"105285\"}, {\"price\":\"0.051\", \"size\":\"50980\"}, {\"price\":\"0.09\", \"size\":\"4444.44\"}, {\"price\":\"0.11\", \"size\":\"5909.08\"}, {\"price\":\"0.121\", \"size\":\"18845.23\"}, {\"price\":\"0.14\", \"size\":\"27.5\"}, {\"price\":\"0.15\", \"size\":\"2000\"}, {\"price\":\"0.16\", \"size\":\"56\"}, {\"price\":\"0.17\", \"size\":\"2484.11\"}, {\"price\":\"0.19\", \"size\":\"32\"}, {\"price\":\"0.22\", \"size\":\"213.72\"}, {\"price\":\"0.23\", \"size\":\"213.72\"}, {\"price\":\"0.24\", \"size\":\"1106.86\"}, {\"price\":\"0.241\", \"size\":\"40\"}, {\"price\":\"0.28\", \"size\":\"5000\"}, {\"price\":\"0.29\", \"size\":\"25000\"}, {\"price\":\"0.291\", \"size\":\"10116\"}, {\"price\":\"0.292\", \"size\":\"1000\"}, {\"price\":\"0.3\", \"size\":\"30\"}, {\"price\":\"0.301\", \"size\":\"10\"}, {\"price\":\"0.31\", \"size\":\"62\"}, {\"price\":\"0.311\", \"size\":\"2550\"}, {\"price\":\"0.32\", \"size\":\"2030\"}, {\"price\":\"0.33\", \"size\":\"2285.44\"}, {\"price\":\"0.34\", \"size\":\"239.44\"}, {\"price\":\"0.342\", \"size\":\"300\"}, {\"price\":\"0.348\", \"size\":\"50\"}, {\"price\":\"0.35\", \"size\":\"1104.72\"}, {\"price\":\"0.351\", \"size\":\"5074\"}, {\"price\":\"0.352\", \"size\":\"5059.4\"}, {\"price\":\"0.356\", \"size\":\"5\"}, {\"price\":\"0.357\", \"size\":\"12\"}, {\"price\":\"0.36\", \"size\":\"1269\"}, {\"price\":\"0.362\", \"size\":\"4955\"}, {\"price\":\"0.366\", \"size\":\"50\"}, {\"price\":\"0.367\", \"size\":\"47.68\"}, {\"price\":\"0.368\", \"size\":\"11\"}, {\"price\":\"0.369\", \"size\":\"21\"}, {\"price\":\"0.37\", \"size\":\"9\"}], \"asks\":[{\"price\":\"0.999\", \"size\":\"5199.99\"}, {\"price\":\"0.99\", \"size\":\"126680\"}, {\"price\":\"0.98\", \"size\":\"261000\"}, {\"price\":\"0.97\", \"size\":\"43998.33\"}, {\"price\":\"0.95\", \"size\":\"16400\"}, {\"price\":\"0.92\", \"size\":\"90105\"}, {\"price\":\"0.919\", \"size\":\"50980\"}, {\"price\":\"0.91\", \"size\":\"2222.22\"}, {\"price\":\"0.89\", \"size\":\"17272.7\"}, {\"price\":\"0.87\", \"size\":\"2517.69\"}, {\"price\":\"0.867\", \"size\":\"25286.96\"}, {\"price\":\"0.85\", \"size\":\"11466.66\"}, {\"price\":\"0.83\", \"size\":\"4705.86\"}, {\"price\":\"0.82\", \"size\":\"1498.88\"}, {\"price\":\"0.8\", \"size\":\"22140\"}, {\"price\":\"0.78\", \"size\":\"2636.35\"}, {\"price\":\"0.767\", \"size\":\"13547.58\"}, {\"price\":\"0.75\", \"size\":\"4320\"}, {\"price\":\"0.748\", \"size\":\"32.74\"}, {\"price\":\"0.73\", \"size\":\"2037.03\"}, {\"price\":\"0.71\", \"size\":\"9337.19\"}, {\"price\":\"0.67\", \"size\":\"672\"}, {\"price\":\"0.6\", \"size\":\"1880\"}, {\"price\":\"0.59\", \"size\":\"5\"}, {\"price\":\"0.57\", \"size\":\"52\"}, {\"price\":\"0.56\", \"size\":\"5075.71\"}, {\"price\":\"0.55\", \"size\":\"300\"}, {\"price\":\"0.53\", \"size\":\"190.56\"}, {\"price\":\"0.52\", \"size\":\"190.56\"}, {\"price\":\"0.51\", \"size\":\"95.28\"}, {\"price\":\"0.49\", \"size\":\"22.5\"}, {\"price\":\"0.48\", \"size\":\"2186.28\"}, {\"price\":\"0.474\", \"size\":\"90\"}, {\"price\":\"0.47\", \"size\":\"1186.28\"}, {\"price\":\"0.46\", \"size\":\"25093.14\"}, {\"price\":\"0.459\", \"size\":\"10116\"}, {\"price\":\"0.44\", \"size\":\"2000\"}, {\"price\":\"0.42\", \"size\":\"896\"}, {\"price\":\"0.416\", \"size\":\"25\"}, {\"price\":\"0.41\", \"size\":\"927\"}, {\"price\":\"0.408\", \"size\":\"300\"}, {\"price\":\"0.407\", \"size\":\"25\"}, {\"price\":\"0.4\", \"size\":\"827\"}, {\"price\":\"0.399\", \"size\":\"1017\"}, {\"price\":\"0.394\", \"size\":\"10\"}, {\"price\":\"0.39\", \"size\":\"1961.56\"}, {\"price\":\"0.388\", \"size\":\"4938\"}, {\"price\":\"0.387\", \"size\":\"2500\"}, {\"price\":\"0.38\", \"size\":\"18986.33\"}, {\"price\":\"0.379\", \"size\":\"5110.36\"}, {\"price\":\"0.378\", \"size\":\"439.29\"}, {\"price\":\"0.377\", \"size\":\"4948.7\"}, {\"price\":\"0.376\", \"size\":\"100.7\"}], \"hash\":\"6bc823e46c7b36e55f34e56d83e7d7ee6f8c4bb7\", \"timestamp\":\"1789156497002\", \"event_type\":\"book\"}","connectionId":"clob-0-e1"},
    ],
  },
];

function capturedReplay(fixture: CapturedBatch, onInvalidation: (event: ReplayInvalidation) => void = () => {}) {
  const replay = new JournalReplay({ onInvalidation });
  let sequence = 0;
  const accept = (record: ReplayJournalRecord, gap = 0) => replay.accept({ ...record, sequence: sequence += 1 + gap });
  accept(fixture.checkpoint);
  return { replay, accept };
}

describe("captured multi-message book batches", () => {
  test.each(capturedBatches)("reconciles $name without requiring a new snapshot", fixture => {
    const invalidations: ReplayInvalidation[] = [];
    const { replay, accept } = capturedReplay(fixture, event => invalidations.push(event));
    const emitted = new Map<number, ReturnType<JournalReplay["accept"]>>();
    const sourceBytes = fixture.records.map(record => record.data);
    for (const record of fixture.records) {
      const batch = accept(record);
      emitted.set(record.sequence, batch);
      if (record.sequence === fixture.root) {
        expect(batch.quotes).toEqual([]);
        for (const book of fixture.checkpoint.data as Array<{ asset_id: string }>) {
          expect(replay.getBookStatus(record.connectionId!, book.asset_id)).toBe("invalid");
        }
      }
    }
    const recovery = fixture.root === 6223 ? 6226 : fixture.root + 1;
    expect(emitted.get(recovery)?.quotes).toHaveLength(2);
    expect(invalidations).toHaveLength(2);
    expect(invalidations.every(event => event.provisional === true)).toBe(true);
    expect(replay.quality.bookConsistency).toMatchObject({
      provisionalInvalidations: 2, recoveredByDelta: 2, persistentInvalidations: 0, recoveredBySnapshot: 0
    });
    expect(fixture.records.map(record => record.data)).toEqual(sourceBytes);
    for (const quote of emitted.get(recovery)!.quotes) {
      expect(replay.getBookStatus(quote.connectionId, quote.tokenId)).toBe("valid");
      expect(quote.bookHash).toBeDefined();
    }

    const checkpoint = fixture.checkpoint.data as Array<{ asset_id: string; bids: Array<{ price: string; size: string }>; asks: Array<{ price: string; size: string }> }>;
    if (fixture.root === 2267) {
      const [token, complement] = checkpoint;
      const final = emitted.get(2270)!.quotes;
      expect(final.find(row => row.tokenId === token!.asset_id)?.asks).toEqual(token!.asks.filter(level => !["0.637", "0.644", "0.659"].includes(level.price)));
      expect(final.find(row => row.tokenId === complement!.asset_id)?.bids).toEqual(complement!.bids.filter(level => !["0.363", "0.356", "0.341"].includes(level.price)));
    } else if (fixture.root === 6223) {
      const [token, complement] = checkpoint;
      const final = emitted.get(6226)!.quotes;
      expect(final.find(row => row.tokenId === token!.asset_id)?.bids).toEqual(token!.bids.filter(level => !["0.554", "0.553", "0.552", "0.551"].includes(level.price)));
      expect(final.find(row => row.tokenId === complement!.asset_id)?.asks).toEqual(complement!.asks.filter(level => !["0.446", "0.447", "0.448", "0.449"].includes(level.price)));
    } else {
      // The immediately following real WS snapshots have the same hashes and verify ALL levels.
      for (const record of fixture.records.filter(record => record.sequence >= 11777)) {
        const snapshot = JSON.parse(record.data as string) as { asset_id: string; hash: string; bids: unknown[]; asks: unknown[] };
        const recovered = emitted.get(11776)!.quotes.find(row => row.tokenId === snapshot.asset_id);
        expect(recovered).toMatchObject({ bookHash: snapshot.hash, bids: [...snapshot.bids].reverse(), asks: [...snapshot.asks].reverse() });
      }
    }
  });

  test("a missing captured cancellation stays invalid across the next source batch until a snapshot", () => {
    const fixture = capturedBatches[0]!;
    const invalidations: ReplayInvalidation[] = [];
    const { replay, accept } = capturedReplay(fixture, event => invalidations.push(event));
    for (const record of fixture.records.filter(record => record.sequence <= 2267)) accept(record);
    // Simulate an upstream omission with a continuous local journal: omit the .637 cancellation,
    // but retain later same-batch removals and the next REAL source batch.
    for (const record of fixture.records.filter(record => record.sequence >= 2269)) {
      expect(accept(record).quotes).toEqual([]);
    }
    expect(invalidations.filter(event => event.reason.startsWith("persistent_"))).toHaveLength(2);
    expect(invalidations.some(event => event.reason === "snapshot_required")).toBe(false);
    expect(replay.quality.bookConsistency).toMatchObject({
      provisionalInvalidations: 2, recoveredByDelta: 0, persistentInvalidations: 2, withheldDeltaUpdates: 8
    });
    for (const book of fixture.checkpoint.data as Array<{ asset_id: string }>) expect(replay.getBookStatus("clob-0-e1", book.asset_id)).toBe("invalid");
    // A later captured full snapshot, not a guessed missing delta, restores each token.
    for (const record of capturedBatches[2]!.records.filter(record => record.sequence >= 11777)) expect(accept(record).quotes).toHaveLength(1);
    expect(replay.quality.bookConsistency?.recoveredBySnapshot).toBe(2);
  });

  test.each(["journal_gap", "connection_gap", "malformed_delta", "unknown_frame", "invalid_snapshot"])(
    "a %s during a provisional batch still requires a fresh snapshot", damage => {
      const fixture = capturedBatches[0]!;
      const invalidations: ReplayInvalidation[] = [];
      const { replay, accept } = capturedReplay(fixture, event => invalidations.push(event));
      for (const record of fixture.records.filter(record => record.sequence <= 2267)) accept(record);
      const next = fixture.records.find(record => record.sequence === 2268)!;
      if (damage === "journal_gap") {
        expect(accept(next, 1).quotes).toEqual([]);
      } else {
        const frame = JSON.parse(next.data as string) as { price_changes: Array<Record<string, unknown>> };
        const token = frame.price_changes[0]!.asset_id;
        let data: unknown;
        if (damage === "connection_gap") data = {};
        else if (damage === "malformed_delta") data = { ...frame, price_changes: frame.price_changes.map(change => ({ ...change, size: "broken" })) };
        else if (damage === "unknown_frame") data = { event_type: "unknown_depth_change" };
        else data = (fixture.checkpoint.data as Array<Record<string, unknown>>).map(book => ({ ...book, bids: book.asks, timestamp: "1789156413830" }));
        expect(accept({ ...next, ...(damage === "connection_gap" ? { source: "collector" as const, kind: "connection_gap" } : {}), data }).quotes).toEqual([]);
        expect(accept(next).quotes).toEqual([]);
        expect(replay.getBookStatus("clob-0-e1", String(token))).toBe("invalid");
      }
      expect(invalidations.some(event => event.reason === "snapshot_required" || event.reason === "book_not_allowed")).toBe(true);
      expect(replay.quality.bookConsistency?.recoveredByDelta).toBe(0);
    }
  );

  test("ending an excerpt mid-batch keeps its unresolved books invalid", () => {
    const fixture = capturedBatches[1]!;
    const { replay, accept } = capturedReplay(fixture);
    for (const record of fixture.records.filter(record => record.sequence <= 6225)) accept(record);
    for (const book of fixture.checkpoint.data as Array<{ asset_id: string }>) expect(replay.getBookStatus("clob-0-e1", book.asset_id)).toBe("invalid");
    expect(replay.quality.bookConsistency).toMatchObject({ provisionalInvalidations: 2, recoveredByDelta: 0, withheldDeltaUpdates: 6 });
  });
});


describe("replay validity observability", () => {
  test("reads missing, valid and invalid book status without changing replay state", () => {
    const invalidations: ReplayInvalidation[] = [];
    const replay = new JournalReplay({ onInvalidation: event => invalidations.push(event) });
    expect(replay.getBookStatus).toBeTypeOf("function");
    expect(replay.getBookStatus("clob-0-e1", "t")).toBe("missing");
    replay.accept(ws(1, book()));
    expect(replay.getBookStatus("clob-0-e1", "t")).toBe("valid");
    replay.accept(ws(2, { event_type: "book", asset_id: "t" }));
    expect(replay.getBookStatus("clob-0-e1", "t")).toBe("invalid");
    expect(replay.accept(ws(3, change("0.6", "2"))).quotes).toEqual([]);
    expect(replay.getBookStatus("clob-0-e1", "t")).toBe("invalid");
    replay.accept(ws(4, book("0.5", "3", "4000")));
    expect(replay.getBookStatus("clob-0-e1", "t")).toBe("valid");
    const qualityBeforeReads = JSON.stringify(replay.quality);
    const notificationsBeforeReads = invalidations.length;
    expect(replay.getBookStatus("clob-0-e1", "unseen")).toBe("missing");
    expect(replay.getBookStatus("unseen", "t")).toBe("missing");
    expect(JSON.stringify(replay.quality)).toBe(qualityBeforeReads);
    expect(invalidations).toHaveLength(notificationsBeforeReads);
  });

  test("status respects subscription and connection gates until a fresh snapshot arrives", () => {
    const replay = new JournalReplay();
    expect(replay.getBookStatus).toBeTypeOf("function");
    replay.accept(rec(1, "collector", "subscription", { type: "market", assets_ids: ["t"] }, "clob-0-e1"));
    expect(replay.getBookStatus("clob-0-e1", "t")).toBe("missing");
    expect(replay.getBookStatus("clob-0-e1", "other")).toBe("invalid");
    replay.accept(ws(2, book()));
    replay.accept(rec(3, "collector", "subscription", { operation: "unsubscribe", assets_ids: ["t"] }, "clob-0-e1"));
    expect(replay.getBookStatus("clob-0-e1", "t")).toBe("invalid");
    replay.accept(rec(4, "collector", "subscription", { operation: "subscribe", assets_ids: ["t"] }, "clob-0-e1"));
    expect(replay.getBookStatus("clob-0-e1", "t")).toBe("missing");
    replay.accept(ws(5, change("0.6", "2")));
    expect(replay.getBookStatus("clob-0-e1", "t")).toBe("missing");
    replay.accept(ws(6, book()));
    replay.accept(rec(7, "collector", "connection_close", {}, "clob-0-e1"));
    expect(replay.getBookStatus("clob-0-e1", "t")).toBe("invalid");
    replay.accept(ws(8, book()));
    expect(replay.getBookStatus("clob-0-e1", "t")).toBe("invalid");
    replay.accept(rec(9, "collector", "connection_open", {}, "clob-0-e1"));
    expect(replay.getBookStatus("clob-0-e1", "t")).toBe("missing");
  });

  test("synchronously reports global sequence damage at the caller's current record", () => {
    const events: Array<{ sequence: number; event: ReplayInvalidation }> = [];
    let currentSequence = 0;
    const replay = new JournalReplay({ onInvalidation: event => events.push({ sequence: currentSequence, event }) });
    for (const record of [ws(1, book()), ws(2, book(), "clob-1-e1"), ws(4, "PONG")]) {
      currentSequence = record.sequence;
      replay.accept(record);
    }
    expect(events).toEqual([{ sequence: 4, event: { reason: "sequence_gap" } }]);
    expect(replay.getBookStatus("clob-0-e1", "t")).toBe("invalid");
    expect(replay.getBookStatus("clob-1-e1", "t")).toBe("invalid");
  });

  test.each([
    ["malformed snapshot", { event_type: "book", asset_id: "t" }, "t", "malformed_snapshot"],
    ["malformed delta", change("0.6", "bad"), "t", "malformed_delta"],
    ["older snapshot", book("0.7", "4", "500"), "t", "out_of_order_snapshot"],
    ["older delta", change("0.6", "2", "500"), "t", "out_of_order_delta"],
    ["unknown token mutation", { event_type: "future_mutation", asset_id: "t" }, "t", "unknown_frame"],
    ["unparseable frame", '{"event_type":', undefined, "malformed_frame"],
    ["unscoped delta", { event_type: "price_change", price_changes: [{ price: "0.5", size: "2", side: "BUY" }] }, undefined, "malformed_delta"]
  ] as const)("notifies the exact affected scope for %s", (_name, frame, tokenId, reason) => {
    const invalidations: ReplayInvalidation[] = [];
    const replay = new JournalReplay({ onInvalidation: event => invalidations.push(event) });
    replay.accept(ws(1, [book(), { ...book(), asset_id: "other" }]));
    replay.accept(ws(2, book(), "clob-1-e1"));
    replay.accept(ws(3, frame));
    expect(invalidations).toEqual([{ connectionId: "clob-0-e1", ...(tokenId ? { tokenId } : {}), reason }]);
    expect(replay.getBookStatus("clob-0-e1", "t")).toBe("invalid");
    expect(replay.getBookStatus("clob-0-e1", "other")).toBe(tokenId ? "valid" : "invalid");
    expect(replay.getBookStatus("clob-1-e1", "t")).toBe("valid");
  });

  test.each(["connection_close", "connection_gap", "connection_timeout", "heartbeat_timeout", "connection_open"])(
    "notifies only the connection affected by %s", kind => {
      const invalidations: ReplayInvalidation[] = [];
      const replay = new JournalReplay({ onInvalidation: event => invalidations.push(event) });
      replay.accept(ws(1, book()));
      replay.accept(ws(2, book(), "clob-1-e1"));
      replay.accept(rec(3, "collector", kind, {}, "clob-0-e1"));
      expect(invalidations).toEqual([{ connectionId: "clob-0-e1", reason: kind }]);
      expect(replay.getBookStatus("clob-0-e1", "t")).toBe(kind === "connection_open" ? "missing" : "invalid");
      expect(replay.getBookStatus("clob-1-e1", "t")).toBe("valid");
    }
  );

  test.each(["market", "subscribe", "unsubscribe"])("notifies the scope reset by a %s subscription", operation => {
    const invalidations: ReplayInvalidation[] = [];
    const replay = new JournalReplay({ onInvalidation: event => invalidations.push(event) });
    replay.accept(rec(1, "collector", "subscription", { type: "market", assets_ids: ["t", "other"] }, "clob-0-e1"));
    replay.accept(ws(2, [book(), { ...book(), asset_id: "other" }]));
    replay.accept(ws(3, book(), "clob-1-e1"));
    invalidations.length = 0;
    replay.accept(rec(4, "collector", "subscription", { assets_ids: ["t"], ...(operation === "market" ? { type: "market" } : { operation }) }, "clob-0-e1"));
    expect(invalidations).toEqual([{
      connectionId: "clob-0-e1", ...(operation === "market" ? {} : { tokenId: "t" }),
      reason: operation === "unsubscribe" ? "unsubscribe" : "subscription_reset"
    }]);
    expect(replay.getBookStatus("clob-0-e1", "t")).toBe(operation === "unsubscribe" ? "invalid" : "missing");
    expect(replay.getBookStatus("clob-0-e1", "other")).toBe(operation === "market" ? "invalid" : "valid");
    expect(replay.getBookStatus("clob-1-e1", "t")).toBe("valid");
  });

  test("publishes an array's earlier book, invalidation and later recovery in receipt order", () => {
    const trace: string[] = [];
    const replay = new JournalReplay({ onInvalidation: event => trace.push(`invalid:${event.reason}:${event.tokenId ?? "*"}`) });
    for (const batch of replay.replay(ws(1, [book(), null, change("0.6", "2"), book("0.5", "3", "4000"), change("0.4", "2", "5000")]))) {
      for (const quote of batch.quotes) trace.push(`quote:${quote.frameIndex}`);
    }
    expect(trace).toEqual(["quote:0", "invalid:malformed_frame:*", "invalid:snapshot_required:t", "quote:3", "quote:4"]);
    expect(replay.getBookStatus("clob-0-e1", "t")).toBe("valid");
  });

  test.each(["sequence", "monotonic", "run", "envelope"])("invalidates globally before rejecting damaged journal %s", damage => {
    const invalidations: ReplayInvalidation[] = [];
    const replay = new JournalReplay({ onInvalidation: event => invalidations.push(event) });
    replay.accept(ws(1, book()));
    const record = ws(2, book());
    if (damage === "sequence") record.sequence = 1;
    if (damage === "monotonic") record.monotonicNs = "0";
    if (damage === "run") record.runId = "another-run";
    if (damage === "envelope") record.sequence = 1.5;
    expect(() => replay.accept(record)).toThrow(/REPLAY_/);
    expect(invalidations).toEqual([{ reason: `journal_${damage}_invalid` }]);
    expect(replay.getBookStatus("clob-0-e1", "t")).toBe("invalid");
  });

  test.each(["{broken\n", "{unterminated"])("reports journal reader damage globally and preserves bytes: %j", async damage => {
    const root = await mkdtemp(join(tmpdir(), "poly-replay-damage-"));
    try {
      const file = join(root, "2026-09-10-000000.ndjson");
      const contents = JSON.stringify(ws(1, book())) + "\n" + damage;
      await writeFile(file, contents);
      const invalidations: ReplayInvalidation[] = [];
      const result = await readJournalRecords(root, { onInvalidation: event => invalidations.push(event) });
      expect(invalidations).toEqual([{ reason: "journal_damage" }]);
      expect(result.records).toEqual([ws(1, book())]);
      expect(await readFile(file, "utf8")).toBe(contents);
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(root, { recursive: true });
    }
  });
});

describe("replay source hashes", () => {
  test("marks snapshots and deltas and clears a prior hash on an unhashed mutation", () => {
    const result = replayRecords([
      ws(1, { ...book(), hash: "snapshot-hash" }),
      ws(2, { event_type: "price_change", price_changes: [{ asset_id: "t", side: "SELL", price: "0.6", size: "2", hash: "delta-hash" }] }),
      ws(3, change("0.5", "3")),
      ws(4, { ...book("0.5", "3", "4000"), hash: "replacement-hash" }),
      ws(5, book("0.5", "3", "5000"))
    ]);
    expect(result.quotes.map(quote => quote.updateKind)).toEqual(["snapshot", "delta", "delta", "snapshot", "snapshot"]);
    expect(result.quotes.map(quote => quote.bookHash)).toEqual(["snapshot-hash", "delta-hash", undefined, "replacement-hash", undefined]);
    expect(Object.hasOwn(result.quotes[2]!, "bookHash")).toBe(false);
    expect(Object.hasOwn(result.quotes[4]!, "bookHash")).toBe(false);
  });

  test("uses each token group's last mutation hash without borrowing a sibling's hash", () => {
    const result = replayRecords([
      ws(1, [book(), { ...book(), asset_id: "other" }]),
      ws(2, { event_type: "price_change", price_changes: [
        { asset_id: "t", side: "SELL", price: "0.6", size: "2", hash: "t-intermediate" },
        { asset_id: "other", side: "SELL", price: "0.6", size: "3", hash: "other-current" },
        { asset_id: "t", side: "SELL", price: "0.5", size: "4", hash: "t-current" }
      ] })
    ]);
    expect(result.quotes.filter(quote => quote.sequence === 2).map(quote => [quote.tokenId, quote.bookHash])).toEqual([["t", "t-current"], ["other", "other-current"]]);
  });

  test("clears an earlier hash within a group when its last mutation has no hash", () => {
    const result = replayRecords([
      ws(1, { ...book(), hash: "snapshot-hash" }),
      ws(2, { event_type: "price_change", price_changes: [
        { asset_id: "t", side: "SELL", price: "0.6", size: "2", hash: "intermediate" },
        { asset_id: "t", side: "SELL", price: "0.7", size: "0" }
      ] })
    ]);
    expect(result.quotes[0]?.bookHash).toBe("snapshot-hash");
    expect(result.quotes[1]).toMatchObject({ updateKind: "delta", asks: [{ price: "0.6", size: "2" }] });
    expect(Object.hasOwn(result.quotes[1]!, "bookHash")).toBe(false);
  });

  test("HTTP snapshots neither initialize, mutate nor recover websocket depth", () => {
    const replay = new JournalReplay();
    expect(replay.getBookStatus).toBeTypeOf("function");
    const http = (sequence: number) => rec(sequence, "clob", "book_snapshot", {
      tokenId: "t", response: { ...book("0.01", "999", "9999"), hash: "http-hash" }
    });
    expect(replay.accept(http(1)).quotes).toEqual([]);
    expect(replay.getBookStatus("clob-0-e1", "t")).toBe("missing");
    replay.accept(ws(2, { ...book(), hash: "ws-hash" }));
    expect(replay.accept(http(3)).quotes).toEqual([]);
    expect(replay.getBookStatus("clob-0-e1", "t")).toBe("valid");
    const batch = replay.accept(ws(4, change("0.6", "2")));
    expect(batch.quotes[0]?.asks).toEqual([{ price: "0.6", size: "2" }, { price: "0.70", size: "4" }]);
    expect(batch.quotes[0]?.bookHash).toBeUndefined();
    replay.accept(ws(5, { event_type: "book", asset_id: "t" }));
    replay.accept(http(6));
    expect(replay.getBookStatus("clob-0-e1", "t")).toBe("invalid");
  });
});

describe("replay full-depth consistency", () => {
  test.each(["0.7000", "0.80"])("rejects a locked/crossed snapshot with best bid %s until a fresh snapshot", bid => {
    const invalidations: ReplayInvalidation[] = [];
    const result = replayRecords([
      ws(1, twoSidedBook()),
      ws(2, { ...book("0.70", "4", "2000"), bids: [{ price: bid, size: "2" }] }),
      ws(3, change("0.6", "3", "3000")), ws(4, { ...twoSidedBook(), timestamp: "4000" })
    ], { onInvalidation: event => invalidations.push(event) });
    expect(result.quotes.map(quote => quote.sequence)).toEqual([1, 4]);
    expect(invalidations[0]).toEqual({ connectionId: "clob-0-e1", tokenId: "t", reason: "crossed_book" });
  });

  test.each(["0.70", "0.80"])("a delta that locks/crosses at %s invalidates only its token", price => {
    const invalidations: ReplayInvalidation[] = [];
    const result = replayRecords([
      ws(1, [twoSidedBook(), { ...twoSidedBook(), asset_id: "other" }]),
      ws(2, { event_type: "price_change", price_changes: [
        { asset_id: "t", side: "BUY", price, size: "2" },
        { asset_id: "other", side: "SELL", price: "0.6", size: "3" }
      ] }),
      ws(3, change("0.6", "3")), ws(4, { ...twoSidedBook(), timestamp: "4000" })
    ], { onInvalidation: event => invalidations.push(event) });
    expect(result.quotes.map(quote => [quote.sequence, quote.tokenId])).toEqual([[1, "t"], [1, "other"], [2, "other"], [4, "t"]]);
    expect(invalidations[0]).toEqual({ connectionId: "clob-0-e1", tokenId: "t", reason: "crossed_book" });
  });

  test("checks spread and advertised best prices after the complete token group", () => {
    const invalidations: ReplayInvalidation[] = [];
    const result = replayRecords([ws(1, twoSidedBook()), ws(2, { event_type: "price_change", price_changes: [
      { asset_id: "t", side: "BUY", price: "0.75", size: "2", best_bid: "0.7500", best_ask: "0.80" },
      { asset_id: "t", side: "SELL", price: "0.70", size: "0", best_bid: "0.75", best_ask: "0.8" },
      { asset_id: "t", side: "SELL", price: "0.80", size: "3", best_bid: "0.75", best_ask: "0.8" }
    ] })], { onInvalidation: event => invalidations.push(event) });
    expect(result.quotes.map(quote => quote.sequence)).toEqual([1, 2]);
    expect(result.quotes[1]?.bids[0]?.price).toBe("0.75");
    expect(result.quotes[1]?.asks).toEqual([{ price: "0.80", size: "3" }]);
    expect(invalidations).toEqual([]);
  });

  test("compares close decimal prices without rounding a valid spread into a lock", () => {
    const result = replayRecords([ws(1, {
      ...book("0.50000000000000000002"), bids: [{ price: "0.50000000000000000001", size: "1" }],
      best_bid: "0.50000000000000000001", best_ask: "0.50000000000000000002"
    })]);
    expect(result.quotes).toHaveLength(1);
    expect(result.quality.invalidBookUpdates).toBe(0);
  });

  test.each([
    ["best_bid", "0.5", "best_bid_mismatch"], ["best_ask", "0.8", "best_ask_mismatch"],
    ["best_bid", "NaN", "malformed_best_bid"], ["best_ask", "bad", "malformed_best_ask"]
  ])("rejects a snapshot advertising %s=%s", (field, value, reason) => {
    const invalidations: ReplayInvalidation[] = [];
    const result = replayRecords([ws(1, { ...twoSidedBook(), [field!]: value })], { onInvalidation: event => invalidations.push(event) });
    expect(result.quotes).toEqual([]);
    expect(invalidations).toEqual([{ connectionId: "clob-0-e1", tokenId: "t", reason }]);
  });

  test.each([["best_bid", "0.5"], ["best_ask", "0.7"]])("rejects post-group delta contradictions for %s", (field, value) => {
    const invalidations: ReplayInvalidation[] = [];
    const result = replayRecords([ws(1, twoSidedBook()), ws(2, { event_type: "price_change", price_changes: [
      { asset_id: "t", side: "SELL", price: "0.6", size: "2", [field!]: value }
    ] }), ws(3, change("0.5", "2"))], { onInvalidation: event => invalidations.push(event) });
    expect(result.quotes.map(quote => quote.sequence)).toEqual([1]);
    expect(invalidations[0]).toEqual({ connectionId: "clob-0-e1", tokenId: "t", reason: `${field}_mismatch` });
  });

  test("compares only the last post-group top with the final atomic book", () => {
    const invalidations: ReplayInvalidation[] = [];
    const result = replayRecords([ws(1, twoSidedBook()), ws(2, { event_type: "price_change", price_changes: [
      { asset_id: "t", side: "SELL", price: "0.6", size: "2", best_ask: "0.6" },
      { asset_id: "t", side: "SELL", price: "0.5", size: "3", best_ask: "0.5" }
    ] })], { onInvalidation: event => invalidations.push(event) });
    expect(result.quotes.map(quote => quote.sequence)).toEqual([1, 2]);
    expect(result.quotes[1]?.asks[0]?.price).toBe("0.5");
    expect(invalidations).toEqual([]);
  });

  test("does not reuse an intermediate top when the final change has no advertisement", () => {
    const result = replayRecords([ws(1, twoSidedBook()), ws(2, { event_type: "price_change", price_changes: [
      { asset_id: "t", side: "SELL", price: "0.6", size: "2", best_ask: "0.6" },
      { asset_id: "t", side: "SELL", price: "0.5", size: "3" }
    ] })]);
    expect(result.quotes.map(quote => quote.sequence)).toEqual([1, 2]);
    expect(result.quotes[1]?.asks[0]?.price).toBe("0.5");
  });

  test.each([false, true])("checks frame-level best prices for an identified token (sibling present: %s)", sibling => {
    const invalidations: ReplayInvalidation[] = [];
    const result = replayRecords([
      ws(1, [twoSidedBook(), { ...twoSidedBook(), asset_id: "other" }]),
      ws(2, { event_type: "price_change", ...(sibling ? { asset_id: "t" } : {}), best_ask: "0.7", price_changes: [
        { asset_id: "t", side: "SELL", price: "0.6", size: "2" },
        ...(sibling ? [{ asset_id: "other", side: "SELL", price: "0.6", size: "2" }] : [])
      ] })
    ], { onInvalidation: event => invalidations.push(event) });
    expect(result.quotes.filter(quote => quote.sequence === 2).map(quote => quote.tokenId)).toEqual(sibling ? ["other"] : []);
    expect(invalidations).toEqual([{ connectionId: "clob-0-e1", tokenId: "t", reason: "best_ask_mismatch" }]);
  });

  test.each([
    { ...twoSidedBook(), timestamp: "4000", bids: [{ price: "0.8", size: "2" }] },
    { ...twoSidedBook(), timestamp: "4000", asks: "malformed" },
    change("0.6", "malformed", "4000"),
    { event_type: "price_change", price_changes: [
      { asset_id: "t", side: "SELL", price: "0.6", size: "2", timestamp: "4000" },
      { asset_id: "t", side: "SELL", price: "0.5", size: "2", timestamp: "2000" }
    ] }
  ])("requires recovery to respect timestamps observed in a rejected update: %j", badFrame => {
    const result = replayRecords([
      ws(1, twoSidedBook()), ws(2, badFrame),
      ws(3, { ...twoSidedBook(), timestamp: "3000" }), ws(4, { ...twoSidedBook(), timestamp: "5000" })
    ]);
    expect(result.quotes.map(quote => quote.sequence)).toEqual([1, 4]);
  });

  test("updates the source watermark while deltas await a recovery snapshot", () => {
    const result = replayRecords([
      ws(1, twoSidedBook()), ws(2, { event_type: "future_mutation", asset_id: "t" }),
      ws(3, change("0.6", "2", "4000")),
      ws(4, { ...twoSidedBook(), timestamp: "3000" }), ws(5, { ...twoSidedBook(), timestamp: "5000" })
    ]);
    expect(result.quotes.map(quote => quote.sequence)).toEqual([1, 5]);
  });

  test.each([["best_bid", "0"], ["best_ask", "1"]])("preserves confirmed empty depth with advertised %s without inferring a level", (field, value) => {
    const invalidations: ReplayInvalidation[] = [];
    const result = replayRecords([ws(1, { ...book(), bids: [], asks: [], [field!]: value })], { onInvalidation: event => invalidations.push(event) });
    expect(result.quotes).toHaveLength(1);
    expect(result.quotes[0]).toMatchObject({ bids: [], asks: [] });
    expect(invalidations).toEqual([]);
  });

  test("preserves a quiet empty ask side for the official price_change example's best_ask=1", () => {
    const invalidations: ReplayInvalidation[] = [];
    const replay = new JournalReplay({ onInvalidation: event => invalidations.push(event) });
    replay.accept(ws(1, { ...twoSidedBook(), asks: [] }));
    // https://docs.polymarket.com/api-reference/wss/market includes this boundary best_ask.
    const batch = replay.accept(ws(2, { event_type: "price_change", timestamp: "2000", price_changes: [
      { asset_id: "t", side: "BUY", price: "0.5", size: "200", best_bid: "0.5", best_ask: "1", hash: "current-hash" }
    ] }));
    expect(batch.quotes).toHaveLength(1);
    expect(batch.quotes[0]).toMatchObject({ asks: [], bookHash: "current-hash", updateKind: "delta" });
    expect(replay.accept(ws(3, { event_type: "best_bid_ask", asset_id: "t", best_bid: "0.5", best_ask: "1" })).quotes).toEqual([]);
    expect(replay.getBookStatus("clob-0-e1", "t")).toBe("valid");
    expect(invalidations).toEqual([]);
  });

  test("does not manufacture an ask when a delta removes the last ask and advertises 1", () => {
    const result = replayRecords([ws(1, twoSidedBook()), ws(2, { event_type: "price_change", price_changes: [
      { asset_id: "t", side: "SELL", price: "0.7", size: "0", best_bid: "0.4", best_ask: "1" }
    ] })]);
    expect(result.quotes.map(quote => quote.sequence)).toEqual([1, 2]);
    expect(result.quotes[1]?.asks).toEqual([]);
    expect(result.quality.invalidBookUpdates).toBe(0);
  });

  test.each(["best_bid", "best_ask"])("still rejects malformed %s values on empty depth", field => {
    const invalidations: ReplayInvalidation[] = [];
    const result = replayRecords([ws(1, { ...book(), bids: [], asks: [], [field]: "NaN" })], { onInvalidation: event => invalidations.push(event) });
    expect(result.quotes).toEqual([]);
    expect(invalidations).toEqual([{ connectionId: "clob-0-e1", tokenId: "t", reason: `malformed_${field}` }]);
  });

  test.each([undefined, "3000"])("standalone best prices arriving ahead of depth do not invalidate or advance source time: %s", timestamp => {
    const invalidations: ReplayInvalidation[] = [];
    const replay = new JournalReplay({ onInvalidation: event => invalidations.push(event) });
    const top = { event_type: "best_bid_ask", asset_id: "t", best_bid: "0.4", best_ask: "0.6", timestamp, hash: "top-only" };
    expect(replay.accept(ws(1, top)).quotes).toEqual([]);
    expect(replay.getBookStatus("clob-0-e1", "t")).toBe("missing");
    replay.accept(ws(2, { ...twoSidedBook(), hash: "snapshot" }));
    expect(replay.accept(ws(3, top)).quotes).toEqual([]);
    expect(replay.getBookStatus("clob-0-e1", "t")).toBe("valid");
    const batch = replay.accept(ws(4, change("0.6", "2", "2000")));
    expect(batch.quotes).toHaveLength(1);
    expect(batch.quotes[0]?.asks).toEqual([{ price: "0.6", size: "2" }, { price: "0.70", size: "4" }]);
    expect(batch.quotes[0]?.bookHash).toBeUndefined();
    expect(invalidations).toEqual([]);
    expect(replay.quality.invalidBookUpdates).toBe(0);
  });

  test("retains an offending raw book in the journal and read result", async () => {
    const root = await mkdtemp(join(tmpdir(), "poly-replay-crossed-"));
    try {
      const file = join(root, "2026-09-10-000000.ndjson");
      const records = [ws(1, twoSidedBook()), ws(2, { ...book(), bids: [{ price: "0.8", size: "2" }], hash: "offending" })];
      const contents = records.map(record => JSON.stringify(record)).join("\n") + "\n";
      await writeFile(file, contents);
      const result = await readJournalRecords(root);
      expect(result.quotes.map(quote => quote.sequence)).toEqual([1]);
      expect(result.records).toEqual(records);
      expect(await readFile(file, "utf8")).toBe(contents);
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(root, { recursive: true });
    }
  });
});

describe("replay market resolution scope", () => {
  test.each([
    { assets_ids: ["t", "t"] }, { conditionId: "closed-condition" },
    { condition_id: "closed-condition" }, { market: "closed-condition" }
  ])("invalidates only the resolved market while an unrelated book keeps updating: %j", identity => {
    const invalidations: ReplayInvalidation[] = [];
    const replay = new JournalReplay({ onInvalidation: event => invalidations.push(event) });
    replay.accept(rec(1, "gamma", "event_metadata", { normalized: { markets: [
      { marketId: "closed-market", conditionId: "closed-condition", tokenIds: ["t"], outcomes: ["Yes"] },
      { marketId: "live-market", conditionId: "live-condition", tokenIds: ["other"], outcomes: ["Yes"] }
    ] } }));
    replay.accept(ws(2, [twoSidedBook(), { ...twoSidedBook(), asset_id: "other" }]));
    const resolution = ws(3, { event_type: "market_resolved", ...identity, winning_asset_id: "t", winning_outcome: "Yes" });
    const raw = resolution.data;
    expect(replay.accept(resolution)).toEqual({ quotes: [], trades: [], sports: [] });
    expect(invalidations).toEqual([{ connectionId: "clob-0-e1", tokenId: "t", reason: "market_resolved" }]);
    expect(replay.getBookStatus("clob-0-e1", "t")).toBe("invalid");
    expect(replay.getBookStatus("clob-0-e1", "other")).toBe("valid");
    expect(replay.quality.unknownFrames).toBe(0);
    expect(replay.quality.invalidBookUpdates).toBe(0);
    const batch = replay.accept(ws(4, { event_type: "price_change", price_changes: [
      { asset_id: "t", side: "SELL", price: "0.6", size: "2" },
      { asset_id: "other", side: "SELL", price: "0.6", size: "2" }
    ] }));
    expect(batch.quotes.map(quote => quote.tokenId)).toEqual(["other"]);
    expect(resolution.data).toBe(raw);
  });

  test("condition resolution includes every mapped outcome without inferring payout depth", () => {
    const invalidations: ReplayInvalidation[] = [];
    const replay = new JournalReplay({ onInvalidation: event => invalidations.push(event) });
    replay.accept(rec(1, "gamma", "event_metadata", { normalized: { markets: [
      { conditionId: "closed-condition", tokenIds: ["t", "no"], outcomes: ["Yes", "No"] }
    ] } }));
    replay.accept(ws(2, [twoSidedBook(), { ...twoSidedBook(), asset_id: "no" }, { ...twoSidedBook(), asset_id: "other" }]));
    expect(replay.accept(ws(3, { event_type: "market_resolved", market: "closed-condition", assets_ids: ["t"], winning_asset_id: "t" })).quotes).toEqual([]);
    expect(invalidations).toEqual([
      { connectionId: "clob-0-e1", tokenId: "t", reason: "market_resolved" },
      { connectionId: "clob-0-e1", tokenId: "no", reason: "market_resolved" }
    ]);
    expect(replay.getBookStatus("clob-0-e1", "no")).toBe("invalid");
    expect(replay.getBookStatus("clob-0-e1", "other")).toBe("valid");
  });

  test("an unresolved market identity does not invalidate unrelated depth", () => {
    const invalidations: ReplayInvalidation[] = [];
    const replay = new JournalReplay({ onInvalidation: event => invalidations.push(event) });
    replay.accept(ws(1, [twoSidedBook(), { ...twoSidedBook(), asset_id: "other" }]));
    replay.accept(ws(2, { event_type: "market_resolved", market: "uncatalogued-condition" }));
    expect(invalidations).toEqual([]);
    expect(replay.getBookStatus("clob-0-e1", "t")).toBe("valid");
    expect(replay.getBookStatus("clob-0-e1", "other")).toBe("valid");
    expect(replay.quality.unknownFrames).toBe(1);
  });
});

describe("replay companion score identities", () => {
  test.each([["gameId", "game_id"], ["sportradarGameId", "sportradar_game_id"]])("matches differing companion slugs through %s", (field, alias) => {
    const result = replayRecords([
      rec(1, "gamma", "event_metadata", { normalized: {
        eventSlug: "atp-zverev-khachan-2026-09-11-exact-score", [field!]: "6210652",
        markets: [{ marketId: "exact", tokenIds: ["t"], outcomes: ["2-0"] }]
      } }),
      rec(2, "sports", "ws_message", { eventSlug: "atp-zverev-khachan-2026-09-11", [alias!]: 6210652, score: "1-0" }),
      ws(3, book())
    ]);
    expect(result.quotes[0]).toMatchObject({ sportsStatus: "matched", sportsSequence: 2, sportsScore: "1-0", outcome: "2-0" });
  });

  test.each([
    { eventSlug: "game-a", gameId: "20" },
    { eventSlug: "game-a", sportradarGameId: "200" },
    { eventSlug: "companion", gameId: "20", sportradarGameId: "100" },
    { eventSlug: "companion", gameId: "10", sportradarGameId: "200" }
  ])("never matches conflicting strong identities despite other matching keys: %j", identity => {
    const result = replayRecords([
      rec(1, "gamma", "event_metadata", { normalized: {
        eventSlug: "game-a", gameId: "10", sportradarGameId: "100",
        markets: [{ tokenIds: ["t"], outcomes: ["Yes"] }]
      } }),
      rec(2, "sports", "ws_message", { ...identity, score: "wrong-game" }), ws(3, book())
    ]);
    expect(result.quotes[0]?.sportsStatus).toBe("missing");
    expect(result.quotes[0]?.sportsScore).toBeUndefined();
  });

  test("still allows slug-only fallback when no strong identity conflicts", () => {
    const result = replayRecords([metadata(), rec(2, "sports", "ws_message", { eventSlug: "game-a", score: "1-0" }), ws(3, book())]);
    expect(result.quotes[0]).toMatchObject({ sportsStatus: "matched", sportsScore: "1-0" });
  });
});

describe("replay integrity regressions", () => {
  test("never attaches another game's score or a heartbeat to a quote", () => {
    for (const sports of [{ eventSlug: "game-b", gameId: 20, score: "4-0" }, "ping"]) {
      const result = replayRecords([metadata(), rec(2, "sports", "ws_message", JSON.stringify(sports)), ws(3, book())]);
      expect(result.quotes[0]?.sportsSequence).toBeUndefined();
    }
  });

  test("normalizes slug and game_id aliases and keeps the last matching correction", () => {
    const result = replayRecords([
      metadata(),
      rec(2, "sports", "ws_message", JSON.stringify({ slug: "game-a", game_id: "10", score: "2-0", elapsed: "89:10" })),
      ws(3, book()),
      rec(4, "sports", "ws_message", JSON.stringify({ slug: "game-a", game_id: "10", score: "1-0", elapsed: "89:15" })),
      rec(5, "sports", "ws_message", JSON.stringify({ slug: "game-b", score: "4-0" })),
      ws(6, change("0.60", "1"))
    ]);
    expect(result.quotes.map(quote => quote.sportsSequence)).toEqual([2, 4]);
    expect(result.quotes.map(quote => quote.sportsAgeMs)).toEqual([1000, 2000]);
  });

  test("sports age uses monotonic time across wall-clock rollback and exposes missing/stale clocks", () => {
    const score = rec(2, "sports", "ws_message", JSON.stringify({ game_id: "10", score: "2-0" }), "sports-0-e1");
    const quote = { ...ws(3, book()), receivedAtMs: 1500, receivedAt: new Date(1500).toISOString() };
    const result = replayRecords([metadata(), score, quote], { sportsStaleAfterMs: 500 });
    expect(result.quotes[0]).toMatchObject({ sportsSequence: 2, sportsAgeMs: 1000, sportsStatus: "stale", sportsClockStatus: "missing", sportsScore: "2-0" });
  });

  test("does not replace earlier quote context with future scores and marks disconnected score sources", () => {
    const result = replayRecords([
      metadata(), ws(2, book()),
      rec(3, "sports", "ws_message", JSON.stringify({ gameId: 10, score: "1-0", elapsed: "90:00" }), "sports-0-e1"),
      ws(4, change("0.6", "1")),
      rec(5, "collector", "connection_close", {}, "sports-0-e1"),
      ws(6, change("0.5", "1"))
    ]);
    expect(result.quotes.map(quote => quote.sportsStatus)).toEqual(["missing", "matched", "disconnected"]);
    expect(result.quotes[0]?.sportsScore).toBeUndefined();
    expect(result.quotes[1]?.sportsClock).toBe("90:00");
  });

  test("canonicalizes equivalent numeric price strings for replacement and zero deletion", () => {
    const result = replayRecords([ws(1, book()), ws(2, change("0.7", "7")), ws(3, change("0.7000", "0"))]);
    expect(result.quotes[1]?.asks).toHaveLength(1);
    expect(result.quotes[1]?.asks[0]?.size).toBe("7");
    expect(result.quotes[2]?.asks).toEqual([]);
  });

  test.each([
    { event_type: "book", asset_id: "t" },
    { event_type: "book", asset_id: "t", asks: [] },
    { event_type: "book", asset_id: "t", bids: [], asks: [{ price: "NaN", size: "4" }] },
    { event_type: "book", asset_id: "t", bids: [], asks: [{ price: "0.7", size: "-1" }] },
    { event_type: "book", asset_id: "t", bids: [], asks: [{ price: "1.1", size: "4" }] }
  ])("does not initialize a usable book from invalid snapshot %j", frame => {
    const result = replayRecords([ws(1, frame), ws(2, change("0.6", "1"))]);
    expect(result.quotes).toHaveLength(0);
    expect(result.quality.invalidBookUpdates).toBeGreaterThan(0);
  });

  test.each(['{"event_type":', { event_type: "future_book_mutation", asset_id: "t" }])(
    "invalidates depth after an unparseable or unknown mutation %j", badFrame => {
      const result = replayRecords([ws(1, book()), ws(2, badFrame), ws(3, change("0.6", "3")), ws(4, book("0.5", "2", "4000"))]);
      expect(result.quotes.map(quote => quote.sequence)).toEqual([1, 4]);
    }
  );

  test("PONG and known non-depth messages do not invalidate a valid book", () => {
    const result = replayRecords([ws(1, book()), ws(2, "PONG"), ws(3, { event_type: "tick_size_change", asset_id: "t", new_tick_size: "0.01" }), ws(4, change("0.6", "3"))]);
    expect(result.quotes.map(quote => quote.sequence)).toEqual([1, 4]);
  });

  test("never publishes a partially applied delta frame when another level is malformed", () => {
    const result = replayRecords([ws(1, book()), ws(2, { event_type: "price_change", price_changes: [
      { asset_id: "t", side: "SELL", price: "0.6", size: "2" },
      { asset_id: "t", side: "SELL", price: "0.7", size: "invalid" }
    ] }), ws(3, change("0.5", "1"))]);
    expect(result.quotes.map(quote => quote.sequence)).toEqual([1]);
  });

  test("rejects an older server snapshot and requires a current full snapshot for recovery", () => {
    const result = replayRecords([ws(1, book("0.7", "4", "3000")), ws(2, book("0.99", "10", "2000")), ws(3, change("0.6", "2", "3100")), ws(4, book("0.5", "1", "4000"))]);
    expect(result.quotes.map(quote => quote.sequence)).toEqual([1, 4]);
    expect(result.quality.outOfOrderMessages).toBe(1);
  });

  test("untimed snapshots never reset the source timestamp watermark", () => {
    const untimed: Record<string, unknown> = book();
    delete untimed.timestamp;
    const result = replayRecords([ws(1, book("0.7", "4", "3000")), ws(2, untimed), ws(3, book("0.6", "2", "2000"))]);
    expect(result.quotes.map(quote => quote.sequence)).toEqual([1, 2]);
    expect(result.quotes[1]?.serverTimestamp).toBeUndefined();
    expect(result.quality.outOfOrderMessages).toBe(1);
  });

  test("validates source ordering within a single price change array before applying it", () => {
    const result = replayRecords([ws(1, book()), ws(2, { event_type: "price_change", price_changes: [
      { asset_id: "t", side: "SELL", price: "0.6", size: "1", timestamp: "3000" },
      { asset_id: "t", side: "SELL", price: "0.5", size: "2", timestamp: "2000" }
    ] })]);
    expect(result.quotes.map(quote => quote.sequence)).toEqual([1]);
    expect(result.quality.outOfOrderMessages).toBe(1);
  });

  test("requires fresh full depth after unsubscribe and resubscribe on the same connection", () => {
    const result = replayRecords([
      ws(1, book()),
      rec(2, "collector", "subscription", { assets_ids: ["t"], operation: "unsubscribe" }, "clob-0-e1"),
      rec(3, "collector", "subscription", { assets_ids: ["t"], operation: "subscribe" }, "clob-0-e1"),
      ws(4, change("0.6", "2")), ws(5, book("0.5", "1", "4000"))
    ]);
    expect(result.quotes.map(quote => quote.sequence)).toEqual([1, 5]);
  });

  test("subscribing a new token keeps untouched token depth valid", () => {
    const result = replayRecords([
      rec(1, "collector", "subscription", { assets_ids: ["t"], type: "market" }, "clob-0-e1"),
      ws(2, book()),
      rec(3, "collector", "subscription", { assets_ids: ["other"], operation: "subscribe" }, "clob-0-e1"),
      ws(4, change("0.6", "2"))
    ]);
    expect(result.quotes.map(quote => quote.sequence)).toEqual([2, 4]);
  });

  test.each(["book", "delta"])("a retired token's in-flight %s does not invalidate another active token", kind => {
    const result = replayRecords([
      rec(1, "collector", "subscription", { assets_ids: ["t", "retired"], type: "market" }, "clob-0-e1"),
      ws(2, [book(), { ...book(), asset_id: "retired" }]),
      rec(3, "collector", "subscription", { assets_ids: ["retired"], operation: "unsubscribe" }, "clob-0-e1"),
      ws(4, kind === "book" ? { ...book(), asset_id: "retired" } : {
        event_type: "price_change", price_changes: [
          { asset_id: "t", side: "SELL", price: "0.6", size: "2" },
          { asset_id: "retired", side: "SELL", price: "0.6", size: "2" }
        ]
      }),
      ws(5, change("0.5", "1"))
    ]);
    expect(result.quotes.filter(quote => quote.tokenId === "t").map(quote => quote.sequence)).toEqual(kind === "book" ? [2, 5] : [2, 4, 5]);
  });

  test("one token awaiting a snapshot does not suppress a valid sibling's delta", () => {
    const result = replayRecords([
      ws(1, book()),
      ws(2, { event_type: "price_change", price_changes: [
        { asset_id: "t", side: "SELL", price: "0.6", size: "2" },
        { asset_id: "new", side: "SELL", price: "0.6", size: "2" }
      ] })
    ]);
    expect(result.quotes.map(quote => quote.sequence)).toEqual([1, 2]);
  });

  test("round trips journal segments across a UTC date rollback without reordering", async () => {
    const root = await mkdtemp(join(tmpdir(), "poly-date-replay-"));
    const dates = ["2026-09-10T23:59:59.900Z", "2026-09-11T00:00:00.100Z", "2026-09-10T23:59:59.950Z"];
    let index = 0;
    const journal = await createJournal({ rootDir: root, runId: "rollback", now: () => new Date(dates[index++]!), monotonicNs: () => BigInt(index) * 1_000_000_000n });
    try {
      journal.record({ source: "collector", kind: "session_start", data: {} });
      journal.record({ source: "clob", kind: "ws_message", connectionId: "clob-0-e1", data: JSON.stringify(book()) });
      journal.record({ source: "clob", kind: "ws_message", connectionId: "clob-0-e1", data: JSON.stringify(change("0.6", "2")) });
      await journal.close();
      const result = await readJournalRecords(journal.runDirectory);
      expect(result.records.map(record => record.sequence)).toEqual([1, 2, 3]);
      expect(result.quotes).toHaveLength(2);
    } finally {
      await journal.close().catch(() => {});
      const { rm } = await import("node:fs/promises");
      await rm(root, { recursive: true });
    }
  });

  test("a late book from a closed connection cannot reactivate it", () => {
    const result = replayRecords([ws(1, book()), rec(2, "collector", "connection_close", {}, "clob-0-e1"), ws(3, book()), ws(4, book(), "clob-0-e2")]);
    expect(result.quotes.map(quote => quote.sequence)).toEqual([1, 4]);
  });

  test("rejects mixed run IDs and invalid journal envelope numbers", () => {
    expect(() => replayRecords([ws(1, book()), { ...ws(2, change("0.6", "1")), runId: "different" }])).toThrow(/RUN/);
    expect(() => replayRecords([{ ...ws(1, book()), sequence: 1.5 }])).toThrow(/RECORD/);
    expect(() => replayRecords([{ ...ws(1, book()), schemaVersion: 2 } as unknown as ReplayJournalRecord])).toThrow(/RECORD/);
    expect(() => replayRecords([{ ...ws(1, book()), source: ["clob"] } as unknown as ReplayJournalRecord])).toThrow(/RECORD/);
  });

  test("excludes an unterminated tail from usable history, and invalidates after malformed complete lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "poly-replay-integrity-"));
    // Files are disposable synthetic fixtures; no user journal is modified.
    try {
      await writeFile(join(root, "2026-09-10-000000.ndjson"), [JSON.stringify(ws(1, book())), "{broken", JSON.stringify(ws(3, change("0.6", "3")))].join("\n") + "\n" + JSON.stringify(ws(4, book("0.5", "1", "4000"))));
      const result = await readJournalRecords(root);
      expect(result.quotes.map(quote => quote.sequence)).toEqual([1]);
      expect(result.quality.malformedLines).toBe(1);
      expect(result.quality.incompleteFinalLines).toBe(1);
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(root, { recursive: true });
    }
  });
});
