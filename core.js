/**
 * ヘルスきち core.js v3 — ロジック層(UI非依存・Nodeでテスト可能)
 *
 * v2からの変更(2026-07 施主フィードバック):
 *   - 「1日」を朝4時区切りの論理日に統一(深夜2時の食事は前日の夜食)
 *   - 夜のチェックイン3項目化: 気分(1-5) / はかどり(1-4) / イラッと度(0-3)
 *   - 食事を3段階(good/normal/junk)+店は任意に再設計。健康チップは食事tierに統合
 *   - 1日の運動量(0-3)を追加(チップの瞬間記録とは別)
 *   - Gemini応答解析を思考(thought)パーツ対応に強化、出力上限4096に
 *
 * 設計原則: 入力させたら負け / 説教禁止 / 折れても責めない / 推定できないなら null
 */
"use strict";

const HK = {};

// ---------------- 定数 ----------------

HK.DEFAULT_MODEL = "gemini-3.5-flash";
HK.LATE_COFFEE_HOUR = 21;
HK.MIN_SLEEP_MIN = 180;
HK.MAX_SLEEP_MIN = 16 * 60;
HK.STALE_WAKE_HOUR = 12;
HK.WAKE_WINDOW_START_HOUR = 4;
HK.NIGHT_ACTIVE_FROM = 20;
HK.DAY_START_HOUR = 4;          // 論理日の境界。朝4時より前は「前日」扱い

// 食事の「種類」カタログ。tier(健康度 1=good/2=normal/3=junk)と絵文字を内蔵。
// 「1品=1記録」方式: 1食で複数選ぶと同時刻に複数MEALとして記録される。
HK.MEAL_KINDS = [
  { label: "サラダ・野菜", emoji: "🥗", tier: 1 },
  { label: "魚・海鮮", emoji: "🐟", tier: 1 },
  { label: "寿司", emoji: "🍣", tier: 1 },
  { label: "定食・和食", emoji: "🍚", tier: 2 },
  { label: "麺類", emoji: "🍜", tier: 2 },
  { label: "丼・カレー", emoji: "🍛", tier: 2 },
  { label: "パン・軽食", emoji: "🍞", tier: 2 },
  { label: "バーガー・FF", emoji: "🍔", tier: 3 },
  { label: "揚げ物・スナック", emoji: "🍟", tier: 3 },
  { label: "お菓子・デザート", emoji: "🍰", tier: 3 }
];
HK.DEFAULT_MEAL_KINDS = HK.MEAL_KINDS.map((o) => Object.assign({}, o));
// 旧string配列(v5以前)を新object配列へ移行する際の絵文字/tier対応表(旧名も含む)
HK.MEAL_KIND_LOOKUP = {
  "サラダ・野菜": { emoji: "🥗", tier: 1 }, "魚・海鮮": { emoji: "🐟", tier: 1 },
  "寿司": { emoji: "🍣", tier: 1 }, "寿司・海鮮": { emoji: "🍣", tier: 1 },
  "定食・和食": { emoji: "🍚", tier: 2 }, "麺類": { emoji: "🍜", tier: 2 },
  "丼・カレー": { emoji: "🍛", tier: 2 }, "パン・軽食": { emoji: "🍞", tier: 2 },
  "バーガー・FF": { emoji: "🍔", tier: 3 }, "揚げ物・スナック": { emoji: "🍟", tier: 3 },
  "お菓子・デザート": { emoji: "🍰", tier: 3 }, "お菓子・間食": { emoji: "🍰", tier: 3 }
};
// v5以前のmealKinds既定値(未編集判定用)
HK.LEGACY_MEAL_KINDS_V5 = ["定食・和食", "麺類", "丼・カレー", "バーガー・FF", "寿司・海鮮", "パン・軽食", "サラダ・野菜", "お菓子・間食"];
/** 種類名から{emoji,tier}を引く。未知は{🍽, 2} */
HK.mealKindMeta = (name) => HK.MEAL_KIND_LOOKUP[name] || { emoji: "🍽", tier: 2 };
// 食事の「店」(2026年時点の国内店舗数上位チェーンを網羅的に。設定で編集可)
HK.DEFAULT_MEAL_CHIPS = ["自炊", "コンビニ", "マック", "モス", "KFC", "すき家", "吉野家", "松屋", "なか卯",
  "スシロー", "はま寿司", "くら寿司", "かっぱ寿司", "丸亀製麺", "日高屋", "餃子の王将", "かつや",
  "CoCo壱", "やよい軒", "大戸屋", "ガスト", "サイゼリヤ", "バーミヤン", "その他"];
HK.DEFAULT_COFFEE_CHIPS = ["スタバ", "マクドナルド", "ドトール", "タリーズ", "会社のカフェ", "その他"]; // v4で未使用(互換のため残置)
HK.DEFAULT_ACTIVITY_CHIPS = ["歩く", "階段", "筋トレ", "ランニング", "ストレッチ", "スポーツ"];
HK.TONES = { colleague: "同僚", cheer: "チア", analyst: "アナリスト" };

HK.MEAL_TIERS = { 1: "good", 2: "normal", 3: "junk" };

// ---------------- 日付ユーティリティ ----------------

HK.dateIso = (ms) => {
  const d = new Date(ms);
  const p = (n) => (n < 10 ? "0" + n : "" + n);
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
};

/** 論理日: 朝4時より前の時刻は前日として扱う */
HK.logicalDateIso = (ms) => HK.dateIso(ms - HK.DAY_START_HOUR * 3600000);

/**
 * 論理日+分(0-1439)を実時刻(millis)に変換。
 * 0:00-3:59 は論理日の「深夜」なので翌実日になる。
 * 例: ("2026-07-11", 1:30) -> 実時刻 2026-07-12 01:30
 */
HK.msFromLogicalDate = (dateIso, minuteOfDay) => {
  const base = new Date(dateIso + "T00:00:00").getTime();
  const extra = minuteOfDay < HK.DAY_START_HOUR * 60 ? 1440 : 0;
  return base + (minuteOfDay + extra) * 60000;
};

HK.hhmm = (ms) => {
  const d = new Date(ms);
  const p = (n) => (n < 10 ? "0" + n : "" + n);
  return p(d.getHours()) + ":" + p(d.getMinutes());
};

/** その週の月曜日の ISO 日付 */
HK.weekStartIso = (ms) => {
  const d = new Date(ms);
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  return HK.dateIso(d.getTime());
};

// ---------------- ストレージスキーマ ----------------

HK.emptyState = () => ({
  version: 8,
  events: [],          // {id, t, type: "MEAL"|"COFFEE"|"ACTIVITY"|"NO_MEAL", label(=種類), tier(MEALのみ1-3), place(MEALの店・任意)}
  nextEventId: 1,
  sleep: {},           // 起床日(実日) -> {bed, wake, durationMin, source, corrected}
  checkin: {},         // 論理日 -> {mood?:1-5, focus?:1-4, irritation?:0-3}
  exercise: {},        // 論理日 -> 0-3 (全然/すこし/ふつう/たくさん)
  goals: {},           // 週(月曜ISO) -> {sleepMin?, greenDays?, exerciseDays?, junkMax?, lateCoffeeMax?}
  lastGoalPromptWeek: null, // 週末ポップアップを週1回に制限
  conditions: [],      // 体調ログ {id, emoji, label, startIso, resolvedIso|null, note}
  personalContext: { facts: [], healthChecks: [] }, // 育つ本人情報。facts{id,text,source},healthChecks{id,dateIso,summary,values,imageId}
  reports: [],
  settings: {
    apiKey: "",
    model: "",
    mealKinds: HK.DEFAULT_MEAL_KINDS.map((o) => Object.assign({}, o)), // [{label,emoji,tier}]
    mealChips: HK.DEFAULT_MEAL_CHIPS.slice(),
    coffeeChips: HK.DEFAULT_COFFEE_CHIPS.slice(),
    activityChips: HK.DEFAULT_ACTIVITY_CHIPS.slice(),
    logMode: "batch",     // batch=まとめて記録 / quick=都度記録
    displayName: "",
    profile: "",          // 空ならHK.DEFAULT_PROFILEを使用
    tone: "colleague",    // colleague | cheer | analyst
    lastExperiment: null
  },
  pendingBed: null,
  lastActiveAt: null
});

/** 旧バージョン(v1/v2)のstateを現行スキーマへ移行 */
HK.migrate = (s) => {
  const base = HK.emptyState();
  for (const k of Object.keys(base)) if (!(k in s)) s[k] = base[k];
  for (const k of Object.keys(base.settings)) if (!(k in s.settings)) s.settings[k] = base.settings[k];
  s.events = (s.events || []).map((e) => {
    if (e.type === "STAIRS") return Object.assign({}, e, { type: "ACTIVITY", label: "階段" });
    if (e.type === "WALK") return Object.assign({}, e, { type: "ACTIVITY", label: "散歩" });
    if (e.type === "HEALTH") return Object.assign({}, e, { type: "MEAL", tier: 1 });      // 健康チップ→良い食事
    if (e.type === "MEAL" && e.tier == null) return Object.assign({}, e, { tier: 2 });    // 旧食事→ふつう
    return e;
  });
  let id = s.nextEventId || 1;
  for (const e of s.events) if (e.id == null) e.id = id++;
  s.nextEventId = Math.max(id, ...s.events.map((e) => e.id + 1), 1);
  if (s.mood) { // v2の気分 -> checkin.mood
    for (const [d, m] of Object.entries(s.mood))
      if (!s.checkin[d]) s.checkin[d] = { mood: m.score };
    delete s.mood;
  }
  delete s.settings.healthChips;
  const eq = (a, b) => Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);
  if (eq(s.settings.mealChips, ["マック", "日高屋", "サイゼ", "松屋", "スシロー", "大戸屋", "自炊", "その他"]))
    s.settings.mealChips = HK.DEFAULT_MEAL_CHIPS.slice();
  if (eq(s.settings.activityChips, ["階段", "散歩"]))
    s.settings.activityChips = HK.DEFAULT_ACTIVITY_CHIPS.slice();
  // mealKinds: v5以前は string[]。object[]{label,emoji,tier}へ移行(非破壊)。
  if (Array.isArray(s.settings.mealKinds)) {
    if (eq(s.settings.mealKinds, HK.LEGACY_MEAL_KINDS_V5)) {
      // 未編集の旧既定 → 新カタログへ差し替え
      s.settings.mealKinds = HK.DEFAULT_MEAL_KINDS.map((o) => Object.assign({}, o));
    } else {
      s.settings.mealKinds = s.settings.mealKinds.map((k) => {
        if (typeof k === "string") {
          const meta = HK.mealKindMeta(k);
          return { label: k, emoji: meta.emoji, tier: meta.tier };
        }
        return { label: k.label, emoji: k.emoji || "🍽", tier: k.tier || 2 };
      });
    }
  }
  // conditions / personalContext の補完(nested配列の健全性も保証・非破壊)
  if (!Array.isArray(s.conditions)) s.conditions = [];
  if (!s.personalContext || typeof s.personalContext !== "object") s.personalContext = { facts: [], healthChecks: [] };
  if (!Array.isArray(s.personalContext.facts)) s.personalContext.facts = [];
  if (!Array.isArray(s.personalContext.healthChecks)) s.personalContext.healthChecks = [];
  s.version = 8;
  return s;
};

HK.resolveModel = (settings) => {
  const m = settings && settings.model;
  return m && m.trim() ? m.trim() : HK.DEFAULT_MODEL;
};

// ---------------- 睡眠(v2と同一ロジック) ----------------

HK.markBed = (state, nowMs) => { state.pendingBed = nowMs; return state; };
HK.touch = (state, nowMs) => { state.lastActiveAt = nowMs; return state; };

HK.resolveWakeOnOpen = (state, nowMs) => {
  const today = HK.dateIso(nowMs); // 起床日は実日(起床は4-12時なので論理日と一致)
  const h = new Date(nowMs).getHours();

  if (state.pendingBed != null) {
    if (state.sleep[today]) { state.pendingBed = null; return { kind: "none" }; }
    const bed = state.pendingBed;
    const elapsedMin = Math.floor((nowMs - bed) / 60000);
    if (elapsedMin < HK.MIN_SLEEP_MIN) return { kind: "short" };
    if (h >= HK.STALE_WAKE_HOUR && elapsedMin > HK.MAX_SLEEP_MIN) {
      state.pendingBed = null;
      return { kind: "stale" };
    }
    if (h < HK.WAKE_WINDOW_START_HOUR) return { kind: "short" };
    state.sleep[today] = { bed, wake: nowMs, durationMin: elapsedMin, source: "AUTO", corrected: false };
    state.pendingBed = null;
    return { kind: "woke", dateIso: today, durationMin: elapsedMin, inferred: false };
  }

  if (state.sleep[today]) return { kind: "none" };
  const la = state.lastActiveAt;
  if (la == null) return { kind: "none" };
  const gapMin = Math.floor((nowMs - la) / 60000);
  const lah = new Date(la).getHours();
  const nightActive = lah >= HK.NIGHT_ACTIVE_FROM || lah < HK.WAKE_WINDOW_START_HOUR;
  const morningNow = h >= HK.WAKE_WINDOW_START_HOUR && h < HK.STALE_WAKE_HOUR;
  if (nightActive && morningNow && gapMin >= HK.MIN_SLEEP_MIN && gapMin <= HK.MAX_SLEEP_MIN) {
    state.sleep[today] = { bed: la, wake: nowMs, durationMin: gapMin, source: "AUTO", corrected: false };
    return { kind: "woke", dateIso: today, durationMin: gapMin, inferred: true };
  }
  return { kind: "none" };
};

HK.setSleepManual = (state, dateIso, bedMs, wakeMs) => {
  const durationMin = Math.max(0, Math.floor((wakeMs - bedMs) / 60000));
  state.sleep[dateIso] = { bed: bedMs, wake: wakeMs, durationMin, source: "MANUAL", corrected: true };
  return state;
};

// ---------------- チェックイン・運動量 ----------------

HK.setCheckin = (state, dateIso, field, value) => {
  if (!["mood", "focus", "irritation", "note", "kirokuNote"].includes(field)) return false;
  if (!state.checkin[dateIso]) state.checkin[dateIso] = {};
  state.checkin[dateIso][field] = value;
  return true;
};

/** 起床後の「眠りの質」1-3(1=あさい, 2=ふつう, 3=ぐっすり) */
HK.setSleepQuality = (state, dateIso, quality) => {
  const sl = state.sleep[dateIso];
  if (!sl) return false;
  sl.quality = quality;
  return true;
};

HK.setExercise = (state, dateIso, level) => { state.exercise[dateIso] = level; return state; };

// ---------------- イベント記録 ----------------

HK.logEvent = (state, type, label, nowMs, tier) => {
  const e = { id: state.nextEventId++, t: nowMs, type, label: label || null };
  if (type === "MEAL") e.tier = tier || 2;
  state.events.push(e);
  state.events.sort((a, b) => a.t - b.t);
  return e.id;
};

HK.undoEventById = (state, id) => HK.deleteEventById(state, id);

HK.deleteEventById = (state, id) => {
  const before = state.events.length;
  state.events = state.events.filter((e) => e.id !== id);
  return state.events.length < before;
};

HK.updateEventTime = (state, id, newMs) => {
  const e = state.events.find((x) => x.id === id);
  if (!e) return false;
  e.t = newMs;
  state.events.sort((a, b) => a.t - b.t);
  return true;
};

/** 食事の種類(label)を後から設定 */
HK.setEventLabel = (state, id, label) => {
  const e = state.events.find((x) => x.id === id);
  if (!e) return false;
  e.label = label;
  return true;
};

/** 食事の店(place)を後から設定。任意項目なので空なら null。 */
HK.setEventPlace = (state, id, place) => {
  const e = state.events.find((x) => x.id === id);
  if (!e) return false;
  e.place = place ? place : null;
  return true;
};

/** 食事の健康度tier(1-3)を修正。MEALのみ。 */
HK.setEventTier = (state, id, tier) => {
  const e = state.events.find((x) => x.id === id);
  if (!e || e.type !== "MEAL") return false;
  e.tier = tier;
  return true;
};

/** 論理日でイベントを取得 */
HK.eventsOn = (state, dateIso) =>
  state.events.filter((e) => HK.logicalDateIso(e.t) === dateIso);

// ---------------- 体調(オンデマンド) / Personal Context ----------------

/** 衝突しにくいローカルID(体調・facts・健診用。低頻度データなので十分) */
HK.uid = () => Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);

HK.CONDITION_PRESETS = [
  { emoji: "🤒", label: "熱・発熱" }, { emoji: "😷", label: "のどの痛み" },
  { emoji: "🤧", label: "鼻・風邪" }, { emoji: "🤢", label: "腹痛・胃腸" },
  { emoji: "🤕", label: "頭痛" }, { emoji: "🦷", label: "歯の痛み" },
  { emoji: "💢", label: "肩こり・腰痛" }, { emoji: "😪", label: "だるさ・倦怠感" }
];

HK.addCondition = (state, label, emoji, nowMs, note) => {
  if (!state.conditions) state.conditions = [];
  const c = { id: HK.uid(), emoji: emoji || "🩹", label: String(label).slice(0, 40),
    startIso: HK.logicalDateIso(nowMs), resolvedIso: null, note: note ? String(note).slice(0, 60) : null };
  state.conditions.push(c);
  return c.id;
};
HK.resolveCondition = (state, id, nowMs) => {
  const c = (state.conditions || []).find((x) => x.id === id);
  if (!c) return false;
  c.resolvedIso = HK.logicalDateIso(nowMs);
  return true;
};
HK.reopenCondition = (state, id) => {
  const c = (state.conditions || []).find((x) => x.id === id);
  if (!c) return false;
  c.resolvedIso = null;
  return true;
};
HK.deleteCondition = (state, id) => {
  const before = (state.conditions || []).length;
  state.conditions = (state.conditions || []).filter((x) => x.id !== id);
  return state.conditions.length < before;
};
/** 未解決(続いている)の体調 */
HK.activeConditions = (state) => (state.conditions || []).filter((c) => !c.resolvedIso);

const ensurePC = (state) => {
  if (!state.personalContext) state.personalContext = { facts: [], healthChecks: [] };
  if (!Array.isArray(state.personalContext.facts)) state.personalContext.facts = [];
  if (!Array.isArray(state.personalContext.healthChecks)) state.personalContext.healthChecks = [];
  return state.personalContext;
};
/** 本人の背景事実を追加。source: "user"(手入力) | "ai"(健診解析など) */
HK.addFact = (state, text, source) => {
  const pc = ensurePC(state);
  const f = { id: HK.uid(), text: String(text).slice(0, 200), source: source === "ai" ? "ai" : "user", createdAt: Date.now() };
  pc.facts.push(f);
  return f.id;
};
HK.updateFact = (state, id, text) => {
  const f = ensurePC(state).facts.find((x) => x.id === id);
  if (!f) return false;
  f.text = String(text).slice(0, 200);
  return true;
};
HK.deleteFact = (state, id) => {
  const pc = ensurePC(state);
  const before = pc.facts.length;
  pc.facts = pc.facts.filter((x) => x.id !== id);
  return pc.facts.length < before;
};
/** 健診結果を追加(要約＋任意の値＋端末内画像ID)。imageIdの実体はIndexedDB(Phase4b)。 */
HK.addHealthCheck = (state, hc) => {
  const pc = ensurePC(state);
  const h = { id: HK.uid(), dateIso: (hc && hc.dateIso) || HK.logicalDateIso(Date.now()),
    summary: String((hc && hc.summary) || "").slice(0, 2000),
    values: (hc && hc.values) || null, imageId: (hc && hc.imageId) || null, createdAt: Date.now() };
  pc.healthChecks.push(h);
  return h.id;
};

/** AIレポート用の文脈payload(体調・Personal Context)。生ログではなく要約のみ。 */
HK.buildContextPayload = (state, nowMs) => {
  const pc = ensurePC(state);
  const active = HK.activeConditions(state).map((c) => ({ label: c.label, since: c.startIso, note: c.note || undefined }));
  const cutoff = HK.logicalDateIso(nowMs - 14 * 86400000);
  const recent = (state.conditions || [])
    .filter((c) => (c.resolvedIso || c.startIso) >= cutoff)
    .map((c) => ({ label: c.label, from: c.startIso, to: c.resolvedIso || null }));
  const hc = pc.healthChecks.slice().sort((a, b) => a.createdAt - b.createdAt).pop();
  return {
    personal_context: pc.facts.length ? pc.facts.map((f) => f.text) : null,
    active_conditions: active.length ? active : null,
    recent_conditions: recent.length ? recent : null,
    latest_health_check: hc ? { date: hc.dateIso, summary: hc.summary } : null
  };
};

// ---------------- 週次集計 ----------------

HK.parseHHmm = (s) => {
  const p = String(s).split(":");
  if (p.length !== 2) return null;
  const h = parseInt(p[0], 10), m = parseInt(p[1], 10);
  if (isNaN(h) || isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
};

HK.averageBedTimeHHmm = (times) => {
  const msn = times.map(HK.parseHHmm).filter((v) => v != null)
    .map((v) => (v - 720 + 1440) % 1440);
  if (!msn.length) return null;
  const avg = Math.floor(msn.reduce((a, b) => a + b, 0) / msn.length);
  const mod = (avg + 720) % 1440;
  const p = (n) => (n < 10 ? "0" + n : "" + n);
  return p(Math.floor(mod / 60)) + ":" + p(mod % 60);
};

HK.countLateCoffee = (times) =>
  times.map(HK.parseHHmm).filter((v) => v != null && v >= HK.LATE_COFFEE_HOUR * 60).length;

const countBy = (labels) => {
  const m = {};
  for (const l of labels) if (l) m[l] = (m[l] || 0) + 1;
  return m;
};
const avgOrNull = (vals, round) => {
  const v = vals.filter((x) => x != null);
  if (!v.length) return null;
  const a = v.reduce((x, y) => x + y, 0) / v.length;
  return round ? Math.round(a * 100) / 100 : Math.floor(a);
};

/** 直近 n 論理日の DaySummary 配列(古い順)。endMs はその論理日に含まれる時刻 */
HK.buildDaySummaries = (state, endMs, nDays) => {
  const days = [];
  for (let i = nDays - 1; i >= 0; i--) {
    const iso = HK.logicalDateIso(endMs - i * 86400000);
    const ev = HK.eventsOn(state, iso);
    const sl = state.sleep[iso] || null;   // 起床日=論理日(起床は4-12時)
    const ck = state.checkin[iso] || {};
    const of = (t) => ev.filter((e) => e.type === t);
    const meals = of("MEAL");
    days.push({
      dateIso: iso,
      sleepDurationMin: sl ? sl.durationMin : null,
      sleepQuality: sl && sl.quality != null ? sl.quality : null,
      bedTimeHHmm: sl ? HK.hhmm(sl.bed) : null,
      wakeTimeHHmm: sl ? HK.hhmm(sl.wake) : null,
      note: ck.note ? String(ck.note).slice(0, 80) : null,
      kirokuNote: ck.kirokuNote ? String(ck.kirokuNote).slice(0, 80) : null,
      coffeeTimesHHmm: of("COFFEE").map((e) => HK.hhmm(e.t)),
      coffeePlaces: of("COFFEE").map((e) => e.label).filter(Boolean),
      meals: meals.map((e) => ({ tier: e.tier || 2, kind: e.label || null, place: e.place || null })),
      activityLabels: of("ACTIVITY").map((e) => e.label),
      noMeal: of("NO_MEAL").length > 0,
      mood: ck.mood != null ? ck.mood : null,
      focus: ck.focus != null ? ck.focus : null,
      irritation: ck.irritation != null ? ck.irritation : null,
      exercise: state.exercise[iso] != null ? state.exercise[iso] : null,
      steps: null
    });
  }
  return days;
};

HK.buildPastWeeks = (state, endMs, nWeeks) => {
  const weeks = [];
  for (let w = nWeeks; w >= 1; w--) {
    const weekEnd = endMs - w * 7 * 86400000;
    const days = HK.buildDaySummaries(state, weekEnd, 7);
    const coffee = [].concat(...days.map((d) => d.coffeeTimesHHmm));
    weeks.push({
      weekStartIso: HK.weekStartIso(weekEnd - 6 * 86400000),
      sleepAvgMin: avgOrNull(days.map((d) => d.sleepDurationMin)),
      coffeeAfter21Count: HK.countLateCoffee(coffee),
      moodAvg: avgOrNull(days.map((d) => d.mood), true)
    });
  }
  return weeks;
};

// ---------------- 週次目標(計画) ----------------

HK.GOAL_FIELDS = ["sleepMin", "greenDays", "exerciseDays", "junkMax", "lateCoffeeMax"];

/** 週(月曜ISO)の目標を設定。value==null で解除。空になった週はキー自体を削除。 */
HK.setGoal = (state, weekIso, field, value) => {
  if (!HK.GOAL_FIELDS.includes(field)) return false;
  if (!state.goals) state.goals = {};
  if (!state.goals[weekIso]) state.goals[weekIso] = {};
  if (value == null) delete state.goals[weekIso][field];
  else state.goals[weekIso][field] = value;
  if (Object.keys(state.goals[weekIso]).length === 0) delete state.goals[weekIso];
  return true;
};

HK.getGoal = (state, weekIso) => (state.goals && state.goals[weekIso]) || {};

/** 現在週(月曜〜その日)の実績を集計。目標との突き合わせはUI側で行う。 */
HK.weekProgress = (state, nowMs) => {
  const weekStart = HK.weekStartIso(nowMs);
  const todayIso = HK.logicalDateIso(nowMs);
  const startMs = new Date(weekStart + "T12:00:00").getTime();
  const todayMs = new Date(todayIso + "T12:00:00").getTime();
  const nDays = Math.max(1, Math.min(7, Math.floor((todayMs - startMs) / 86400000) + 1));
  const days = HK.buildDaySummaries(state, nowMs, nDays).filter((d) => d.dateIso >= weekStart);
  const sleepVals = days.map((d) => d.sleepDurationMin).filter((v) => v != null);
  const coffee = [].concat(...days.map((d) => d.coffeeTimesHHmm));
  return {
    weekStartIso: weekStart,
    daysElapsed: days.length,
    sleepAvgMin: sleepVals.length ? Math.round(sleepVals.reduce((a, b) => a + b, 0) / sleepVals.length) : null,
    recordedSleepDays: sleepVals.length,
    greenDays: days.filter((d) => d.meals.some((m) => m.tier === 1)).length,
    exerciseDays: days.filter((d) => d.exercise != null && d.exercise >= 1).length,
    junkCount: days.reduce((a, d) => a + d.meals.filter((m) => m.tier === 3).length, 0),
    lateCoffee: HK.countLateCoffee(coffee)
  };
};

HK.buildGeminiPayload = (days, pastWeeks, lastExperiment, context) => {
  const sleepVals = days.map((d) => d.sleepDurationMin).filter((v) => v != null);
  const allCoffee = [].concat(...days.map((d) => d.coffeeTimesHHmm));
  const allMeals = [].concat(...days.map((d) => d.meals));
  const tierCount = (t) => allMeals.filter((m) => m.tier === t).length;
  return {
    this_week_stats: {
      sleep_avg_min: avgOrNull(sleepVals),
      sleep_min_min: sleepVals.length ? Math.min(...sleepVals) : null,
      sleep_max_min: sleepVals.length ? Math.max(...sleepVals) : null,
      sleep_recorded_days: sleepVals.length,
      sleep_quality_avg: avgOrNull(days.map((d) => d.sleepQuality), true),
      bed_time_avg: HK.averageBedTimeHHmm(days.map((d) => d.bedTimeHHmm).filter((v) => v != null)),
      coffee_total: allCoffee.length,
      coffee_after_21: HK.countLateCoffee(allCoffee),
      coffee_place_counts: countBy([].concat(...days.map((d) => d.coffeePlaces))),
      meal_tier_counts: { good: tierCount(1), normal: tierCount(2), junk: tierCount(3) },
      meal_kind_counts: countBy(allMeals.map((m) => m.kind)),
      meal_place_counts: countBy(allMeals.map((m) => m.place)),
      activity_counts: countBy([].concat(...days.map((d) => d.activityLabels))),
      mood_avg: avgOrNull(days.map((d) => d.mood), true),
      focus_avg: avgOrNull(days.map((d) => d.focus), true),
      irritation_avg: avgOrNull(days.map((d) => d.irritation), true),
      exercise_avg: avgOrNull(days.map((d) => d.exercise), true)
    },
    days: days.map((d) => ({
      date: d.dateIso, sleep_min: d.sleepDurationMin, sleep_quality: d.sleepQuality,
      bed: d.bedTimeHHmm, wake: d.wakeTimeHHmm,
      coffee: d.coffeeTimesHHmm, coffee_places: d.coffeePlaces,
      meals: d.meals.map((m) => ({ tier: HK.MEAL_TIERS[m.tier], kind: m.kind, place: m.place })),
      activities: d.activityLabels, no_meal: d.noMeal,
      mood: d.mood, focus: d.focus, irritation: d.irritation, exercise: d.exercise,
      note: d.note, kiroku_note: d.kirokuNote
    })),
    past_weeks: pastWeeks.map((w) => ({
      week_start: w.weekStartIso, sleep_avg_min: w.sleepAvgMin,
      coffee_after_21: w.coffeeAfter21Count, mood_avg: w.moodAvg
    })),
    last_week_experiment: lastExperiment || null,
    // 体調・本人背景(要約のみ)。context未指定でも既存挙動を壊さない。
    personal_context: (context && context.personal_context) || null,
    active_conditions: (context && context.active_conditions) || null,
    recent_conditions: (context && context.recent_conditions) || null,
    latest_health_check: (context && context.latest_health_check) || null
  };
};

/** グラフの週別ビュー用: 直近 n 週の週次平均(古い順) */
HK.buildWeeklySeries = (state, endMs, nWeeks) => {
  const out = [];
  for (let w = nWeeks - 1; w >= 0; w--) {
    const weekEnd = endMs - w * 7 * 86400000;
    const days = HK.buildDaySummaries(state, weekEnd, 7);
    const coffee = [].concat(...days.map((d) => d.coffeeTimesHHmm));
    out.push({
      weekStartIso: HK.weekStartIso(weekEnd - 6 * 86400000),
      sleepAvgMin: avgOrNull(days.map((d) => d.sleepDurationMin)),
      qualityAvg: avgOrNull(days.map((d) => d.sleepQuality), true),
      moodAvg: avgOrNull(days.map((d) => d.mood), true),
      focusAvg: avgOrNull(days.map((d) => d.focus), true),
      irritationAvg: avgOrNull(days.map((d) => d.irritation), true),
      exerciseAvg: avgOrNull(days.map((d) => d.exercise), true),
      lateCoffee: HK.countLateCoffee(coffee)
    });
  }
  return out;
};

// ---------------- Gemini プロンプト(設計確定事項。変更注意) ----------------

// デフォルトプロフィール(匿名化済み。設定の「AIに伝える自分のこと」が空のとき使用)
HK.DEFAULT_PROFILE = [
  "- 40代男性、コンサル出身のPlaying Manager。平日休日問わず長時間労働。",
  "- 健診結果は良好。酒・タバコなし。体型は普通。",
  "- 食事は夜1食か夕方+夜の2食。朝昼は空腹にならず、食べると眠くなるため食べない。",
  "  これは本人の選択であり尊重する。矯正提案は禁止。",
  "- 食事は「1品=1記録」。各品に種類(kind: 魚/サラダ/麺類/デザート等)と健康度(tier: good/normal/junk)が付く。",
  "  1食で複数品を選ぶことがある(例: 魚=good, ごはん=normal, デザート=junk)。店(place)は任意記録。",
  "  goodが増えていたら素直に認めてよい。junkを責めない。",
  "- コーヒーは「21時以降に飲んだか」のみ記録する方式(日中の摂取は毎日ほぼ一定のため)。",
  "  21時以降のカフェインが睡眠を阻害する自覚あり。",
  "- 睡眠には眠りの質 sleep_quality(1=あさい/2=ふつう/3=ぐっすり)の自己評価が付くことがある。",
  "- note はその日のひとことメモ(任意)。文脈として重視してよい(例:「終日客先」「プレッシャーが強い」)。",
  "- kiroku_note は食事・運動まわりの補足メモ(任意。例:「外食続き」「食べ過ぎた」「久々に運動」)。",
  "- 夜のチェックイン: mood 気分(1-5) / focus 仕事のはかどり(1-4) / irritation イラッと度(0-3)。",
  "- exercise はその日の運動量の自己評価(0=全然〜3=たくさん)。activitiesは階段・散歩などの瞬間記録。",
  "- 睡眠不足がイライラと集中力低下に直結する。改善の最優先ターゲットは睡眠。",
  "- 運動の現実的選択肢は「自宅マンション11Fまでの階段」と「散歩」のみ。朝運動は不適(眠くなる)。",
  "- 価値観: 子供2人との時間を最優先したい。生活改善の目的は本人と家族の未来の幸せの最大化。"
].join("\n");

HK.TONE_LINES = {
  colleague: "- トーンは有能な同僚。敬意はあるが馴れ馴れしくない。絵文字は使わない。",
  cheer: "- トーンは明るい応援団。データ上の頑張りや改善を具体的な数字とともに言葉にして認める。絵文字を1〜3個使ってよい。ただし根拠のない持ち上げや空虚な励ましはしない。",
  analyst: "- トーンはデータアナリスト。数字と相関を簡潔に述べる。感情表現・絵文字は使わない。"
};

/** 設定(プロフィール・トーン・名前)を反映したシステムプロンプトを構築 */
HK.buildSystemPrompt = (settings) => {
  const st = settings || {};
  const profile = (st.profile && st.profile.trim()) ? st.profile.trim() : HK.DEFAULT_PROFILE;
  const tone = HK.TONE_LINES[st.tone] || HK.TONE_LINES.colleague;
  const name = st.displayName && st.displayName.trim() ? "- ユーザーの呼び名: " + st.displayName.trim() + "さん" : "";
  return [
  "あなたは行動科学に基づく健康コーチです。ユーザーの1週間の健康データを分析し、",
  "週次レポートをJSONで返します。",
  "",
  "# 絶対に守るルール",
  "- 説教・一般論(「朝食を食べましょう」「規則正しい生活を」等)は禁止。",
  "- 提案する実験は必ず1つだけ。来週試せる、5分以内またはゼロ努力のものに限る。",
  "- 1日1〜2食の食事スタイルは本人の合理的な選択として尊重し、食事回数への言及・矯正提案をしない。",
  "- データにないことを推測で断定しない。欠損日は欠損として扱い、記録しなかったことを責めない。",
  "- 睡眠改善を最優先。カフェイン時刻・就寝時刻と、気分/はかどり/イラッと度の相関に注目する。",
  "- payload の personal_context(本人の背景・健診の要点) と active_conditions/recent_conditions(体調不良) がある場合は最優先の文脈として解釈する。体調不良の期間の乱れは責めず、回復を後押しする。latest_health_check の要点は根拠として活用してよい。",
  tone,
  "- 全フィールド合計で400字以内。",
  "",
  "# ユーザープロファイル",
  profile,
  name,
  "",
  "# 出力形式",
  "必ず次のJSONスキーマに従い、JSON以外を一切出力しないこと:",
  '{"sleep_summary":"今週の睡眠の要約(1〜2文)",',
  '"patterns":["データから見えるパターン(最大3つ。なければ空配列)"],',
  '"experiment":{"title":"実験の短い名前","action":"具体的に何をするか(1文)","why":"データ上の根拠(1文)"},',
  '"last_week_experiment_review":"前週の実験の結果検証(前週の実験がnullなら null)",',
  '"one_liner":"本人の価値観に紐づけた前向きな一言(1文)"}'
  ].filter(Boolean).join("\n");
};

// 互換用(テスト・旧コード): デフォルト設定でのプロンプト
HK.SYSTEM_PROMPT = HK.buildSystemPrompt(null);

HK.buildGeminiRequestBody = (payload, settings) => ({
  systemInstruction: { parts: [{ text: HK.buildSystemPrompt(settings) }] },
  contents: [{
    role: "user",
    parts: [{ text: "以下が今週のデータです。週次レポートを生成してください。\n\n" + JSON.stringify(payload) }]
  }],
  // 思考型モデルは思考にもトークンを使うため上限を大きめに確保する
  generationConfig: { responseMimeType: "application/json", temperature: 0.7, maxOutputTokens: 4096 }
});

/** 思考(thought)パーツを除外して本文テキストを抽出。失敗時は {error, detail} */
HK.parseGeminiResponse = (respJson) => {
  try {
    const cand = respJson.candidates && respJson.candidates[0];
    if (!cand) throw new Error("no candidates: " + JSON.stringify(respJson).slice(0, 300));
    const parts = (cand.content && cand.content.parts) || [];
    const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("");
    if (!text) throw new Error("empty text (finishReason=" + (cand.finishReason || "?") + ")");
    const clean = text.replace(/```json/g, "").replace(/```/g, "").trim();
    const o = JSON.parse(clean);
    if (!o.experiment || typeof o.experiment !== "object") throw new Error("no experiment in JSON");
    return { report: o };
  } catch (e) {
    return { error: "レポートの解析に失敗しました。手動で再生成できます。", detail: String(e && e.message || e) };
  }
};

if (typeof module !== "undefined" && module.exports) module.exports = HK;
