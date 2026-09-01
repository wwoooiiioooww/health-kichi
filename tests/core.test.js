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
test("migrate: 空でも現行スキーマ(v9)に整う", () => {
  const s = HK.migrate({});
  assertEq(s.version, 10);
  assert(Array.isArray(s.events));
  assert(s.settings && Array.isArray(s.settings.mealKinds));
  assert(s.goals && typeof s.goals === "object");
  assert(Array.isArray(s.conditions));
  assert(s.personalContext && Array.isArray(s.personalContext.facts) && Array.isArray(s.personalContext.healthChecks));
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
  assertEq(days[0].meals[0], { tier: 1, weight: null, kind: "魚・海鮮", place: "自炊" });
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
  assertEq(s.version, 10);
});
test("migrate: 旧mealKinds既定 → 新カタログへ差し替え(MECE版)", () => {
  const s = HK.migrate({ settings: { mealKinds: HK.LEGACY_MEAL_KINDS_V5.slice() } });
  assertEq(s.settings.mealKinds.length, HK.MEAL_KINDS.length);
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

// ================= Phase3: 週次目標(計画) =================
test("setGoal/getGoal: 許可フィールドのみ・null で解除・空週は削除", () => {
  const s = HK.emptyState();
  assert(HK.setGoal(s, "2026-07-20", "sleepMin", 420));
  assert(HK.setGoal(s, "2026-07-20", "greenDays", 5));
  assertEq(HK.getGoal(s, "2026-07-20"), { sleepMin: 420, greenDays: 5 });
  assert(!HK.setGoal(s, "2026-07-20", "weight", 70), "未知フィールドは拒否");
  HK.setGoal(s, "2026-07-20", "sleepMin", null); // 解除
  assertEq(HK.getGoal(s, "2026-07-20"), { greenDays: 5 });
  HK.setGoal(s, "2026-07-20", "greenDays", null); // 空になったら週キー削除
  assertEq(s.goals["2026-07-20"], undefined);
  assertEq(HK.getGoal(s, "2026-07-20"), {});
});
test("weekProgress: 現在週の実績を集計", () => {
  const s = HK.emptyState();
  const now = at(2026, 7, 22, 20, 0); // 水曜(週初=7/20月)
  HK.setSleepManual(s, "2026-07-20", at(2026, 7, 19, 23, 0), at(2026, 7, 20, 7, 0)); // 8h
  HK.setSleepManual(s, "2026-07-21", at(2026, 7, 20, 23, 0), at(2026, 7, 21, 6, 0)); // 7h
  HK.logEvent(s, "MEAL", "魚", at(2026, 7, 20, 20, 0), 1);   // green day
  HK.logEvent(s, "MEAL", "デザート", at(2026, 7, 21, 20, 0), 3); // junk
  HK.setExercise(s, "2026-07-22", 2);
  HK.logEvent(s, "COFFEE", null, at(2026, 7, 21, 22, 0)); // late coffee
  const p = HK.weekProgress(s, now);
  assertEq(p.weekStartIso, "2026-07-20");
  assertEq(p.sleepAvgMin, 450); // (480+420)/2
  assertEq(p.recordedSleepDays, 2);
  assertEq(p.greenDays, 1);
  assertEq(p.exerciseDays, 1);
  assertEq(p.junkCount, 1);
  assertEq(p.lateCoffee, 1);
});
test("weekProgress: 記録なしはnull/0(0で埋めない)", () => {
  const s = HK.emptyState();
  const p = HK.weekProgress(s, at(2026, 7, 20, 10, 0)); // 月曜
  assertEq(p.sleepAvgMin, null);
  assertEq(p.recordedSleepDays, 0);
  assertEq(p.greenDays, 0);
});
test("migrate: goals/lastGoalPromptWeek を保持(往復非破壊)", () => {
  const s0 = HK.emptyState();
  HK.setGoal(s0, "2026-07-20", "sleepMin", 420);
  s0.lastGoalPromptWeek = "2026-07-20";
  const round = HK.migrate(JSON.parse(JSON.stringify(s0)));
  assertEq(round.goals["2026-07-20"], { sleepMin: 420 });
  assertEq(round.lastGoalPromptWeek, "2026-07-20");
});
test("migrate: v6以前(goalsキー無し)にgoalsを補完", () => {
  const s = HK.migrate({ version: 6, events: [] });
  assert(s.goals && typeof s.goals === "object");
  assertEq(s.lastGoalPromptWeek, null);
});

// ================= Phase4a: 体調 / Personal Context =================
test("addCondition/activeConditions/resolve/reopen/delete", () => {
  const s = HK.emptyState();
  const now = at(2026, 7, 24, 10, 0);
  const id = HK.addCondition(s, "のどの痛み", "😷", now, "昨夜から");
  assertEq(HK.activeConditions(s).length, 1);
  assertEq(s.conditions[0].startIso, "2026-07-24");
  assertEq(s.conditions[0].note, "昨夜から");
  assert(HK.resolveCondition(s, id, at(2026, 7, 26, 10, 0)));
  assertEq(HK.activeConditions(s).length, 0);
  assertEq(s.conditions[0].resolvedIso, "2026-07-26");
  assert(HK.reopenCondition(s, id));
  assertEq(HK.activeConditions(s).length, 1);
  assert(HK.deleteCondition(s, id));
  assertEq(s.conditions.length, 0);
});
test("addFact: user/ai を分離・updateFact/deleteFact", () => {
  const s = HK.emptyState();
  const uid = HK.addFact(s, "花粉症", "user");
  const aid = HK.addFact(s, "HbA1c 5.4", "ai");
  assertEq(s.personalContext.facts.map((f) => f.source), ["user", "ai"]);
  assert(HK.updateFact(s, uid, "スギ花粉症"));
  assertEq(s.personalContext.facts.find((f) => f.id === uid).text, "スギ花粉症");
  assert(HK.deleteFact(s, aid));
  assertEq(s.personalContext.facts.length, 1);
});
test("buildContextPayload: 要約のみ(生ログを送らない)", () => {
  const s = HK.emptyState();
  const now = at(2026, 7, 24, 10, 0);
  HK.addCondition(s, "頭痛", "🤕", now, "ズキズキ");
  HK.addFact(s, "甘い物が好き", "user");
  HK.addHealthCheck(s, { dateIso: "2026-07-01", summary: "血圧やや高め" });
  const ctx = HK.buildContextPayload(s, now);
  assertEq(ctx.personal_context, ["甘い物が好き"]);
  assertEq(ctx.active_conditions, [{ label: "頭痛", since: "2026-07-24", note: "ズキズキ" }]);
  assertEq(ctx.latest_health_check, { date: "2026-07-01", summary: "血圧やや高め" });
});
test("buildGeminiPayload: context を載せる/未指定でも壊れない", () => {
  const s = HK.emptyState();
  const days = HK.buildDaySummaries(s, Date.now(), 3);
  const noCtx = HK.buildGeminiPayload(days, [], null);
  assertEq(noCtx.personal_context, null);
  assertEq(noCtx.active_conditions, null);
  const ctx = { personal_context: ["花粉症"], active_conditions: [{ label: "頭痛" }] };
  const withCtx = HK.buildGeminiPayload(days, [], null, ctx);
  assertEq(withCtx.personal_context, ["花粉症"]);
  assertEq(withCtx.active_conditions, [{ label: "頭痛" }]);
});
test("migrate: conditions/personalContext を補完(往復非破壊)", () => {
  const s0 = HK.emptyState();
  HK.addCondition(s0, "腹痛", "🤢", Date.now());
  HK.addFact(s0, "運動不足", "user");
  const round = HK.migrate(JSON.parse(JSON.stringify(s0)));
  assertEq(round.conditions.length, 1);
  assertEq(round.personalContext.facts.length, 1);
  // v7以前(キー無し)も補完される
  const old = HK.migrate({ version: 7, events: [] });
  assert(Array.isArray(old.conditions));
  assert(old.personalContext && Array.isArray(old.personalContext.facts));
});

// ================= Phase4b: 健診Vision解析 =================
test("buildHealthCheckRequestBody: inlineData/JSON/上限4096", () => {
  const body = HK.buildHealthCheckRequestBody("QUJD", "image/png");
  const parts = body.contents[0].parts;
  assertEq(parts[0].inlineData.mimeType, "image/png");
  assertEq(parts[0].inlineData.data, "QUJD");
  assert(parts[1].text.length > 0, "指示テキストあり");
  assertEq(body.generationConfig.responseMimeType, "application/json");
  assert(body.generationConfig.maxOutputTokens >= 4096, "尻切れ防止で4096以上");
  assert(body.systemInstruction.parts[0].text.includes("健康診断"), "systemプロンプト");
});
test("buildHealthCheckRequestBody: mime未指定はjpegに解決", () => {
  const body = HK.buildHealthCheckRequestBody("QUJD");
  assertEq(body.contents[0].parts[0].inlineData.mimeType, "image/jpeg");
});
test("buildHealthCheckTextRequestBody: テキストをそのまま送る(画像なし)", () => {
  const body = HK.buildHealthCheckTextRequestBody("HbA1c 5.8 / 血圧 140/90");
  const parts = body.contents[0].parts;
  assertEq(parts.length, 1, "inlineDataは含めない");
  assert(parts[0].text.includes("HbA1c 5.8"), "入力テキストを含む");
  assert(!parts[0].inlineData, "画像は送らない");
  assertEq(body.generationConfig.maxOutputTokens, 4096);
  assert(body.systemInstruction.parts[0].text.includes("健康診断"));
});
test("parseHealthCheckResponse: 正常(コードフェンス/思考パーツ除去)", () => {
  const resp = { candidates: [{ content: { parts: [
    { text: "考え中", thought: true },
    { text: '```json\n{"date":"2026-07-01","summary":"血圧やや高め。LDLも高め。","values":[{"name":"BP","value":"140/90","flag":"H"}],"facts":["血圧やや高め","LDL高め"]}\n```' }
  ] } }] };
  const p = HK.parseHealthCheckResponse(resp);
  assert(!p.error, "エラーでない");
  assertEq(p.result.date, "2026-07-01");
  assertEq(p.result.values.length, 1);
  assertEq(p.result.facts, ["血圧やや高め", "LDL高め"]);
});
test("parseHealthCheckResponse: summary欠落/空応答はerror", () => {
  assert(HK.parseHealthCheckResponse({ candidates: [{ content: { parts: [{ text: "{}" }] } }] }).error);
  assert(HK.parseHealthCheckResponse({ candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }] }).error);
  assert(HK.parseHealthCheckResponse({}).error, "candidates無しもerror");
});
test("addHealthCheck: 要約とimageId(参照のみ)を保存", () => {
  const s = HK.emptyState();
  const id = HK.addHealthCheck(s, { dateIso: "2026-07-01", summary: "所見あり", values: [{ name: "BP", value: "140/90" }], imageId: "hc-xyz" });
  const h = s.personalContext.healthChecks.find((x) => x.id === id);
  assertEq(h.imageId, "hc-xyz");
  assertEq(h.summary, "所見あり");
  // buildContextPayloadには要約のみ載る(画像ID/生値は送らない)
  const ctx = HK.buildContextPayload(s, Date.now());
  assertEq(ctx.latest_health_check, { date: "2026-07-01", summary: "所見あり" });
});

// ================= 改良: 食事カタログのMECE化 =================
test("MEAL_KINDS: 迷ったとき用の「その他」があり、tierは1-3のみ", () => {
  assert(HK.MEAL_KINDS.some((k) => k.label === "その他"), "受け皿がある");
  assert(HK.MEAL_KINDS.every((k) => [1, 2, 3].includes(k.tier) && k.emoji && k.label));
  const labels = HK.MEAL_KINDS.map((k) => k.label);
  assertEq(labels.length, new Set(labels).size, "重複なし");
  // ユーザーが挙げた「どれか分からない」例に居場所があること
  ["洋食・パスタ", "弁当・惣菜", "中華", "肉料理"].forEach((l) =>
    assert(labels.includes(l), l + " がカタログにある"));
});
test("MEAL_KIND_LOOKUP: カタログの全種類を引ける", () => {
  HK.MEAL_KINDS.forEach((k) => {
    const meta = HK.mealKindMeta(k.label);
    assertEq(meta.tier, k.tier, k.label + " のtier");
    assertEq(meta.emoji, k.emoji, k.label + " のemoji");
  });
});
test("migrate: v6既定(10種)のままなら新カタログへ、編集済みなら保持", () => {
  const asObj = (labels) => labels.map((l) => ({ label: l, emoji: HK.mealKindMeta(l).emoji, tier: HK.mealKindMeta(l).tier }));
  // 未編集 → 差し替え
  const fresh = HK.migrate({ version: 8, settings: { mealKinds: asObj(HK.LEGACY_MEAL_KINDS_V6) } });
  assertEq(fresh.settings.mealKinds.length, HK.MEAL_KINDS.length);
  // 1つ削除して編集済み → そのまま
  const edited = HK.migrate({ version: 8, settings: { mealKinds: asObj(HK.LEGACY_MEAL_KINDS_V6.slice(0, 9)) } });
  assertEq(edited.settings.mealKinds.length, 9, "編集済みは上書きしない");
  // tierを変えて編集済み → そのまま
  const t = asObj(HK.LEGACY_MEAL_KINDS_V6);
  t[4].tier = 3;
  const retiered = HK.migrate({ version: 8, settings: { mealKinds: t } });
  assertEq(retiered.settings.mealKinds.length, 10, "tier変更も編集とみなす");
  assertEq(retiered.settings.mealKinds[4].tier, 3);
});

// ================= 改良: 睡眠の推定・取り込み =================
const seedSleep = (s, endDay) => { // 23:30就寝/07:00起床を5日ぶん
  for (let d = endDay - 4; d <= endDay; d++)
    HK.setSleepManual(s, HK.dateIso(at(2026, 7, d, 7, 0)), at(2026, 7, d - 1, 23, 30), at(2026, 7, d, 7, 0));
};
test("usualSleepTimes: 中央値(0時またぎも正しく)", () => {
  const s = HK.emptyState();
  seedSleep(s, 23);
  const u = HK.usualSleepTimes(s, at(2026, 7, 24, 12, 0));
  assertEq(u.bedMin, 23 * 60 + 30, "就寝は0時をまたいでも中央値が取れる");
  assertEq(u.wakeMin, 7 * 60);
  assertEq(HK.usualSleepTimes(HK.emptyState(), at(2026, 7, 24, 12, 0)), null, "記録なしはnull");
});
test("estimateSleep: おやすみ記録 > いつもの時間 > 操作間隔 の順で推定", () => {
  const now = at(2026, 7, 24, 12, 0);
  // ① おやすみ記録があればそれを使う
  const a = HK.emptyState(); seedSleep(a, 23);
  a.pendingBed = at(2026, 7, 23, 22, 45);
  assertEq(HK.estimateSleep(a, now).basis, "bed");
  assertEq(HK.hhmm(HK.estimateSleep(a, now).bedMs), "22:45");
  // ② なければ いつもの時間
  const b = HK.emptyState(); seedSleep(b, 23);
  assertEq(HK.estimateSleep(b, now).basis, "usual");
  // ③ 実績がなければ 夜の最終操作
  const c = HK.emptyState(); c.lastActiveAt = at(2026, 7, 23, 23, 0);
  const ec = HK.estimateSleep(c, at(2026, 7, 24, 7, 0));
  assertEq(ec.basis, "activity");
  // ④ 材料が何もなければ null(0やダミーで埋めない)
  assertEq(HK.estimateSleep(HK.emptyState(), now), null);
});
test("estimateSleep: 記録済みの日は提案しない", () => {
  const s = HK.emptyState(); seedSleep(s, 24);
  assertEq(HK.estimateSleep(s, at(2026, 7, 24, 12, 0)), null);
});
test("resolveWakeOnOpen: 昼以降に開いても過大記録しない(提案に回す)", () => {
  const s = HK.emptyState(); seedSleep(s, 23);
  HK.markBed(s, at(2026, 7, 23, 23, 30));
  const r = HK.resolveWakeOnOpen(s, at(2026, 7, 24, 12, 0)); // 12時に開く
  assertEq(r.kind, "suggest");
  assertEq(s.sleep["2026-07-24"], undefined, "12h超の睡眠を勝手に作らない");
  assert(s.pendingBed != null, "おやすみは保持(あとで確定できる)");
});
test("resolveWakeOnOpen: 夜に開いても「おやすみ」を破棄しない", () => {
  const s = HK.emptyState(); seedSleep(s, 23);
  HK.markBed(s, at(2026, 7, 23, 23, 30));
  const r = HK.resolveWakeOnOpen(s, at(2026, 7, 24, 21, 0));
  assertEq(r.kind, "suggest");
  assert(s.pendingBed != null);
});
test("resolveWakeOnOpen: 30時間を超えた古いおやすみは破棄", () => {
  const s = HK.emptyState();
  HK.markBed(s, at(2026, 7, 23, 23, 30));
  const r = HK.resolveWakeOnOpen(s, at(2026, 7, 25, 10, 0)); // 34.5h後
  assertEq(r.kind, "stale");
  assertEq(s.pendingBed, null);
});
test("acceptSleepEstimate: 提案を1タップで確定できる", () => {
  const s = HK.emptyState(); seedSleep(s, 23);
  HK.markBed(s, at(2026, 7, 23, 23, 30));
  const r = HK.acceptSleepEstimate(s, at(2026, 7, 24, 12, 0));
  assertEq(r.dateIso, "2026-07-24");
  assertEq(s.sleep["2026-07-24"].durationMin, 7 * 60 + 30, "23:30→07:00");
  assertEq(s.pendingBed, null);
});
test("parseSleepText: 各種フォーマットを解釈", () => {
  const now = at(2026, 7, 24, 12, 0);
  const rows = HK.parseSleepText("23:40-07:10", now);
  assertEq(rows.length, 1);
  assertEq(rows[0].dateIso, "2026-07-24");
  assertEq(rows[0].durationMin, 7 * 60 + 30);
  assertEq(HK.parseSleepText("23:40 → 07:10", now).length, 1, "矢印");
  assertEq(HK.parseSleepText("0:15〜6:40", now).length, 1, "全角チルダ・1桁時");
  assertEq(HK.parseSleepText("2026-07-22 23:00-06:30", now)[0].dateIso, "2026-07-22", "日付指定");
  assertEq(HK.parseSleepText("きのうはよく寝た", now).length, 0, "読めない行は無視");
  assertEq(HK.parseSleepText("25:00-07:00", now).length, 0, "不正な時刻は無視");
});
test("parseSleepText: 複数行をまとめて解釈", () => {
  const rows = HK.parseSleepText("2026-07-22 23:00-06:30\n2026-07-23 23:50-07:20", at(2026, 7, 24, 12, 0));
  assertEq(rows.length, 2);
  assertEq(rows.map((r) => r.dateIso), ["2026-07-22", "2026-07-23"]);
});
test("importSleepText: 既存の記録は上書きしない(手で直した値を守る)", () => {
  const s = HK.emptyState();
  HK.setSleepManual(s, "2026-07-23", at(2026, 7, 22, 22, 0), at(2026, 7, 23, 6, 0));
  const r = HK.importSleepText(s, "2026-07-23 23:00-07:00\n2026-07-22 23:30-06:30", at(2026, 7, 24, 12, 0));
  assertEq(r.added, 1);
  assertEq(r.skipped, 1);
  assertEq(s.sleep["2026-07-23"].durationMin, 8 * 60, "既存はそのまま");
  assertEq(s.sleep["2026-07-22"].source, "IMPORT");
});

// ================= v10: 機能トグル =================
test("FEATURE_DEFS: 既定は最小構成(ONは睡眠の質・眠気・イラッと・食事の重さ・運動量の5つだけ)", () => {
  const on = HK.FEATURE_DEFS.filter((d) => d.def).map((d) => d.f).sort();
  assertEq(on, ["exercise", "irritation", "mealWeight", "sleepQuality", "sleepiness"]);
  assert(HK.FEATURE_DEFS.every((d) => d.label && d.hint && ["core", "extra"].includes(d.group)),
    "全フラグに表示用のlabel/hint/groupがある");
  const fs = HK.FEATURE_DEFS.map((d) => d.f);
  assertEq(fs.length, new Set(fs).size, "フラグ名の重複なし");
});
test("feat: 未設定・未知キーは定義側の既定へフォールバックする", () => {
  const s = HK.emptyState();
  assert(HK.feat(s, "sleepiness"), "既定ON");
  assert(!HK.feat(s, "mood"), "既定OFF");
  delete s.settings.features;
  assert(HK.feat(s, "mealWeight"), "features自体が無くても既定に落ちる");
  assert(!HK.feat(s, "存在しない機能"), "未知キーはfalse");
  assert(HK.feat(null, "sleepiness"), "stateがnullでも落ちず、定義側の既定を返す");
});
test("setFeature: 既知キーだけ書き換わる。未知キーは無視", () => {
  const s = HK.emptyState();
  assert(HK.setFeature(s, "mood", true));
  assert(HK.feat(s, "mood"));
  assert(!HK.setFeature(s, "nope", true), "未知キーはfalseを返す");
  assert(!("nope" in s.settings.features));
});
test("migrate v9→v10: 既存ユーザーは最小構成になり、案内フラグが立つ", () => {
  const old = HK.emptyState();
  delete old.settings.features;
  delete old.pendingFeatureNotice;
  old.version = 9;
  HK.logEvent(old, "MEAL", "麺類", at(2026, 7, 24, 20, 0), 2);
  const s = HK.migrate(old);
  assertEq(s.version, 10);
  assert(!HK.feat(s, "mood"), "きぶんは隠れる");
  assert(HK.feat(s, "sleepiness"), "眠気はON");
  assert(!HK.feat(s, "lateCoffee"), "21時コーヒーも既定OFF");
  assertEq(s.pendingFeatureNotice, true, "戻し方の案内を1回出す");
});
test("migrate v10: データが無い新規は案内を出さない", () => {
  const s = HK.migrate({ version: 9, settings: {} });
  assert(!s.pendingFeatureNotice, "空stateに案内は不要");
});
test("migrate v10: ユーザーが選んだフラグは上書きせず、増えた分だけ既定で補う", () => {
  const s = HK.migrate({ version: 10, settings: { features: { mood: true } } });
  assert(HK.feat(s, "mood"), "ユーザーがONにした値を守る");
  assert(HK.feat(s, "sleepiness"), "未知のフラグは既定で補完");
  assertEq(Object.keys(s.settings.features).length, HK.FEATURE_DEFS.length);
});
test("migrate: settingsが無いJSONをimportしても落ちない", () => {
  const s = HK.migrate({ version: 8, events: [] });
  assertEq(s.version, 10);
  assert(s.settings.features, "featuresが補完される");
});

// ================= v10: 食事の重さ / 眠気 =================
test("logEvent: 種類を記録しない食事のtierはnull(ふつうをでっち上げない)", () => {
  const s = HK.emptyState();
  HK.logEvent(s, "MEAL", null, at(2026, 7, 24, 20, 0), null, 3);
  assertEq(s.events[0].tier, null, "健康度は未記録のままnull");
  assertEq(s.events[0].weight, 3, "重さだけ入る");
});
test("logEvent: 種類が分かるならカタログのtierを引く(明示tierが最優先)", () => {
  const s = HK.emptyState();
  HK.logEvent(s, "MEAL", "バーガー・FF", at(2026, 7, 24, 20, 0));
  assertEq(s.events[0].tier, 3, "カタログから3");
  HK.logEvent(s, "MEAL", "バーガー・FF", at(2026, 7, 24, 21, 0), 1);
  assertEq(s.events[1].tier, 1, "明示指定が勝つ");
});
test("logEvent: weight未指定はnull。COFFEEにweightは付かない", () => {
  const s = HK.emptyState();
  HK.logEvent(s, "MEAL", "寿司", at(2026, 7, 24, 20, 0), 1);
  assertEq(s.events[0].weight, null);
  HK.logEvent(s, "COFFEE", null, at(2026, 7, 24, 22, 0));
  assert(!("weight" in s.events[1]), "COFFEEにweightキー自体を作らない");
});
test("setEventWeight: MEALのみ。nullで解除できる", () => {
  const s = HK.emptyState();
  const mid = HK.logEvent(s, "MEAL", null, at(2026, 7, 24, 20, 0), null, 1);
  const cid = HK.logEvent(s, "COFFEE", null, at(2026, 7, 24, 22, 0));
  assert(HK.setEventWeight(s, mid, 3));
  assertEq(s.events.find((e) => e.id === mid).weight, 3);
  assert(HK.setEventWeight(s, mid, null));
  assertEq(s.events.find((e) => e.id === mid).weight, null, "解除できる");
  assert(!HK.setEventWeight(s, cid, 2), "COFFEEは不可");
  assert(!HK.setEventWeight(s, 9999, 2), "存在しないidは不可");
});
test("setCheckin: sleepinessを受け付ける。未知フィールドは拒否のまま", () => {
  const s = HK.emptyState();
  assert(HK.setCheckin(s, "2026-07-24", "sleepiness", 2));
  assertEq(s.checkin["2026-07-24"].sleepiness, 2);
  assert(!HK.setCheckin(s, "2026-07-24", "steps", 100), "未知フィールドは拒否");
});
test("buildDaySummaries: 重さと眠気が日次サマリに出る", () => {
  const s = HK.emptyState();
  const t = at(2026, 7, 24, 20, 0);
  HK.logEvent(s, "MEAL", null, t, null, 3);
  HK.setCheckin(s, "2026-07-24", "sleepiness", 2);
  const days = HK.buildDaySummaries(s, at(2026, 7, 24, 23, 0), 1);
  assertEq(days[0].meals[0], { tier: null, weight: 3, kind: null, place: null });
  assertEq(days[0].sleepiness, 2);
});

test("migrate: v10以降の tier=null は「種類未記録」なので埋めない(重さだけの食事が🟡に化けない)", () => {
  const s = HK.emptyState();
  HK.logEvent(s, "MEAL", null, at(2026, 7, 24, 20, 0), null, 3);
  const m = HK.migrate(JSON.parse(JSON.stringify(s)));
  assertEq(m.events[0].tier, null, "nullのまま");
  assertEq(m.events[0].weight, 3);
  // 2回通しても化けない(起動のたびにmigrateが走るため)
  const m2 = HK.migrate(JSON.parse(JSON.stringify(m)));
  assertEq(m2.events[0].tier, null);
});
test("migrate: v9以前の tier無しMEAL は従来どおり「ふつう」に寄せる(後方互換)", () => {
  const s = HK.migrate({ version: 9, settings: {}, events: [{ t: 1, type: "MEAL" }] });
  assertEq(s.events[0].tier, 2);
});

test("migrate: 配列であるべき設定がnullでも既定に戻る(設定画面が.mapで落ちない)", () => {
  const s = HK.migrate({ version: 9, events: [],
    settings: { mealKinds: null, mealChips: null, coffeeChips: null, activityChips: null } });
  for (const k of ["mealKinds", "mealChips", "coffeeChips", "activityChips"])
    assert(Array.isArray(s.settings[k]) && s.settings[k].length > 0, k + " が既定の配列に戻る");
  assertEq(s.settings.mealKinds[0], HK.DEFAULT_MEAL_KINDS[0]);
  // 既定オブジェクトを共有参照しない(1つ直すと全stateが変わる事故を防ぐ)
  s.settings.mealKinds[0].label = "X";
  assertEq(HK.DEFAULT_MEAL_KINDS[0].label, "サラダ・野菜");
});

// ================= 結果 =================
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
