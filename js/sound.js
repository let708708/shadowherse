// BGM と効果音。音源ファイルは使わず Web Audio でその場で合成する（曲はすべてオリジナル）。
// iPhone では最初のタップまで音を出せないので、タップ時に初期化する。

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : v;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* 保存できなくても鳴らせる */
    }
  },
};

const settings = { bgm: store.get("sh_bgm", "1") === "1", se: store.get("sh_se", "1") === "1" };
const VOL = { master: 0.8, bgm: 0.24, se: 0.55 };

let ctx = null;
let bgmBus, seBus, noiseBuf;
let wantSong = null;
let current = null;

// ---------- 初期化 ----------

export function initAudio() {
  const unlock = () => {
    ensureCtx();
    if (ctx && ctx.state === "suspended") ctx.resume();
  };
  for (const ev of ["pointerdown", "touchend", "keydown"]) document.addEventListener(ev, unlock, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (!ctx) return;
    if (document.hidden) ctx.suspend();
    else ctx.resume();
  });
}

function ensureCtx() {
  if (ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  const master = ctx.createGain();
  master.gain.value = VOL.master;
  const comp = ctx.createDynamicsCompressor();
  master.connect(comp);
  comp.connect(ctx.destination);
  bgmBus = ctx.createGain();
  bgmBus.gain.value = settings.bgm ? VOL.bgm : 0;
  bgmBus.connect(master);
  seBus = ctx.createGain();
  seBus.gain.value = settings.se ? VOL.se : 0;
  seBus.connect(master);
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  if (wantSong) startSong(wantSong);
}

// ---------- 設定 ----------

export const getSettings = () => ({ ...settings });

export function setBgmOn(on) {
  settings.bgm = on;
  store.set("sh_bgm", on ? "1" : "0");
  if (bgmBus) bgmBus.gain.setTargetAtTime(on ? VOL.bgm : 0, ctx.currentTime, 0.1);
}

export function setSeOn(on) {
  settings.se = on;
  store.set("sh_se", on ? "1" : "0");
  if (seBus) seBus.gain.setTargetAtTime(on ? VOL.se : 0, ctx.currentTime, 0.05);
}

// ---------- 音づくりの部品 ----------

const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function freq(name) {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  if (!m) return 0;
  let n = NOTE[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + (Number(m[3]) + 1) * 12;
  return 440 * Math.pow(2, (n - 69) / 12);
}

function tone(dest, f, t, dur, { type = "triangle", vol = 0.2, a = 0.005, r = 0.08, cutoff = 0, slideTo = 0, detune = 0 } = {}) {
  if (!f) return;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  if (detune) o.detune.value = detune;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + a);
  g.gain.setValueAtTime(vol, t + Math.max(a, dur * 0.6));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur + r);
  let node = o;
  if (cutoff) {
    const fl = ctx.createBiquadFilter();
    fl.type = "lowpass";
    fl.frequency.value = cutoff;
    o.connect(fl);
    node = fl;
  }
  node.connect(g);
  g.connect(dest);
  o.start(t);
  o.stop(t + dur + r + 0.05);
}

function noise(dest, t, dur, { vol = 0.2, type = "highpass", f = 6000, q = 0.7, sweepTo = 0 } = {}) {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf;
  const fl = ctx.createBiquadFilter();
  fl.type = type;
  fl.frequency.setValueAtTime(f, t);
  if (sweepTo) fl.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
  fl.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(fl);
  fl.connect(g);
  g.connect(dest);
  s.start(t, Math.random() * 0.5);
  s.stop(t + dur + 0.05);
}

function kick(dest, t, vol = 0.4) {
  const o = ctx.createOscillator();
  o.frequency.setValueAtTime(150, t);
  o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
  o.connect(g);
  g.connect(dest);
  o.start(t);
  o.stop(t + 0.3);
}

const snare = (dest, t, vol = 0.2) => {
  noise(dest, t, 0.12, { vol, type: "bandpass", f: 1800, q: 0.8 });
  tone(dest, 190, t, 0.03, { type: "triangle", vol: vol * 0.6, r: 0.05 });
};
const hat = (dest, t, vol = 0.05) => noise(dest, t, 0.03, { vol, type: "highpass", f: 7500 });

// ---------- 曲 ----------

const CH = {
  F: ["F3", "A3", "C4"],
  Am: ["A3", "C4", "E4"],
  Bb: ["Bb3", "D4", "F4"],
  C: ["C4", "E4", "G4"],
  Dm: ["D4", "F4", "A4"],
  Gm: ["G3", "Bb3", "D4"],
  A: ["A3", "C#4", "E4"],
};
const up = (n, oct) => n.replace(/-?\d$/, (d) => String(Number(d) + oct));

// "C5 - A4 ." の形（8分音符ごと、- は伸ばす、. は休み）を [{note, len}] に変換
function parseBar(str) {
  const tk = str.trim().split(/\s+/);
  return tk.map((x, i) => {
    if (x === "-" || x === ".") return null;
    let len = 1;
    while (tk[i + len] === "-") len++;
    return { note: x, len };
  });
}

// のんびりした「おさんぽ」曲（タイトル・ロビー）
const MENU = {
  bpm: 96,
  chords: ["F", "Am", "Bb", "C", "F", "Dm", "Gm", "C"],
  melody: [
    "C5 - A4 C5 F5 - E5 D5",
    "C5 - - A4 E5 - C5 -",
    "D5 - Bb4 D5 F5 - D5 C5",
    "Bb4 - A4 G4 E4 - - .",
    "C5 - A4 C5 F5 - G5 A5",
    "A5 - G5 F5 D5 - F5 -",
    "G5 - F5 D5 Bb4 - C5 D5",
    "E5 - - G5 F5 - - .",
  ].map(parseBar),
  play(out, bar, s, t, st) {
    const ch = CH[this.chords[bar]];
    if (s % 2 === 0) {
      const ev = this.melody[bar][s / 2];
      if (ev) tone(out, freq(ev.note), t, ev.len * 2 * st * 0.85, { type: "triangle", vol: 0.17, r: 0.12 });
      // マリンバ風の分散和音
      const n = up(ch[[0, 1, 2, 1][(s / 2) % 4]], 1);
      tone(out, freq(n), t, st * 1.2, { type: "sine", vol: 0.07, r: 0.15 });
      tone(out, freq(n) * 4, t, st * 0.3, { type: "sine", vol: 0.012, r: 0.05 });
    }
    if (s === 0 || s === 8) {
      const root = up(ch[0], -1);
      tone(out, freq(s === 0 ? root : up(ch[2], -1)), t, st * 6, { type: "triangle", vol: 0.17, r: 0.1 });
    }
    if (s === 0 || s === 8) kick(out, t, 0.22);
    if (s === 4 || s === 12) noise(out, t, 0.05, { vol: 0.05, type: "bandpass", f: 3000 });
    if (s % 4 === 2) hat(out, t, 0.035);
  },
};

// 決戦の曲（対戦中）
const BATTLE_MEL = [
  "D5 - F5 - A5 - G5 F5",
  "F5 - D5 - Bb4 - C5 D5",
  "E5 - G5 - C6 - Bb5 A5",
  "A5 - - - C#5 - E5 -",
  "D5 - F5 A5 D6 - C6 A5",
  "Bb5 - A5 G5 D5 - G5 -",
  "F5 - D5 F5 Bb5 - A5 G5",
  "A5 - E5 - C#5 - A4 -",
  "A4 - D5 - F5 - E5 D5",
  "D5 - - - F5 - - -",
  "E5 - C5 - G5 - E5 -",
  "E5 - C#5 - A4 - - -",
  "F5 E5 D5 - A5 - - -",
  "G5 F5 D5 - Bb5 - - -",
  "D6 - C6 Bb5 A5 - G5 F5",
  "E5 - C#5 - E5 - A5 -",
].map(parseBar);
const BATTLE_CH = ["Dm", "Bb", "C", "A", "Dm", "Gm", "Bb", "A", "Dm", "Bb", "C", "A", "Dm", "Gm", "Bb", "A"];

function battlePlay(pinch) {
  return function (out, bar, s, t, st) {
    const ch = CH[BATTLE_CH[bar]];
    if (s % 2 === 0) {
      const ev = BATTLE_MEL[bar][s / 2];
      if (ev) {
        const d = ev.len * 2 * st * 0.9;
        tone(out, freq(ev.note), t, d, { type: "square", vol: 0.06, cutoff: 3200, r: 0.06 });
        tone(out, freq(ev.note), t, d, { type: "sawtooth", vol: 0.03, cutoff: 2200, detune: 8, r: 0.06 });
      }
      const root = up(ch[0], -2);
      const b = [root, root, up(root, 1), root, root, root, up(root, 1), root][s / 2];
      tone(out, freq(b), t, st * 1.6, { type: "sawtooth", vol: 0.11, cutoff: 800, r: 0.03 });
    }
    // 16分の分散和音
    tone(out, freq(up(ch[[0, 1, 2, 1][s % 4]], 1)), t, st * 0.8, { type: "square", vol: 0.022, cutoff: 3000, r: 0.03 });
    if (s === 0 || s === 8 || (s === 10 && bar % 2 === 1) || (pinch && s === 14)) kick(out, t, 0.42);
    if (s === 4 || s === 12) snare(out, t, 0.2);
    if (pinch || s % 2 === 0) hat(out, t, s % 4 === 2 ? 0.06 : 0.035);
    if (bar % 8 === 7 && s >= 12) snare(out, t, 0.12); // フィルイン
  };
}

const SONGS = {
  menu: { bpm: MENU.bpm, bars: 8, play: MENU.play.bind(MENU) },
  battle: { bpm: 138, bars: 16, play: battlePlay(false) },
  pinch: { bpm: 156, bars: 16, play: battlePlay(true) },
};

// ---------- BGM の再生 ----------

export function bgm(name) {
  if (name === wantSong) return;
  wantSong = name;
  if (!ctx) return; // 最初のタップで鳴り始める
  if (!name) return stopSong();
  // battle と pinch は同じ曲なので、小節の位置を引き継いで切り替える
  if (current && SONGS[name] && ["battle", "pinch"].includes(current.name) && ["battle", "pinch"].includes(name)) {
    current.name = name;
    current.song = SONGS[name];
    return;
  }
  startSong(name);
}

function startSong(name) {
  stopSong();
  const song = SONGS[name];
  if (!song) return;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, ctx.currentTime);
  g.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.6);
  g.connect(bgmBus);
  const c = { name, song, g, step: 0, next: ctx.currentTime + 0.1, timer: 0 };
  c.timer = setInterval(() => tick(c), 25);
  current = c;
}

function stopSong() {
  if (!current) return;
  const c = current;
  current = null;
  clearInterval(c.timer);
  const t = ctx.currentTime;
  c.g.gain.cancelScheduledValues(t);
  c.g.gain.setValueAtTime(c.g.gain.value, t);
  c.g.gain.linearRampToValueAtTime(0.0001, t + 0.4);
  setTimeout(() => c.g.disconnect(), 1500);
}

function tick(c) {
  if (ctx.state !== "running") return;
  const st = 60 / c.song.bpm / 4;
  if (c.next < ctx.currentTime - 0.2) c.next = ctx.currentTime + 0.05; // 復帰時にまとめて鳴らさない
  while (c.next < ctx.currentTime + 0.15) {
    const total = c.song.bars * 16;
    const step = c.step % total;
    c.song.play(c.g, Math.floor(step / 16), step % 16, c.next, st);
    c.step = (step + 1) % total;
    c.next += st;
  }
}

// ---------- 効果音 ----------

const SE = {
  tap(o, t) {
    tone(o, 1046, t, 0.03, { type: "sine", vol: 0.12, r: 0.04 });
  },
  select(o, t) {
    tone(o, 784, t, 0.04, { type: "triangle", vol: 0.14, r: 0.04 });
    tone(o, 1175, t + 0.05, 0.05, { type: "triangle", vol: 0.14, r: 0.06 });
  },
  // フォロワーを出す：ぽんっ
  summon(o, t) {
    tone(o, 260, t, 0.12, { type: "sine", vol: 0.4, slideTo: 700, r: 0.08 });
    noise(o, t, 0.15, { vol: 0.12, type: "bandpass", f: 900, sweepTo: 3000 });
    tone(o, 1318, t + 0.1, 0.08, { type: "triangle", vol: 0.1, r: 0.1 });
  },
  // スペル：きらきら
  spell(o, t) {
    ["C6", "E6", "G6", "C7", "E7"].forEach((n, i) => tone(o, freq(n), t + i * 0.045, 0.12, { type: "triangle", vol: 0.11, r: 0.2 }));
    noise(o, t, 0.4, { vol: 0.05, type: "highpass", f: 8000 });
  },
  // フォロワーへの攻撃：ぬいぐるみらしい「ぽふっ」
  hit(o, t) {
    noise(o, t, 0.16, { vol: 0.45, type: "lowpass", f: 1400, sweepTo: 300 });
    tone(o, 180, t, 0.08, { type: "sine", vol: 0.35, slideTo: 90, r: 0.05 });
  },
  // リーダーへのダメージ：重めの「どすっ」
  hitLeader(o, t) {
    kick(o, t, 0.8);
    noise(o, t, 0.3, { vol: 0.35, type: "lowpass", f: 900, sweepTo: 150 });
    tone(o, 110, t + 0.02, 0.2, { type: "square", vol: 0.08, cutoff: 600, slideTo: 60 });
  },
  // 退場：ぴゅーん
  death(o, t) {
    tone(o, 880, t, 0.35, { type: "square", vol: 0.07, cutoff: 2500, slideTo: 140, r: 0.05 });
    tone(o, 660, t + 0.05, 0.3, { type: "triangle", vol: 0.1, slideTo: 110, r: 0.05 });
  },
  heal(o, t) {
    ["E5", "G#5", "B5", "E6"].forEach((n, i) => tone(o, freq(n), t + i * 0.07, 0.25, { type: "sine", vol: 0.13, r: 0.25 }));
  },
  buff(o, t) {
    ["C5", "E5", "G5"].forEach((n, i) => tone(o, freq(n), t + i * 0.05, 0.07, { type: "square", vol: 0.06, cutoff: 3000, r: 0.05 }));
    tone(o, freq("C6"), t + 0.15, 0.15, { type: "square", vol: 0.06, cutoff: 3000, r: 0.1 });
  },
  draw(o, t) {
    noise(o, t, 0.12, { vol: 0.12, type: "bandpass", f: 1500, sweepTo: 6000, q: 1.2 });
  },
  shuffle(o, t) {
    for (let i = 0; i < 4; i++) noise(o, t + i * 0.06, 0.05, { vol: 0.1, type: "bandpass", f: 2500, q: 1.5 });
  },
  myTurn(o, t) {
    tone(o, freq("G5"), t, 0.15, { type: "sine", vol: 0.2, r: 0.3 });
    tone(o, freq("G5") * 2, t, 0.1, { type: "sine", vol: 0.04, r: 0.2 });
    tone(o, freq("C6"), t + 0.13, 0.25, { type: "sine", vol: 0.2, r: 0.5 });
    tone(o, freq("C6") * 2, t + 0.13, 0.15, { type: "sine", vol: 0.04, r: 0.3 });
  },
  turn(o, t) {
    tone(o, freq("E5"), t, 0.12, { type: "sine", vol: 0.12, r: 0.25 });
    tone(o, freq("B4"), t + 0.12, 0.2, { type: "sine", vol: 0.12, r: 0.35 });
  },
  error(o, t) {
    tone(o, 160, t, 0.08, { type: "square", vol: 0.08, cutoff: 1200 });
    tone(o, 160, t + 0.12, 0.08, { type: "square", vol: 0.08, cutoff: 1200 });
  },
  start(o, t) {
    ["D5", "F5", "A5", "D6"].forEach((n, i) => tone(o, freq(n), t + i * 0.08, 0.1, { type: "square", vol: 0.07, cutoff: 3000 }));
    snare(o, t + 0.32, 0.25);
    tone(o, freq("D6"), t + 0.32, 0.4, { type: "sawtooth", vol: 0.06, cutoff: 2500, r: 0.3 });
  },
  win(o, t) {
    const seq = [["C5", 0], ["E5", 0.12], ["G5", 0.24], ["C6", 0.36], ["G5", 0.6], ["C6", 0.72]];
    seq.forEach(([n, d]) => tone(o, freq(n), t + d, 0.1, { type: "square", vol: 0.08, cutoff: 3500, r: 0.05 }));
    ["C5", "E5", "G5", "C6"].forEach((n) => tone(o, freq(n), t + 0.9, 1.1, { type: "triangle", vol: 0.1, r: 0.6 }));
    kick(o, t + 0.9, 0.5);
    noise(o, t + 0.9, 1.2, { vol: 0.06, type: "highpass", f: 7000 });
  },
  lose(o, t) {
    [["G4", 0], ["F#4", 0.35], ["F4", 0.7]].forEach(([n, d]) => tone(o, freq(n), t + d, 0.3, { type: "triangle", vol: 0.15, r: 0.1 }));
    tone(o, freq("E4"), t + 1.05, 0.9, { type: "triangle", vol: 0.15, r: 0.5, slideTo: freq("D4") });
  },
};

export function se(name, delay = 0) {
  if (!ctx || !settings.se || ctx.state !== "running") return;
  const f = SE[name];
  if (f) f(seBus, ctx.currentTime + 0.01 + delay);
}
