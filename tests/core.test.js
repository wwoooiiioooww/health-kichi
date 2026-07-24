/**
 * ヘルスきち core.js テスト(依存なし・Nodeで実行)
 *   node tests/core.test.js
 *
 * 方針(review-core): 「動作確認」ではなく「過去/今回の不具合の再発防止」を主目的に、
 * ロジックの境界値と後方互換(migrate)を固める。
 */
"use strict";
const HK = require("../core.js");

let passed = 0, failed = 0;
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.error("✗ " + name + "\n    " + (e && e.message || e)); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function assertEq(actual, expected, msg) {
  if (!eq(actual, expected)) throw new Error((msg || "") + "\n    expected " + JSON.stringify(expected) + "\n    got      " + JSON.stringify(actual));
}

// ---- 固定時刻ヘルパ(ローカルタイム) ----
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi || 0, 0, 0).getTime();

// ================= 日付ユーティリティ =================
test("logicalDateIso: 朝4時以降は当日", () => {
  assertEq(HK.logicalDateIso(at(2026, 7, 24, 4, 0)), "2026-07-24");
  assertEq(HK.logicalDateIso(at(2026, 7, 24, 12, 0)), "2026-07-24");
});
test("logicalDateIso: 深夜0-3時台は前日(論理日)", () => {
  assertEq(HK.logicalDateIso(at(2026, 7, 24, 2, 30)), "2026-07-23");
  assertEq(HK.logicalDateIso(at(2026, 7, 24, 3, 59)), "2026-07-23");
});
test("msFromLogicalDate: 0-3:59は翌実日に載る", () => {
  // 論理日7/23の深夜1:30 → 実時刻は7/24 01:30
  const ms = HK.msFromLogicalDate("2026-07-23", 90);
  assertEq(HK.dateIso(ms), "2026-07-24");
  assertEq(HK.hhmm(ms), "01:30");
  // 論理日を復元できる(往復)
  assertEq(HK.logicalDateIso(ms), "2026-07-23");
});
test("msFromLogicalDate: 4:00以降は同実日", () => {
  const ms = HK.msFromLogicalDate("2026-07-23", 19 * 60);
  assertEq(HK.dateIso(ms), "2026-07-23");
  assertEq(HK.hhmm(ms), "19:00");
});
test("weekStartIso: 月曜起点", () => {
  // 2026-07-24 は金曜 → 週初は 2026-07-20(月)
  assertEq(HK.weekStartIso(at(2026, 7, 24, 12, 0)), "2026-07-20");
  assertEq(HK.weekStartIso(at(2026, 7, 20, 0, 5)), "2026-07-20");
});
test("parseHHmm: 妥当/不正", () => {
  assertEq(HK.parseHHmm("21:30"), 21 * 60 + 30);
  assertEq(HK.parseHHmm("00:00"), 0);
  assertEq(HK.parseHHmm("24:00"), null);
  assertEq(HK.parseHHmm("aa:bb"), null);
});
test("countLateCoffee: 21時以降のみ計上", () => {
  assertEq(HK.countLateCoffee(["20:59", "21:00", "23:30", "07:00"]), 2);
});

// ================= チェックイン(kirokuNote含む) =================
test("setCheckin: 許可フィールドのみ受理", () => {
  const s = HK.emptyState();
  assert(HK.setCheckin(s, "2026-07-24", "mood", 4));
  assert(HK.setCheckin(s, "2026-07-24", "note", "終日客先"));
  assert(HK.setCheckin(s, "2026-07-24", "kirokuNote", "外食続き"));
  assertEq(s.checkin["2026-07-24"], { mood: 4, note: "終日客先", kirokuNote: "外食続き" });
});
test("setCheckin: 未知フィールドは拒否", () => {
  const s = HK.emptyState();
  assert(!HK.setCheckin(s, "2026-07-24", "weight", 60), "未知フィールドは false");
  assertEq(s.checkin["2026-07-24"], undefined);
});

// ================= イベント記録 =================
test("logEvent/eventsOn/delete/updateTime/setLabel", () => {
  const s = HK.emptyState();
  const id = HK.logEvent(s, "MEAL", null, at(2026, 7, 24, 20, 0), 3);
  assertEq(s.events.length, 1);
  assertEq(s.events[0].tier, 3);
  // 論理日で取得
  assertEq(HK.eventsOn(s, "2026-07-24").length, 1);
  // 店ラベルを後付け
  assert(HK.setEventLabel(s, id, "自炊"));
  assertEq(s.events[0].label, "自炊");
  // 時刻更新でソート維持
  const id2 = HK.logEvent(s, "COFFEE", null, at(2026, 7, 24, 22, 0));
  HK.updateEventTime(s, id2, at(2026, 7, 24, 7, 0));
  assert(s.events[0].t < s.events[1].t, "時刻更新後もソート済み");
  // 削除
  assert(HK.deleteEventById(s, id));
  assertEq(s.events.length, 1);
});
test("logEvent: MEALはtier既定2、深夜は前日の論理日へ", () => {
  const s = HK.emptyState();
  HK.logEvent(s, "MEAL", "麺類", at(2026, 7, 24, 2, 0)); // 深夜2時
  assertEq(s.events[0].tier, 2);
  assertEq(HK.eventsOn(s, "2026-07-23").length, 1, "深夜2時は前日の夜食");
});

// ================= 睡眠 =================
test("resolveWakeOnOpen: おやすみ→朝開くで自動記録", () => {
  const s = HK.emptyState();
  HK.markBed(s, at(2026, 7, 23, 23, 30));
  const r = HK.resolveWakeOnOpen(s, at(2026, 7, 24, 7, 0));
  assertEq(r.kind, "woke");
  assertEq(r.dateIso, "2026-07-24");
  assert(s.sleep["2026-07-24"], "sleepに起床日で記録");
  assertEq(s.pendingBed, null);
});
test("resolveWakeOnOpen: 経過が短すぎる場合は保留", () => {
  const s = HK.emptyState();
  HK.markBed(s, at(2026, 7, 24, 6, 0));
  const r = HK.resolveWakeOnOpen(s, at(2026, 7, 24, 7, 0)); // 60分
  assertEq(r.kind, "short");
  assert(s.pendingBed != null, "保留は維持");
});
test("setSleepManual & quality", () => {
  const s = HK.emptyState();
  HK.setSleepManual(s, "2026-07-24", at(2026, 7, 23, 23, 0), at(2026, 7, 24, 7, 0));
  assertEq(s.sleep["2026-07-24"].durationMin, 8 * 60);
  assert(HK.setSleepQuality(s, "2026-07-24", 3));
  assertEq(s.sleep["2026-07-24"].quality, 3);
  assert(!HK.setSleepQuality(s, "2026-01-01", 3), "記録なしの日はfalse");
});

// ================= 集計(kiroku_note含む) =================
test("buildDaySummaries: note/kirokuNoteを反映", () => {
  const s = HK.emptyState();
  const end = at(2026, 7, 24, 12, 0);
  HK.setCheckin(s, "2026-07-24", "note", "プレッシャー強い");
  HK.setCheckin(s, "2026-07-24", "kirokuNote", "食べ過ぎた");
  const days = HK.buildDaySummaries(s, end, 1);
  assertEq(days[0].note, "プレッシャー強い");
  assertEq(days[0].kirokuNote, "食べ過ぎた");
});
test("buildGeminiPayload: daysにkiroku_noteが載る", () => {
  const s = HK.emptyState();
  const end = at(2026, 7, 24, 12, 0);
  HK.setCheckin(s, "2026-07-24", "kirokuNote", "外食続き");
  const days = HK.buildDaySummaries(s, end, 3);
  const payload = HK.buildGeminiPayload(days, [], null);
  const today = payload.days.find((d) => d.date === "2026-07-24");
  assertEq(today.kiroku_note, "外食続き");
});
test("buildGeminiPayload: meal_tier_countsが種類別に集計", () => {
  const s = HK.emptyState();
  const t = at(2026, 7, 24, 20, 0);
  HK.logEvent(s, "MEAL", "魚・海鮮", t, 1);
  HK.logEvent(s, "MEAL", "ごはん", t, 2);
  HK.logEvent(s, "MEAL", "デザート", t, 3);
  const days = HK.buildDaySummaries(s, t, 1);
  const payload = HK.buildGeminiPayload(days, [], null);
  assertEq(payload.this_week_stats.meal_tier_counts, { good: 1, normal: 1, junk: 1 });
});

// ================= migrate(後方互換・非破壊) =================
test("migrate: 空でも現行スキーマ(v6)に整う", () => {
  const s = HK.migrate({});
  assertEq(s.version, 6);
  assert(Array.isArray(s.events));
  assert(s.settings && Array.isArray(s.settings.mealKinds));
});
test("migrate: 旧イベント型の変換", () => {
  const s = HK.migrate({
    events: [
      { t: 1, type: "STAIRS" },
      { t: 2, type: "HEALTH" },
      { t: 3, type: "MEAL" }
    ]
  });
  assertEq(s.events[0].type, "ACTIVITY");
  assertEq(s.events[1].type, "MEAL");
  assertEq(s.events[1].tier, 1, "HEALTH→良い食事");
  assertEq(s.events[2].tier, 2, "tier無しMEAL→ふつう");
  assert(s.events.every((e) => e.id != null), "全イベントにid付与");
});
test("migrate: 冪等(2回通しても壊れない)", () => {
  const once = HK.migrate(HK.emptyState());
  const twice = HK.migrate(JSON.parse(JSON.stringify(once)));
  assertEq(twice, once);
});
test("migrate: kirokuNoteを含むcheckinを保持(往復非破壊)", () => {
  const s0 = HK.emptyState();
  HK.setCheckin(s0, "2026-07-24", "kirokuNote", "外食続き");
  HK.setCheckin(s0, "2026-07-24", "mood", 4);
  const round = HK.migrate(JSON.parse(JSON.stringify(s0)));
  assertEq(round.checkin["2026-07-24"], { kirokuNote: "外食続き", mood: 4 });
});
test("migrate: 既存のユーザーデータ(events/sleep)を消さない", () => {
  const s0 = HK.emptyState();
  HK.logEvent(s0, "MEAL", "自炊", at(2026, 7, 24, 20, 0), 1);
  HK.setSleepManual(s0, "2026-07-24", at(2026, 7, 23, 23, 0), at(2026, 7, 24, 7, 0));
  const round = HK.migrate(JSON.parse(JSON.stringify(s0)));
  assertEq(round.events.length, 1);
  assertEq(round.events[0].label, "自炊");
  assertEq(round.sleep["2026-07-24"].durationMin, 8 * 60);
});

// ================= Phase2: 食事モデル(種類カタログ・place・tier) =================
test("emptyState: mealKindsはobject配列・logMode=batch", () => {
  const s = HK.emptyState();
  assert(typeof s.settings.mealKinds[0] === "object", "kindはobject");
  assertEq(s.settings.mealKinds[0].label, "サラダ・野菜");
  assertEq(s.settings.mealKinds[0].tier, 1);
  assert(s.settings.mealKinds[0].emoji, "emojiあり");
  assertEq(s.settings.logMode, "batch");
});
test("mealKindMeta: 既知/未知", () => {
  assertEq(HK.mealKindMeta("バーガー・FF").tier, 3);
  assertEq(HK.mealKindMeta("寿司・海鮮").tier, 1); // 旧名
  assertEq(HK.mealKindMeta("謎料理"), { emoji: "🍽", tier: 2 });
});
test("setEventPlace: 店を分離設定、空はnull", () => {
  const s = HK.emptyState();
  const id = HK.logEvent(s, "MEAL", "魚・海鮮", at(2026, 7, 24, 20, 0), 1);
  assert(HK.setEventPlace(s, id, "自炊"));
  assertEq(s.events[0].place, "自炊");
  assert(HK.setEventPlace(s, id, ""));
  assertEq(s.events[0].place, null, "空文字→null");
});
test("setEventTier: MEALのみ・値を更新", () => {
  const s = HK.emptyState();
  const mid = HK.logEvent(s, "MEAL", "麺類", at(2026, 7, 24, 20, 0), 2);
  const cid = HK.logEvent(s, "COFFEE", null, at(2026, 7, 24, 22, 0));
  assert(HK.setEventTier(s, mid, 3));
  assertEq(s.events.find((e) => e.id === mid).tier, 3);
  assert(!HK.setEventTier(s, cid, 1), "COFFEEはtier不可");
});
test("複数品を同時刻に記録→tier別集計(鮭定食+クレープ)", () => {
  const s = HK.emptyState();
  const t = at(2026, 7, 24, 21, 0);
  ["🐟魚:1", "🍚ごはん:2", "🍰デザート:3"].forEach((x) => {
    const [label, tier] = x.split(":");
    HK.logEvent(s, "MEAL", label, t, +tier);
  });
  const payload = HK.buildGeminiPayload(HK.buildDaySummaries(s, t, 1), [], null);
  assertEq(payload.this_week_stats.meal_tier_counts, { good: 1, normal: 1, junk: 1 });
});
test("buildDaySummaries: meals は kind と place を分離保持", () => {
  const s = HK.emptyState();
  const t = at(2026, 7, 24, 20, 0);
  const id = HK.logEvent(s, "MEAL", "魚・海鮮", t, 1);
  HK.setEventPlace(s, id, "自炊");
  const days = HK.buildDaySummaries(s, t, 1);
  assertEq(days[0].meals[0], { tier: 1, kind: "魚・海鮮", place: "自炊" });
});
test("buildGeminiPayload: meal_kind_counts / meal_place_counts", () => {
  const s = HK.emptyState();
  const t = at(2026, 7, 24, 20, 0);
  const id = HK.logEvent(s, "MEAL", "魚・海鮮", t, 1);
  HK.setEventPlace(s, id, "自炊");
  const p = HK.buildGeminiPayload(HK.buildDaySummaries(s, t, 1), [], null);
  assertEq(p.this_week_stats.meal_kind_counts, { "魚・海鮮": 1 });
  assertEq(p.this_week_stats.meal_place_counts, { "自炊": 1 });
});
test("migrate: v5 string配列 → object配列(非破壊・カスタム保持)", () => {
  const s = HK.migrate({ version: 5, settings: { mealKinds: ["サラダ・野菜", "自作カレー"] } });
  assertEq(s.settings.mealKinds[0], { label: "サラダ・野菜", emoji: "🥗", tier: 1 });
  assertEq(s.settings.mealKinds[1], { label: "自作カレー", emoji: "🍽", tier: 2 });
  assertEq(s.version, 6);
});
test("migrate: 旧mealKinds既定 → 新カタログ(10種)へ差し替え", () => {
  const s = HK.migrate({ settings: { mealKinds: HK.LEGACY_MEAL_KINDS_V5.slice() } });
  assertEq(s.settings.mealKinds.length, 10);
  assert(s.settings.mealKinds.every((k) => typeof k === "object" && k.emoji && k.tier));
});
test("migrate: object配列は冪等(2回でも壊れない)・placeも保持", () => {
  const s0 = HK.emptyState();
  const id = HK.logEvent(s0, "MEAL", "寿司", at(2026, 7, 24, 20, 0), 1);
  HK.setEventPlace(s0, id, "スシロー");
  const once = HK.migrate(JSON.parse(JSON.stringify(s0)));
  const twice = HK.migrate(JSON.parse(JSON.stringify(once)));
  assertEq(twice, once);
  assertEq(twice.events[0].place, "スシロー");
});

// ================= 結果 =================
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
