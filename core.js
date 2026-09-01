/**
 * ヘルスきち core.js v4 — ロジック層(UI非依存・Nodeでテスト可能)
 *
 * v3からの変更(2026-09 再設計「本当に必要なものだけ」):
 *   - 機能トグル(HK.FEATURE_DEFS / settings.features)を導入。項目は削除せず「隠す」だけ
 *   - 食事に weight(1=軽め/2=ふつう/3=がっつり)を追加。眠気との相関を見るための主軸
 *   - 夜のチェックインに sleepiness(眠気 0-3) を追加
 *   - 種類を記録しない食事に tier をでっち上げない(null のまま)
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
HK.STALE_BED_MIN = 30 * 60;     // 「おやすみ」から30時間を超えたら古すぎるとみなして破棄
HK.WAKE_WINDOW_START_HOUR = 4;
HK.NIGHT_ACTIVE_FROM = 20;
HK.DAY_START_HOUR = 4;          // 論理日の境界。朝4時より前は「前日」扱い

// 食事の「種類」カタログ。tier(健康度 1=good/2=normal/3=junk)と絵文字を内蔵。
// 「1品=1記録」方式: 1食で複数選ぶと同時刻に複数MEALとして記録される。
// MECEを意識した並び(体にいい→ふつう→ジャンク)。既存ラベルは表記ゆれを避けるため変更しない。
// 「その他」を必ず末尾に置き、どれにも当てはまらない食事の受け皿にする(漏れなしの担保)。
HK.MEAL_KINDS = [
  { label: "サラダ・野菜", emoji: "🥗", tier: 1 },
  { label: "魚・海鮮", emoji: "🐟", tier: 1 },
  { label: "寿司", emoji: "🍣", tier: 1 },
  { label: "卵・豆・乳製品", emoji: "🥚", tier: 1 },
  { label: "果物", emoji: "🍎", tier: 1 },
  { label: "定食・和食", emoji: "🍚", tier: 2 },
  { label: "肉料理", emoji: "🍖", tier: 2 },
  { label: "洋食・パスタ", emoji: "🍝", tier: 2 },
  { label: "中華", emoji: "🥟", tier: 2 },
  { label: "麺類", emoji: "🍜", tier: 2 },
  { label: "丼・カレー", emoji: "🍛", tier: 2 },
  { label: "弁当・惣菜", emoji: "🍱", tier: 2 },
  { label: "パン・軽食", emoji: "🍞", tier: 2 },
  { label: "その他", emoji: "🍽", tier: 2 },
  { label: "バーガー・FF", emoji: "🍔", tier: 3 },
  { label: "揚げ物・スナック", emoji: "🍟", tier: 3 },
  { label: "お菓子・デザート", emoji: "🍰", tier: 3 },
  { label: "甘い飲み物・お酒", emoji: "🥤", tier: 3 }
];
HK.DEFAULT_MEAL_KINDS = HK.MEAL_KINDS.map((o) => Object.assign({}, o));
// 旧string配列(v5以前)を新object配列へ移行する際の絵文字/tier対応表(旧名も含む)
HK.MEAL_KIND_LOOKUP = {
  "サラダ・野菜": { emoji: "🥗", tier: 1 }, "魚・海鮮": { emoji: "🐟", tier: 1 },
  "寿司": { emoji: "🍣", tier: 1 }, "寿司・海鮮": { emoji: "🍣", tier: 1 },
  "卵・豆・乳製品": { emoji: "🥚", tier: 1 }, "果物": { emoji: "🍎", tier: 1 },
  "定食・和食": { emoji: "🍚", tier: 2 }, "肉料理": { emoji: "🍖", tier: 2 },
  "洋食・パスタ": { emoji: "🍝", tier: 2 }, "中華": { emoji: "🥟", tier: 2 },
  "麺類": { emoji: "🍜", tier: 2 }, "丼・カレー": { emoji: "🍛", tier: 2 },
  "弁当・惣菜": { emoji: "🍱", tier: 2 }, "パン・軽食": { emoji: "🍞", tier: 2 },
  "その他": { emoji: "🍽", tier: 2 },
  "バーガー・FF": { emoji: "🍔", tier: 3 }, "揚げ物・スナック": { emoji: "🍟", tier: 3 },
  "お菓子・デザート": { emoji: "🍰", tier: 3 }, "お菓子・間食": { emoji: "🍰", tier: 3 },
  "甘い飲み物・お酒": { emoji: "🥤", tier: 3 }
};
// v5以前のmealKinds既定値(未編集判定用)
HK.LEGACY_MEAL_KINDS_V5 = ["定食・和食", "麺類", "丼・カレー", "バーガー・FF", "寿司・海鮮", "パン・軽食", "サラダ・野菜", "お菓子・間食"];
// v6〜v8の既定カタログ(10種)。未編集ならMECE版へ差し替える判定に使う。
HK.LEGACY_MEAL_KINDS_V6 = ["サラダ・野菜", "魚・海鮮", "寿司", "定食・和食", "麺類", "丼・カレー",
  "パン・軽食", "バーガー・FF", "揚げ物・スナック", "お菓子・デザート"];
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
// 食事の「重さ」。眠気との相関を見る主軸(健康度tierより食後の眠気を説明する)。
HK.MEAL_WEIGHTS = { 1: "light", 2: "normal", 3: "heavy" };

// ---------------- 機能トグル ----------------
// 「消すのではなく隠す」ための単一の真実(Single Source of Truth)。
// UI側に表示条件をベタ書きせず、必ず HK.feat(state, "xxx") 経由で参照する。
// def: 新規インストール時の既定。最小構成(1日6〜7タップ)になるよう選んである。
// group: "core"=毎日の記録項目 / "extra"=拡張機能
HK.FEATURE_DEFS = [
  { f: "sleepQuality",  group: "core",  def: true,  label: "眠りの質",           hint: "朝に1タップ。あさい/ふつう/ぐっすり" },
  { f: "sleepiness",    group: "core",  def: true,  label: "眠気",               hint: "夜に1タップ。食べ物との相関に使う" },
  { f: "irritation",    group: "core",  def: true,  label: "イラッと",           hint: "夜に1タップ。睡眠との相関に使う" },
  { f: "mealWeight",    group: "core",  def: true,  label: "食事の重さ",         hint: "食べたら1タップ。軽め/ふつう/がっつり" },
  { f: "exercise",      group: "core",  def: true,  label: "今日の運動量",       hint: "夜に1タップ。全然〜たくさん" },
  { f: "lateCoffee",    group: "core",  def: false, label: "21時以降のコーヒー", hint: "1タップ。睡眠への影響を見たいとき" },
  { f: "mood",          group: "core",  def: false, label: "きぶん",             hint: "5段階。「イラッと」と情報が重なる" },
  { f: "focus",         group: "core",  def: false, label: "はかどり",           hint: "4段階。「眠気」と情報が重なる" },
  { f: "mealKind",      group: "core",  def: false, label: "食事の種類・お店",   hint: "カタログから選ぶ。入力は確実に増える" },
  { f: "activityChips", group: "core",  def: false, label: "運動チップ",         hint: "歩く/階段/筋トレ など。運動量と重なる" },
  { f: "memo",          group: "core",  def: false, label: "メモ",               hint: "1日ひとつの自由入力" },
  { f: "goals",         group: "extra", def: false, label: "週の目標とふりかえり", hint: "週次目標と週末のポップアップ" },
  { f: "aiReport",      group: "extra", def: false, label: "AIレポート",         hint: "Geminiに文章でまとめてもらう" }
];

HK.DEFAULT_FEATURES = () => {
  const o = {};
  for (const d of HK.FEATURE_DEFS) o[d.f] = d.def;
  return o;
};

/** 機能がONか。未設定・未知キーは定義側の既定へフォールバックする(空フォールバック禁止の原則) */
HK.feat = (state, f) => {
  const fx = state && state.settings && state.settings.features;
  if (fx && Object.prototype.hasOwnProperty.call(fx, f)) return !!fx[f];
  const d = HK.FEATURE_DEFS.find((x) => x.f === f);
  return d ? d.def : false;
};

/** 機能のON/OFF。未知キーは false を返して無視する。 */
HK.setFeature = (state, f, on) => {
  if (!HK.FEATURE_DEFS.some((d) => d.f === f)) return false;
  if (!state.settings.features) state.settings.features = HK.DEFAULT_FEATURES();
  state.settings.features[f] = !!on;
  return true;
};

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
  version: 10,
  // events: {id, t, type: "MEAL"|"COFFEE"|"ACTIVITY"|"NO_MEAL", label(=種類),
  //          tier(MEALの健康度1-3。種類未記録ならnull), weight(MEALの重さ1-3), place(店・任意)}
  events: [],
  nextEventId: 1,
  sleep: {},           // 起床日(実日) -> {bed, wake, durationMin, source, corrected}
  checkin: {},         // 論理日 -> {mood?:1-5, focus?:1-4, irritation?:0-3, sleepiness?:0-3, note?, kirokuNote?}
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
    features: HK.DEFAULT_FEATURES(), // 表示する項目のON/OFF。項目は消さず隠すだけ
    logMode: "batch",     // batch=まとめて記録 / quick=都度記録
    displayName: "",
    profile: "",          // 空ならHK.DEFAULT_PROFILEを使用
    tone: "colleague",    // colleague | cheer | analyst
    lastExperiment: null
  },
  pendingBed: null,
  lastActiveAt: null,
  pendingFeatureNotice: false  // v10で項目を隠された既存ユーザーへ、戻し方を1回だけ案内する
});

/** 旧バージョン(v1/v2)のstateを現行スキーマへ移行 */
HK.migrate = (s) => {
  // settings.features の有無は、下の既定値補完ループで埋まる前に判定する必要がある
  const hadFeatures = !!(s.settings && s.settings.features);
  // 移行元のバージョン。tier=null の意味がv10で変わるので、判定に必要。
  const fromVersion = +(s.version) || 1;
  if (!s.settings) s.settings = {};   // 手編集されたJSONのimportで落ちないように
  const base = HK.emptyState();
  for (const k of Object.keys(base)) if (!(k in s)) s[k] = base[k];
  for (const k of Object.keys(base.settings)) if (!(k in s.settings)) s.settings[k] = base.settings[k];
  s.events = (s.events || []).map((e) => {
    if (e.type === "STAIRS") return Object.assign({}, e, { type: "ACTIVITY", label: "階段" });
    if (e.type === "WALK") return Object.assign({}, e, { type: "ACTIVITY", label: "散歩" });
    if (e.type === "HEALTH") return Object.assign({}, e, { type: "MEAL", tier: 1 });      // 健康チップ→良い食事
    // v10より前は「tier未設定=ふつう」だった。v10以降の null は「種類を記録していない」
    // という意味を持つ確定値なので、絶対に埋めない(埋めると重さだけの食事が🟡に化ける)。
    if (e.type === "MEAL" && e.tier == null && fromVersion < 10) return Object.assign({}, e, { tier: 2 });
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
      // v6〜v8の既定カタログのまま(未編集)なら、MECE版へ差し替える。
      // ユーザーが追加・削除・tier変更していれば、その設定を尊重してそのまま残す。
      if (eq(s.settings.mealKinds.map((k) => k.label), HK.LEGACY_MEAL_KINDS_V6)
        && s.settings.mealKinds.every((k) => k.tier === HK.mealKindMeta(k.label).tier)) {
        s.settings.mealKinds = HK.DEFAULT_MEAL_KINDS.map((o) => Object.assign({}, o));
      }
    }
  }
  // 配列であるべき設定が null/壊れた値で入っている場合は既定へ戻す。
  // (手編集されたJSONのimportで、設定画面が .map で落ちるのを防ぐ)
  const ARRAY_SETTINGS = { mealKinds: "DEFAULT_MEAL_KINDS", mealChips: "DEFAULT_MEAL_CHIPS",
    coffeeChips: "DEFAULT_COFFEE_CHIPS", activityChips: "DEFAULT_ACTIVITY_CHIPS" };
  for (const [key, defName] of Object.entries(ARRAY_SETTINGS)) {
    if (!Array.isArray(s.settings[key])) {
      s.settings[key] = HK[defName].map((v) => (typeof v === "object" ? Object.assign({}, v) : v));
    }
  }
  // conditions / personalContext の補完(nested配列の健全性も保証・非破壊)
  if (!Array.isArray(s.conditions)) s.conditions = [];
  if (!s.personalContext || typeof s.personalContext !== "object") s.personalContext = { facts: [], healthChecks: [] };
  if (!Array.isArray(s.personalContext.facts)) s.personalContext.facts = [];
  if (!Array.isArray(s.personalContext.healthChecks)) s.personalContext.healthChecks = [];
  // v10: 機能トグル。既存ユーザーには最小構成の新既定を当て、戻し方を1回だけ案内する。
  if (!hadFeatures) {
    const hasData = (s.events && s.events.length > 0)
      || Object.keys(s.sleep || {}).length > 0
      || Object.keys(s.checkin || {}).length > 0;
    if (hasData) s.pendingFeatureNotice = true;
  } else {
    // 後から増えたフラグだけ既定で補完する。ユーザーが選んだ値は絶対に上書きしない。
    for (const d of HK.FEATURE_DEFS)
      if (!(d.f in s.settings.features)) s.settings.features[d.f] = d.def;
  }
  s.version = 10;
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
    if (elapsedMin > HK.STALE_BED_MIN) { // 丸1日以上前の「おやすみ」は古すぎるので捨てる
      state.pendingBed = null;
      return { kind: "stale" };
    }
    if (h < HK.WAKE_WINDOW_START_HOUR) return { kind: "short" };
    // 朝(4-12時)に開いた場合だけ「開いた時刻=起床」とみなして自動確定する(いちばん確度が高い)。
    // 昼以降に開いた場合、そのまま確定すると起床が遅すぎて過大記録になるため提案に回す。
    if (h < HK.STALE_WAKE_HOUR) {
      state.sleep[today] = { bed, wake: nowMs, durationMin: elapsedMin, source: "AUTO", corrected: false };
      state.pendingBed = null;
      return { kind: "woke", dateIso: today, durationMin: elapsedMin, inferred: false };
    }
    return { kind: "suggest", dateIso: today };
  }

  if (state.sleep[today]) return { kind: "none" };
  // 「最後の操作=就寝」は実際より早すぎることが多い(21時に触って23時に寝る等)。
  // 勝手に確定せず、推定値を提案してワンタップで確定してもらう。
  return HK.estimateSleep(state, nowMs) ? { kind: "suggest", dateIso: today } : { kind: "none" };
};

/** 過去 n 日の記録から「いつもの就寝・起床時刻」(分)を中央値で求める。記録がなければ null */
HK.usualSleepTimes = (state, nowMs, nDays) => {
  const n = nDays || 14;
  const beds = [], wakes = [];
  for (let i = 0; i <= n; i++) {
    const sl = state.sleep[HK.dateIso(nowMs - i * 86400000)];
    if (!sl || sl.bed == null || sl.wake == null) continue;
    beds.push(HK.parseHHmm(HK.hhmm(sl.bed)));
    wakes.push(HK.parseHHmm(HK.hhmm(sl.wake)));
  }
  if (!beds.length) return null;
  const med = (arr) => { const a = arr.slice().sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
  // 就寝は0時をまたぐため、正午を基準にずらしてから中央値を取る
  const bedMin = (med(beds.map((v) => (v - 720 + 1440) % 1440)) + 720) % 1440;
  return { bedMin, wakeMin: med(wakes), days: beds.length };
};

/**
 * 未記録の日について「昨夜の睡眠」の推定値を返す。確定はしない(提案用)。
 * 推定できる材料が何もなければ null(0やダミーで埋めない)。
 * 戻り値: { bedMs, wakeMs, durationMin, basis }
 */
HK.estimateSleep = (state, nowMs) => {
  const today = HK.dateIso(nowMs);
  if (state.sleep[today]) return null;
  const h = new Date(nowMs).getHours();
  const usual = HK.usualSleepTimes(state, nowMs);

  // --- 起床時刻 ---
  let wakeMs = null;
  if (h >= HK.WAKE_WINDOW_START_HOUR && h < HK.STALE_WAKE_HOUR) {
    wakeMs = nowMs;                                   // 朝に開いた = 起きて間もない
  } else if (usual) {
    wakeMs = HK.msFromLogicalDate(today, usual.wakeMin); // 昼以降 = いつもの起床時刻
  } else if (h >= HK.STALE_WAKE_HOUR) {
    return null;                                      // 材料なし(初回利用など)
  } else {
    return null;                                      // 深夜(4時前)はまだ「昨夜」が終わっていない
  }

  // --- 就寝時刻(確度の高い順) ---
  let bedMs = null, basis = null;
  if (state.pendingBed != null && state.pendingBed < wakeMs) {
    bedMs = state.pendingBed; basis = "bed";          // 「おやすみ」を押していた
  } else if (usual) {
    const cand = HK.msFromLogicalDate(HK.dateIso(wakeMs - 86400000), usual.bedMin);
    if (cand < wakeMs) { bedMs = cand; basis = "usual"; }  // いつもの就寝時刻
  }
  if (bedMs == null) {
    const la = state.lastActiveAt;
    const lah = la != null ? new Date(la).getHours() : null;
    if (la != null && la < wakeMs && (lah >= HK.NIGHT_ACTIVE_FROM || lah < HK.WAKE_WINDOW_START_HOUR)) {
      bedMs = la; basis = "activity";                 // 最後に触った時刻(いちばん粗い)
    }
  }
  if (bedMs == null) return null;

  const durationMin = Math.floor((wakeMs - bedMs) / 60000);
  if (durationMin < HK.MIN_SLEEP_MIN || durationMin > HK.MAX_SLEEP_MIN) return null;
  return { bedMs, wakeMs, durationMin, basis };
};

/** 提案を受け入れて記録する(source=AUTO扱い。あとから時計タップで修正可能) */
HK.acceptSleepEstimate = (state, nowMs) => {
  const est = HK.estimateSleep(state, nowMs);
  if (!est) return null;
  const dateIso = HK.dateIso(est.wakeMs);
  state.sleep[dateIso] = { bed: est.bedMs, wake: est.wakeMs, durationMin: est.durationMin,
    source: "AUTO", corrected: false };
  state.pendingBed = null;
  return { dateIso, durationMin: est.durationMin };
};

/**
 * 睡眠テキストの取り込み(ヘルスコネクト等からコピーした文字列 / URLの #sleep= 経由)。
 * 対応形式(1行1睡眠・複数行可):
 *   "23:40-07:10" / "23:40 → 07:10" / "23:40〜7:10"
 *   "2026-07-30 23:40-07:10"  (日付= 起床日 or 就寝日 のどちらでも解釈できるよう、起床日を優先)
 * 戻り値: [{ dateIso, bedMs, wakeMs, durationMin }]。解釈できない行は無視する。
 */
HK.parseSleepText = (text, nowMs) => {
  const out = [];
  const lines = String(text || "").split(/[\n,;]+/);
  const re = /(?:(\d{4})[-/](\d{1,2})[-/](\d{1,2})\D+)?(\d{1,2}):(\d{2})\s*(?:-|~|〜|–|—|→|to|~>)\s*(\d{1,2}):(\d{2})/;
  for (const line of lines) {
    const m = re.exec(line);
    if (!m) continue;
    const bedMin = (+m[4]) * 60 + (+m[5]);
    const wakeMin = (+m[6]) * 60 + (+m[7]);
    if (+m[4] > 23 || +m[6] > 23 || +m[5] > 59 || +m[7] > 59) continue;
    // 起床日を確定する。日付指定がなければ「今日(=いちばん近い過去の起床)」とみなす。
    let wakeDay;
    if (m[1]) {
      const p = (n) => (+n < 10 ? "0" + (+n) : "" + (+n));
      wakeDay = m[1] + "-" + p(m[2]) + "-" + p(m[3]);
    } else {
      wakeDay = HK.dateIso(nowMs == null ? Date.now() : nowMs);
    }
    const base = new Date(wakeDay + "T00:00:00").getTime();
    const wakeMs = base + wakeMin * 60000;
    // 就寝が起床より遅い時刻なら前日の夜
    let bedMs = base + bedMin * 60000;
    if (bedMs >= wakeMs) bedMs -= 86400000;
    const durationMin = Math.floor((wakeMs - bedMs) / 60000);
    if (durationMin < 60 || durationMin > HK.MAX_SLEEP_MIN) continue;
    out.push({ dateIso: HK.dateIso(wakeMs), bedMs, wakeMs, durationMin });
  }
  return out;
};

/** 取り込んだ睡眠をstateへ反映。既存の記録は上書きしない(手で直した値を守る) */
HK.importSleepText = (state, text, nowMs, overwrite) => {
  const rows = HK.parseSleepText(text, nowMs);
  let added = 0, skipped = 0;
  for (const r of rows) {
    if (state.sleep[r.dateIso] && !overwrite) { skipped++; continue; }
    state.sleep[r.dateIso] = { bed: r.bedMs, wake: r.wakeMs, durationMin: r.durationMin,
      source: "IMPORT", corrected: false };
    added++;
  }
  if (added) state.pendingBed = null;
  return { added, skipped, total: rows.length };
};

HK.setSleepManual = (state, dateIso, bedMs, wakeMs) => {
  const durationMin = Math.max(0, Math.floor((wakeMs - bedMs) / 60000));
  state.sleep[dateIso] = { bed: bedMs, wake: wakeMs, durationMin, source: "MANUAL", corrected: true };
  return state;
};

// ---------------- チェックイン・運動量 ----------------

HK.setCheckin = (state, dateIso, field, value) => {
  if (!["mood", "focus", "irritation", "sleepiness", "note", "kirokuNote"].includes(field)) return false;
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

HK.logEvent = (state, type, label, nowMs, tier, weight) => {
  const e = { id: state.nextEventId++, t: nowMs, type, label: label || null };
  if (type === "MEAL") {
    // 種類(label)が分かるならそのtierを使う。種類を記録していないなら null のまま。
    // 「ふつう(2)」を勝手に入れると、記録していない健康度をグラフが語り出す。
    e.tier = tier != null ? tier : (label ? HK.mealKindMeta(label).tier : null);
    e.weight = weight != null ? weight : null;
  }
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

/** 食事の重さ weight(1=軽め/2=ふつう/3=がっつり)を修正。MEALのみ。null で解除。 */
HK.setEventWeight = (state, id, weight) => {
  const e = state.events.find((x) => x.id === id);
  if (!e || e.type !== "MEAL") return false;
  e.weight = weight == null ? null : weight;
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
      meals: meals.map((e) => ({
        tier: e.tier != null ? e.tier : null,
        weight: e.weight != null ? e.weight : null,
        kind: e.label || null, place: e.place || null
      })),
      activityLabels: of("ACTIVITY").map((e) => e.label),
      noMeal: of("NO_MEAL").length > 0,
      mood: ck.mood != null ? ck.mood : null,
      focus: ck.focus != null ? ck.focus : null,
      irritation: ck.irritation != null ? ck.irritation : null,
      sleepiness: ck.sleepiness != null ? ck.sleepiness : null,
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
      sleepinessAvg: avgOrNull(days.map((d) => d.sleepiness), true),
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

// ---------------- 健康診断の読み取り(Gemini Vision) ----------------

HK.buildHealthCheckPrompt = () => [
  "あなたは健康診断結果を読み取るアシスタントです。入力(画像またはテキスト)から要点だけを日本語で抽出し、JSONで返します。",
  "",
  "# ルール",
  "- 入力から読み取れる事実のみを出力する。読めない/不確かな値は出さない(推測で埋めない)。",
  "- 医療診断や治療の指示はしない。所見の要約に留める。",
  "- 氏名・住所・ID等の個人特定情報は summary/facts に含めない。",
  "- 基準値から外れている項目を優先して要約する。",
  "",
  "# 出力形式(このJSON以外は一切出力しない)",
  '{"date":"受診日 YYYY-MM-DD(読めなければ null)",',
  '"summary":"主要所見の要約(2〜4文)",',
  '"values":[{"name":"項目名","value":"値(単位込み)","flag":"H|L|-(基準に対する高低。不明は-)"}],',
  '"facts":["Personal Contextに残す短い事実(例: HbA1c 5.8 でやや高め)。最大4件、なければ空配列"]}'
].join("\n");

HK.buildHealthCheckRequestBody = (base64, mimeType) => ({
  systemInstruction: { parts: [{ text: HK.buildHealthCheckPrompt() }] },
  contents: [{
    role: "user",
    parts: [
      { inlineData: { mimeType: mimeType || "image/jpeg", data: base64 } },
      { text: "この健康診断結果の画像から要点を抽出してください。" }
    ]
  }],
  // 思考型モデルは思考にもトークンを使うため上限を大きめに確保する
  generationConfig: { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: 4096 }
});

/** 健診結果テキストから要点を抽出するリクエスト(画像を使わない・センシティブ回避向け) */
HK.buildHealthCheckTextRequestBody = (text) => ({
  systemInstruction: { parts: [{ text: HK.buildHealthCheckPrompt() }] },
  contents: [{
    role: "user",
    parts: [{ text: "以下の健康診断結果のテキストから要点を抽出してください。\n\n" + String(text || "") }]
  }],
  generationConfig: { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: 4096 }
});

/** 健診解析レスポンスを解析。思考パーツ・コードフェンス除去後にJSON化。失敗時は{error,detail} */
HK.parseHealthCheckResponse = (respJson) => {
  try {
    const cand = respJson.candidates && respJson.candidates[0];
    if (!cand) throw new Error("no candidates: " + JSON.stringify(respJson).slice(0, 300));
    const parts = (cand.content && cand.content.parts) || [];
    const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("");
    if (!text) throw new Error("empty text (finishReason=" + (cand.finishReason || "?") + ")");
    const clean = text.replace(/```json/g, "").replace(/```/g, "").trim();
    const o = JSON.parse(clean);
    if (typeof o.summary !== "string" || !o.summary.trim()) throw new Error("no summary in JSON");
    return {
      result: {
        date: o.date || null,
        summary: o.summary.trim(),
        values: Array.isArray(o.values) ? o.values : [],
        facts: Array.isArray(o.facts) ? o.facts.filter((f) => typeof f === "string" && f.trim()) : []
      }
    };
  } catch (e) {
    return { error: "健診結果の解析に失敗しました。もう一度試せます。", detail: String(e && e.message || e) };
  }
};

if (typeof module !== "undefined" && module.exports) module.exports = HK;
