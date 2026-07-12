/**
 * ヘルスきち core.js v2 — ロジック層(UI非依存・Nodeでテスト可能)
 *
 * v1からの変更(2026-07-12 施主フィードバック反映):
 *   - チップ4グループ化: 食事 / 健康なもの / コーヒー(店舗) / 運動 — すべて設定で編集可能
 *   - 睡眠のタップフリー推定: 「おやすみ」タップなしでも、夜間の最終操作〜朝の起動の間隔から自動記録
 *   - イベントの時刻修正・削除(あとからのまとめ入力に対応)
 *   - デフォルトモデルを gemini-3.5-flash に変更(施主指定)
 *
 * 設計原則(CLAUDE.md):
 *   入力させたら負け / 説教禁止 / 折れても責めない / 推定できないなら null
 */
"use strict";

const HK = {};

// ---------------- 定数 ----------------

// 施主指定(2026-07)。存在しないモデル名なら設定画面の「接続を確認」で即判明する設計
HK.DEFAULT_MODEL = "gemini-3.5-flash";
HK.LATE_COFFEE_HOUR = 21;
HK.MIN_SLEEP_MIN = 180;         // これ未満は睡眠として確定しない(夜中の中断とみなす)
HK.MAX_SLEEP_MIN = 16 * 60;     // これ超は睡眠とみなさない(半日放置の誤記録防止)
HK.STALE_WAKE_HOUR = 12;        // この時刻以降は自動確定しない
HK.WAKE_WINDOW_START_HOUR = 4;  // 朝の自動確定はこの時刻以降
HK.NIGHT_ACTIVE_FROM = 20;      // タップフリー推定: 最終操作がこの時刻以降(〜翌4時)なら「就寝前の操作」とみなす

HK.DEFAULT_MEAL_CHIPS = ["マック", "日高屋", "サイゼ", "松屋", "スシロー", "大戸屋", "自炊", "その他"];
HK.DEFAULT_HEALTH_CHIPS = ["野菜", "魚", "果物", "サラダ"];
HK.DEFAULT_COFFEE_CHIPS = ["スタバ", "マクドナルド", "ドトール", "タリーズ", "会社のカフェ", "その他"];
HK.DEFAULT_ACTIVITY_CHIPS = ["階段", "散歩"];

// ---------------- 日付ユーティリティ ----------------

HK.dateIso = (ms) => {
  const d = new Date(ms);
  const p = (n) => (n < 10 ? "0" + n : "" + n);
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
};

HK.hhmm = (ms) => {
  const d = new Date(ms);
  const p = (n) => (n < 10 ? "0" + n : "" + n);
  return p(d.getHours()) + ":" + p(d.getMinutes());
};

/** その週の月曜日の ISO 日付 */
HK.weekStartIso = (ms) => {
  const d = new Date(ms);
  const dow = (d.getDay() + 6) % 7; // 月=0
  d.setDate(d.getDate() - dow);
  return HK.dateIso(d.getTime());
};

// ---------------- ストレージスキーマ ----------------

HK.emptyState = () => ({
  version: 2,
  events: [],          // {id, t: millis, type: "MEAL"|"HEALTH"|"COFFEE"|"ACTIVITY"|"NO_MEAL", label: string|null}
  nextEventId: 1,
  sleep: {},           // dateIso(起床日) -> {bed, wake, durationMin, source: "AUTO"|"MANUAL", corrected}
  mood: {},            // dateIso -> {score: 1..5, note}
  reports: [],         // {weekStart, report: object, createdAt}
  settings: {
    apiKey: "",
    model: "",         // 空なら DEFAULT_MODEL に解決される
    mealChips: HK.DEFAULT_MEAL_CHIPS.slice(),
    healthChips: HK.DEFAULT_HEALTH_CHIPS.slice(),
    coffeeChips: HK.DEFAULT_COFFEE_CHIPS.slice(),
    activityChips: HK.DEFAULT_ACTIVITY_CHIPS.slice(),
    lastExperiment: null
  },
  pendingBed: null,    // おやすみタップ済み・未確定の就寝時刻(millis)
  lastActiveAt: null   // アプリを最後に操作した時刻(タップフリー睡眠推定に使用)
});

/** 旧バージョンのstateを現行スキーマへ移行(前方互換) */
HK.migrate = (s) => {
  const base = HK.emptyState();
  for (const k of Object.keys(base)) if (!(k in s)) s[k] = base[k];
  for (const k of Object.keys(base.settings)) if (!(k in s.settings)) s.settings[k] = base.settings[k];
  s.events = (s.events || []).map((e) => {
    if (e.type === "STAIRS") return Object.assign({}, e, { type: "ACTIVITY", label: "階段" });
    if (e.type === "WALK") return Object.assign({}, e, { type: "ACTIVITY", label: "散歩" });
    return e;
  });
  let id = s.nextEventId || 1;
  for (const e of s.events) if (e.id == null) e.id = id++;
  s.nextEventId = Math.max(id, ...s.events.map((e) => e.id + 1), 1);
  s.version = 2;
  return s;
};

HK.resolveModel = (settings) => {
  const m = settings && settings.model;
  return m && m.trim() ? m.trim() : HK.DEFAULT_MODEL;
};

// ---------------- 睡眠 ----------------
// 3経路(精度順): ①🌙おやすみタップ(任意) ②タップフリー推定(夜の最終操作〜朝の起動) ③手動入力

HK.markBed = (state, nowMs) => { state.pendingBed = nowMs; return state; };

/** アプリの操作を記録(クリック/表示のたびにUI層が呼ぶ) */
HK.touch = (state, nowMs) => { state.lastActiveAt = nowMs; return state; };

/**
 * アプリを開いた瞬間に呼ぶ。戻り値:
 *   {kind:"none"} / {kind:"woke", dateIso, durationMin, inferred} /
 *   {kind:"short"}(就寝から浅い・深夜の点灯) / {kind:"stale"}(おやすみ失効)
 */
HK.resolveWakeOnOpen = (state, nowMs) => {
  const today = HK.dateIso(nowMs);
  const h = new Date(nowMs).getHours();

  // ① 明示的な「おやすみ」がある場合(最優先)
  if (state.pendingBed != null) {
    if (state.sleep[today]) { state.pendingBed = null; return { kind: "none" }; }
    const bed = state.pendingBed;
    const elapsedMin = Math.floor((nowMs - bed) / 60000);
    if (elapsedMin < HK.MIN_SLEEP_MIN) return { kind: "short" };
    if (h >= HK.STALE_WAKE_HOUR && elapsedMin > HK.MAX_SLEEP_MIN) {
      state.pendingBed = null;
      return { kind: "stale" };
    }
    if (h < HK.WAKE_WINDOW_START_HOUR) return { kind: "short" }; // 深夜0-4時の点灯は起床でない
    state.sleep[today] = { bed, wake: nowMs, durationMin: elapsedMin, source: "AUTO", corrected: false };
    state.pendingBed = null;
    return { kind: "woke", dateIso: today, durationMin: elapsedMin, inferred: false };
  }

  // ② タップフリー推定: 夜間(20時〜翌4時)の最終操作から3時間以上あいて、朝(4〜12時)に開いた
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

/** 手動補正/手動入力。誤った自動値より正直な手入力を尊重 */
HK.setSleepManual = (state, dateIso, bedMs, wakeMs) => {
  const durationMin = Math.max(0, Math.floor((wakeMs - bedMs) / 60000));
  state.sleep[dateIso] = { bed: bedMs, wake: wakeMs, durationMin, source: "MANUAL", corrected: true };
  return state;
};

// ---------------- イベント記録 ----------------

HK.logEvent = (state, type, label, nowMs) => {
  const e = { id: state.nextEventId++, t: nowMs, type, label: label || null };
  state.events.push(e);
  return e.id;
};

HK.undoLastEvent = (state) => state.events.pop() || null;

HK.deleteEventById = (state, id) => {
  const before = state.events.length;
  state.events = state.events.filter((e) => e.id !== id);
  return state.events.length < before;
};

/** 時刻の修正(あとからのまとめ入力用)。修正後は時系列に並べ直す */
HK.updateEventTime = (state, id, newMs) => {
  const e = state.events.find((x) => x.id === id);
  if (!e) return false;
  e.t = newMs;
  state.events.sort((a, b) => a.t - b.t);
  return true;
};

HK.eventsOn = (state, dateIso) =>
  state.events.filter((e) => HK.dateIso(e.t) === dateIso);

// ---------------- 週次集計 ----------------

HK.parseHHmm = (s) => {
  const p = String(s).split(":");
  if (p.length !== 2) return null;
  const h = parseInt(p[0], 10), m = parseInt(p[1], 10);
  if (isNaN(h) || isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
};

/** 就寝時刻平均・深夜0時またぎ対応(正午からの経過分で平均) */
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

/** 直近 n 日の DaySummary 配列(古い順) */
HK.buildDaySummaries = (state, endMs, nDays) => {
  const days = [];
  for (let i = nDays - 1; i >= 0; i--) {
    const iso = HK.dateIso(endMs - i * 86400000);
    const ev = HK.eventsOn(state, iso);
    const sl = state.sleep[iso] || null;
    const mood = state.mood[iso] || null;
    const of = (t) => ev.filter((e) => e.type === t);
    days.push({
      dateIso: iso,
      sleepDurationMin: sl ? sl.durationMin : null,
      bedTimeHHmm: sl ? HK.hhmm(sl.bed) : null,
      wakeTimeHHmm: sl ? HK.hhmm(sl.wake) : null,
      coffeeTimesHHmm: of("COFFEE").map((e) => HK.hhmm(e.t)),
      coffeePlaces: of("COFFEE").map((e) => e.label).filter(Boolean),
      mealLabels: of("MEAL").map((e) => e.label),
      healthLabels: of("HEALTH").map((e) => e.label),
      activityLabels: of("ACTIVITY").map((e) => e.label),
      noMeal: of("NO_MEAL").length > 0,
      moodScore: mood ? mood.score : null,
      steps: null // PWAでは歩数センサー非対応(native移行時に有効化)
    });
  }
  return days;
};

/** 過去週の要約 */
HK.buildPastWeeks = (state, endMs, nWeeks) => {
  const weeks = [];
  for (let w = nWeeks; w >= 1; w--) {
    const weekEnd = endMs - w * 7 * 86400000;
    const days = HK.buildDaySummaries(state, weekEnd, 7);
    const sleepVals = days.map((d) => d.sleepDurationMin).filter((v) => v != null);
    const moodVals = days.map((d) => d.moodScore).filter((v) => v != null);
    const coffee = [].concat(...days.map((d) => d.coffeeTimesHHmm));
    weeks.push({
      weekStartIso: HK.weekStartIso(weekEnd - 6 * 86400000),
      sleepAvgMin: sleepVals.length ? Math.floor(sleepVals.reduce((a, b) => a + b) / sleepVals.length) : null,
      coffeeAfter21Count: HK.countLateCoffee(coffee),
      moodAvg: moodVals.length ? moodVals.reduce((a, b) => a + b) / moodVals.length : null
    });
  }
  return weeks;
};

/** Gemini 送信ペイロード */
HK.buildGeminiPayload = (days, pastWeeks, lastExperiment) => {
  const sleepVals = days.map((d) => d.sleepDurationMin).filter((v) => v != null);
  const moodVals = days.map((d) => d.moodScore).filter((v) => v != null);
  const allCoffee = [].concat(...days.map((d) => d.coffeeTimesHHmm));
  const round2 = (x) => Math.round(x * 100) / 100;
  return {
    this_week_stats: {
      sleep_avg_min: sleepVals.length ? Math.floor(sleepVals.reduce((a, b) => a + b) / sleepVals.length) : null,
      sleep_min_min: sleepVals.length ? Math.min(...sleepVals) : null,
      sleep_max_min: sleepVals.length ? Math.max(...sleepVals) : null,
      sleep_recorded_days: sleepVals.length,
      bed_time_avg: HK.averageBedTimeHHmm(days.map((d) => d.bedTimeHHmm).filter((v) => v != null)),
      coffee_total: allCoffee.length,
      coffee_after_21: HK.countLateCoffee(allCoffee),
      coffee_place_counts: countBy([].concat(...days.map((d) => d.coffeePlaces))),
      meal_counts: countBy([].concat(...days.map((d) => d.mealLabels))),
      health_counts: countBy([].concat(...days.map((d) => d.healthLabels))),
      activity_counts: countBy([].concat(...days.map((d) => d.activityLabels))),
      mood_avg: moodVals.length ? round2(moodVals.reduce((a, b) => a + b) / moodVals.length) : null,
      steps_avg: null
    },
    days: days.map((d) => ({
      date: d.dateIso, sleep_min: d.sleepDurationMin, bed: d.bedTimeHHmm, wake: d.wakeTimeHHmm,
      coffee: d.coffeeTimesHHmm, coffee_places: d.coffeePlaces,
      meals: d.mealLabels, healthy_foods: d.healthLabels, activities: d.activityLabels,
      no_meal: d.noMeal, mood: d.moodScore, steps: d.steps
    })),
    past_weeks: pastWeeks.map((w) => ({
      week_start: w.weekStartIso, sleep_avg_min: w.sleepAvgMin,
      coffee_after_21: w.coffeeAfter21Count,
      mood_avg: w.moodAvg == null ? null : round2(w.moodAvg)
    })),
    last_week_experiment: lastExperiment || null
  };
};

// ---------------- Gemini プロンプト(設計確定事項。変更注意) ----------------

HK.USER_PROFILE = [
  "- 43歳男性、コンサル出身のPlaying Manager。平日休日問わず長時間労働。",
  "- 健診結果は良好。酒・タバコなし。体型は普通。",
  "- 食事は夜1食か夕方+夜の2食。朝昼は空腹にならず、食べると眠くなるため食べない。",
  "  これは本人の選択であり尊重する。矯正提案は禁止。",
  "- 外食ローテーション: マクドナルド/日高屋/サイゼリヤ/松屋/スシロー/大戸屋/自炊。",
  "- 野菜・魚など健康的な食品の摂取も記録している(healthy_foods)。増えていたら素直に認めてよい。",
  "- コーヒー習慣あり(店舗も記録)。21時以降のカフェインが睡眠を阻害する自覚あり。",
  "- 睡眠不足がイライラと集中力低下に直結する。改善の最優先ターゲットは睡眠。",
  "- 運動の現実的選択肢は「自宅マンション11Fまでの階段」と「散歩」のみ。朝運動は不適(眠くなる)。",
  "- 価値観: 子供2人との時間を最優先したい。生活改善の目的は本人と家族の未来の幸せの最大化。"
].join("\n");

HK.SYSTEM_PROMPT = [
  "あなたは行動科学に基づく健康コーチです。ユーザーの1週間の健康データを分析し、",
  "週次レポートをJSONで返します。",
  "",
  "# 絶対に守るルール",
  "- 説教・一般論(「朝食を食べましょう」「規則正しい生活を」等)は禁止。",
  "- 提案する実験は必ず1つだけ。来週試せる、5分以内またはゼロ努力のものに限る。",
  "- 1日1〜2食の食事スタイルは本人の合理的な選択として尊重し、食事回数への言及・矯正提案をしない。",
  "- データにないことを推測で断定しない。欠損日は欠損として扱い、記録しなかったことを責めない。",
  "- 睡眠改善を最優先。特にカフェイン時刻・就寝時刻・気分の相関に注目する。",
  "- トーンは有能な同僚。敬意はあるが馴れ馴れしくない。絵文字は使わない。",
  "- 全フィールド合計で400字以内。",
  "",
  "# ユーザープロファイル",
  HK.USER_PROFILE,
  "",
  "# 出力形式",
  "必ず次のJSONスキーマに従い、JSON以外を一切出力しないこと:",
  '{"sleep_summary":"今週の睡眠の要約(1〜2文)",',
  '"patterns":["データから見えるパターン(最大3つ。なければ空配列)"],',
  '"experiment":{"title":"実験の短い名前","action":"具体的に何をするか(1文)","why":"データ上の根拠(1文)"},',
  '"last_week_experiment_review":"前週の実験の結果検証(前週の実験がnullなら null)",',
  '"one_liner":"家族との時間や本人の価値観に紐づけた前向きな一言(1文)"}'
].join("\n");

HK.buildGeminiRequestBody = (payload) => ({
  systemInstruction: { parts: [{ text: HK.SYSTEM_PROMPT }] },
  contents: [{
    role: "user",
    parts: [{ text: "以下が今週のデータです。週次レポートを生成してください。\n\n" + JSON.stringify(payload) }]
  }],
  generationConfig: { responseMimeType: "application/json", temperature: 0.7, maxOutputTokens: 1024 }
});

HK.parseGeminiResponse = (respJson) => {
  try {
    const text = respJson.candidates[0].content.parts[0].text;
    const clean = text.replace(/```json/g, "").replace(/```/g, "").trim();
    const o = JSON.parse(clean);
    if (!o.experiment || typeof o.experiment !== "object") throw new Error("no experiment");
    return { report: o };
  } catch (e) {
    return { error: "レポートの解析に失敗しました。手動で再生成できます。", detail: String(e) };
  }
};

if (typeof module !== "undefined" && module.exports) module.exports = HK;
