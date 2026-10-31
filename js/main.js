// 画面の切り替えと全体の流れ。1台で遊ぶモードとオンライン対戦の両方を受け持つ。
import * as R from "./rules.js";
import { createGameUI, esc } from "./ui.js";
import { initAudio, bgm, se, getSettings, setBgmOn, setSeOn } from "./sound.js";

const $ = (s) => document.querySelector(s);
const SCREENS = ["title", "local", "lobby", "game"];
function show(name) {
  SCREENS.forEach((s) => ($("#screen-" + s).hidden = s !== name));
  // 対戦画面の BGM は ui.js が状況に合わせて決める
  if (name !== "game") {
    bgm("menu");
    ui.reset();
  }
}

const store = {
  get(k, d = "") {
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
      /* 保存できなくても遊べる */
    }
  },
};

let DECKS = [];
const deckDef = (id) => DECKS.find((d) => d.id === id) || DECKS[0];
const newGameId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const randomFirst = () => (Math.random() < 0.5 ? "p1" : "p2");

let mode = null; // 'local' | 'online'
let net = null; // Firebase を使うときだけ読み込む

const ui = createGameUI($("#screen-game"), {
  onPlay: (idx, target) => act((p, m, s) => R.playCard(p, m, s, idx, target)),
  onAttack: (uid, target) => act((p, m, s) => R.attack(p, s, uid, target)),
  onEndTurn: () => act((p, m, s) => R.endTurn(p, s)),
  onMulligan,
  onSurrender: () => act((p, m, s) => R.surrender(p, s), { anyTime: true }),
  onRematch,
  onExit,
  onHandoff,
});

// ================= 1台で遊ぶ =================

const L = { pub: null, priv: { p1: null, p2: null }, viewer: "p1", handoff: "", names: null, decks: null };

function localStart(names, decks) {
  mode = "local";
  L.names = names;
  L.decks = decks;
  L.pub = R.newGame({ names, first: randomFirst(), gameId: newGameId() });
  for (const s of ["p1", "p2"]) L.priv[s] = R.deal(L.pub, s, R.deckList(deckDef(decks[s])));
  L.viewer = "p1";
  L.handoff = names.p1;
  show("game");
  renderLocal();
}

function renderLocal() {
  const pub = L.pub;
  const v = L.viewer;
  const mullPending = pub.phase === "mulligan" && !pub.players[v].mulliganDone;
  ui.render({
    mode: "local",
    pub,
    bottom: v,
    top: R.other(v),
    hands: { [v]: L.priv[v].hand, [R.other(v)]: null },
    showTopHand: false,
    isSpectator: false,
    canAct: !L.handoff && R.isMyTurn(pub, v),
    mulligan: !L.handoff && mullPending ? L.priv[v].hand : null,
    handoff: L.handoff,
    waiting: "",
    canRematch: true,
    canSurrender: !pub.winner,
  });
}

function localPassTo(seat) {
  if (L.viewer !== seat) {
    L.viewer = seat;
    L.handoff = L.pub.players[seat].name;
  }
}

function localAfterAction() {
  const pub = L.pub;
  if (pub.phase === "play" && !pub.turnStarted && !pub.winner) {
    R.startTurn(pub, L.priv[pub.active], pub.active);
    localPassTo(pub.active);
  }
  renderLocal();
}

// ================= オンライン =================

const O = {
  code: "",
  uid: "",
  role: "watch",
  meta: null,
  members: {},
  seats: {},
  pub: null,
  mine: null,
  mineLoaded: false,
  priv: { p1: null, p2: null },
  unsubs: [],
  privUnsubs: [],
  done: new Set(),
  deckId: "balance",
};

async function loadNet() {
  if (!net) net = await import("./net.js");
  return net;
}

function netError(e) {
  console.error(e);
  const msg = String((e && e.message) || e);
  if (/permission/i.test(msg)) {
    ui.toast("データベースに拒否されました。Firebase のルール設定を確認してください");
    alert("データベースに拒否されました。\nFirebase コンソールの「ルール」に database.rules.json の中身を貼って「公開」したか確認してください。");
  } else {
    alert("通信エラー：" + msg);
  }
}

async function enterRoom(res) {
  mode = "online";
  Object.assign(O, {
    code: res.code,
    role: res.role,
    meta: null,
    members: {},
    seats: {},
    pub: null,
    mine: null,
    mineLoaded: false,
    priv: { p1: null, p2: null },
    done: new Set(),
  });
  O.uid = await net.signIn();
  O.deckId = store.get("sh_deck", "balance");
  store.set("sh_lastRoom", res.code);
  O.unsubs.forEach((f) => f());
  O.unsubs = [
    net.watchRoom(res.code, {
      onMeta: (v) => {
        O.meta = v;
        refresh();
      },
      onMembers: (v) => {
        O.members = v;
        refresh();
      },
      onSeats: (v) => {
        O.seats = v;
        const role = v.p1 === O.uid ? "p1" : v.p2 === O.uid ? "p2" : "watch";
        if (role !== O.role) {
          O.role = role;
          watchPrivates();
        }
        refresh();
      },
      onPublic: (v) => {
        O.pub = R.normPub(v);
        refresh();
      },
      onError: netError,
    }),
  ];
  watchPrivates();
  show("lobby");
  refresh();
}

function watchPrivates() {
  O.privUnsubs.forEach((f) => f());
  O.privUnsubs = [];
  O.mine = null;
  O.mineLoaded = false;
  O.priv = { p1: null, p2: null };
  if (O.role === "watch") {
    for (const s of ["p1", "p2"]) {
      O.privUnsubs.push(
        net.watchPrivate(O.code, s, (v) => {
          O.priv[s] = R.normMine(v);
          refresh();
        }, netError)
      );
    }
  } else {
    const seat = O.role;
    O.privUnsubs.push(
      net.watchPrivate(O.code, seat, (v) => {
        O.mine = R.normMine(v);
        O.mineLoaded = true;
        refresh();
      }, netError)
    );
  }
}

function leaveRoom() {
  O.unsubs.forEach((f) => f());
  O.privUnsubs.forEach((f) => f());
  O.unsubs = [];
  O.privUnsubs = [];
}

const isHost = () => !!O.meta && O.meta.host === O.uid;

function refresh() {
  if (mode !== "online") return;
  const pub = O.pub;
  if (!pub) {
    show("lobby");
    renderLobby();
    return;
  }
  show("game");
  if (O.role !== "watch") autoSteps(O.role);
  renderOnline();
}

function once(key, fn) {
  if (O.done.has(key)) return;
  O.done.add(key);
  fn();
}

// 自分の端末が受け持つ自動処理：配札、対戦開始、ターン開始
function autoSteps(seat) {
  if (!O.mineLoaded) return;
  const pub = O.pub;
  const mine = O.mine && O.mine.gameId === pub.gameId ? O.mine : null;
  if (!mine) {
    if (pub.phase !== "mulligan") return;
    once("deal:" + pub.gameId, () => {
      const p = R.clone(pub);
      const m = R.deal(p, seat, R.deckList(deckDef(O.deckId)));
      O.pub.players[seat] = p.players[seat];
      O.mine = m;
      net.writeSetup(O.code, seat, p.players[seat], m).catch(netError);
    });
    return;
  }
  if (pub.phase === "mulligan" && R.bothMulliganDone(pub) && pub.active === seat) {
    once("begin:" + pub.gameId, () => {
      const p = R.clone(pub);
      const m = R.clone(mine);
      R.beginPlay(p);
      R.startTurn(p, m, seat);
      commit(p, m);
    });
  } else if (pub.phase === "play" && pub.active === seat && !pub.turnStarted && !pub.winner) {
    once(`start:${pub.gameId}:${pub.turn}`, () => {
      const p = R.clone(pub);
      const m = R.clone(mine);
      R.startTurn(p, m, seat);
      commit(p, m);
    });
  }
}

function commit(p, m) {
  O.pub = p;
  if (m) O.mine = m;
  net.writeTurn(O.code, O.role, p, m).catch(netError);
}

function renderOnline() {
  const pub = O.pub;
  const spec = O.role === "watch";
  const seat = spec ? "p1" : O.role;
  const top = R.other(seat);
  const mineOk = !spec && O.mine && O.mine.gameId === pub.gameId;
  const privHand = (s) => (O.priv[s] && O.priv[s].gameId === pub.gameId ? O.priv[s].hand : []);
  const hands = spec ? { p1: privHand("p1"), p2: privHand("p2") } : { [seat]: mineOk ? O.mine.hand : [], [top]: null };
  let waiting = "";
  if (pub.phase === "mulligan") {
    waiting = spec || pub.players[seat].mulliganDone || !mineOk ? "引き直しを待っています" : "";
  } else if (spec && !pub.winner) {
    waiting = `観戦中：${pub.players[pub.active].name} のターン`;
  }
  ui.render({
    mode: "online",
    pub,
    bottom: seat,
    top,
    hands,
    showTopHand: spec,
    isSpectator: spec,
    canAct: mineOk && R.isMyTurn(pub, seat),
    mulligan: mineOk && pub.phase === "mulligan" && !pub.players[seat].mulliganDone ? O.mine.hand : null,
    handoff: "",
    waiting,
    canRematch: isHost() && !!pub.winner,
    canSurrender: !spec && !pub.winner,
  });
}

// ---- ロビー ----

const ROLE_LABEL = { p1: "プレイヤー1", p2: "プレイヤー2", watch: "観戦" };

function renderLobby() {
  const me = O.members[O.uid] || {};
  const list = Object.entries(O.members)
    .sort((a, b) => (a[1].role > b[1].role ? 1 : -1))
    .map(([uid, m]) => {
      const role = O.seats.p1 === uid ? "p1" : O.seats.p2 === uid ? "p2" : "watch";
      const host = O.meta && O.meta.host === uid ? "（ホスト）" : "";
      const ready = role !== "watch" ? (m.ready ? '<span class="ok">準備OK</span>' : '<span class="ng">準備中</span>') : "";
      return `<li><span>${esc(m.name)}${uid === O.uid ? "（あなた）" : ""}</span><span>${ROLE_LABEL[role]}${host}</span>${ready}</li>`;
    })
    .join("");
  const player = O.role !== "watch";
  const decks = DECKS.map(
    (d) => `<label class="deck ${O.deckId === d.id ? "on" : ""}">
      <input type="radio" name="deck" value="${d.id}" ${O.deckId === d.id ? "checked" : ""} ${me.ready ? "disabled" : ""}>
      <b>${esc(d.name)}</b><small>${esc(d.desc)}</small></label>`
  ).join("");
  const p1m = O.members[O.seats.p1];
  const p2m = O.members[O.seats.p2];
  const canStart = isHost() && p1m && p2m && p1m.ready && p2m.ready;
  $("#lobby-body").innerHTML = `
    <p class="code-label">合言葉</p>
    <p class="code">${esc(O.code)}</p>
    <p class="hint">この4桁を仲間に伝えてください。3人目からは観戦になります。</p>
    <ul class="members">${list}</ul>
    ${
      player
        ? `<p class="sec">デッキを選ぶ</p><div class="decks">${decks}</div>
           <button class="btn ${me.ready ? "" : "primary"}" data-lobby="ready">${me.ready ? "準備を取り消す" : "準備OK"}</button>`
        : '<p class="hint">観戦者として参加中です。対戦が始まると自動で画面が切り替わります。</p>'
    }
    ${isHost() ? `<button class="btn primary" data-lobby="start" ${canStart ? "" : "disabled"}>対戦開始</button>` : ""}
    ${isHost() && !canStart ? '<p class="hint">2人とも「準備OK」になると開始できます</p>' : ""}
    <button class="btn" data-lobby="exit">退出</button>`;
}

$("#lobby-body").addEventListener("change", (e) => {
  if (e.target.name !== "deck") return;
  O.deckId = e.target.value;
  store.set("sh_deck", O.deckId);
  net.updateMember(O.code, O.uid, { deck: O.deckId }).catch(netError);
  renderLobby();
});

$("#lobby-body").addEventListener("click", (e) => {
  const b = e.target.closest("[data-lobby]");
  if (!b) return;
  const k = b.dataset.lobby;
  if (k === "ready") {
    const me = O.members[O.uid] || {};
    net.updateMember(O.code, O.uid, { ready: !me.ready, deck: O.deckId }).catch(netError);
  } else if (k === "start") {
    const names = { p1: O.members[O.seats.p1].name, p2: O.members[O.seats.p2].name };
    const pub = R.newGame({ names, first: randomFirst(), gameId: newGameId() });
    net.startGame(O.code, pub).catch(netError);
  } else if (k === "exit") {
    onExit();
  }
});

// ================= 共通の操作 =================

function act(fn, { anyTime = false } = {}) {
  try {
    if (mode === "local") {
      fn(L.pub, L.priv[L.viewer], L.viewer);
      localAfterAction();
      return;
    }
    if (mode !== "online" || O.role === "watch" || !O.pub) return;
    const p = R.clone(O.pub);
    const m = O.mine ? R.clone(O.mine) : null;
    if (!anyTime && !m) return;
    fn(p, m, O.role);
    commit(p, m);
    refresh();
  } catch (e) {
    ui.error(e.message);
  }
}

function onMulligan(indices) {
  try {
    if (mode === "local") {
      const v = L.viewer;
      R.mulligan(L.pub, L.priv[v], v, indices);
      if (!R.bothMulliganDone(L.pub)) {
        localPassTo(R.other(v));
      } else {
        R.beginPlay(L.pub);
        R.startTurn(L.pub, L.priv[L.pub.active], L.pub.active);
        localPassTo(L.pub.active);
      }
      renderLocal();
      return;
    }
    const seat = O.role;
    const p = R.clone(O.pub);
    const m = R.clone(O.mine);
    R.mulligan(p, m, seat, indices);
    O.pub = p;
    O.mine = m;
    net.writeSetup(O.code, seat, p.players[seat], m).catch(netError);
    refresh();
  } catch (e) {
    ui.error(e.message);
  }
}

function onHandoff() {
  L.handoff = "";
  renderLocal();
}

function onRematch() {
  if (mode === "local") {
    localStart(L.names, L.decks);
    return;
  }
  if (!isHost() || !O.pub) return;
  const names = { p1: O.pub.players.p1.name, p2: O.pub.players.p2.name };
  const pub = R.newGame({ names, first: randomFirst(), gameId: newGameId() });
  net.startGame(O.code, pub).catch(netError);
}

function onExit() {
  if (mode === "online") leaveRoom();
  mode = null;
  showTitle();
}

// ================= タイトルと準備画面 =================

function showTitle() {
  $("#name").value = store.get("sh_name", "");
  const last = store.get("sh_lastRoom", "");
  $("#btn-rejoin").hidden = !last;
  $("#btn-rejoin").textContent = `前回の部屋（${last}）に戻る`;
  show("title");
}

function myName() {
  const n = $("#name").value.trim().slice(0, 12);
  if (!n) {
    alert("名前を入力してください");
    return "";
  }
  store.set("sh_name", n);
  return n;
}

async function withBusy(btn, fn) {
  btn.disabled = true;
  try {
    await fn();
  } catch (e) {
    netError(e);
  } finally {
    btn.disabled = false;
  }
}

$("#btn-create").addEventListener("click", (e) => {
  const name = myName();
  if (!name) return;
  withBusy(e.currentTarget, async () => {
    await loadNet();
    const res = await net.createRoom(name, store.get("sh_deck", "balance"));
    await enterRoom(res);
  });
});

async function join(code, btn) {
  const name = myName();
  if (!name) return;
  if (!/^\d{4}$/.test(code)) {
    alert("合言葉は4桁の数字です");
    return;
  }
  await withBusy(btn, async () => {
    await loadNet();
    const res = await net.joinRoom(code, name, store.get("sh_deck", "balance"));
    await enterRoom(res);
  });
}

$("#btn-join").addEventListener("click", (e) => join($("#code").value.trim(), e.currentTarget));
$("#btn-rejoin").addEventListener("click", (e) => join(store.get("sh_lastRoom", ""), e.currentTarget));

$("#btn-local").addEventListener("click", () => {
  const opts = DECKS.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join("");
  $("#local-deck1").innerHTML = opts;
  $("#local-deck2").innerHTML = opts;
  $("#local-name1").value = store.get("sh_name", "") || "プレイヤー1";
  $("#local-name2").value = "プレイヤー2";
  show("local");
});

$("#btn-local-start").addEventListener("click", () => {
  const names = {
    p1: $("#local-name1").value.trim().slice(0, 12) || "プレイヤー1",
    p2: $("#local-name2").value.trim().slice(0, 12) || "プレイヤー2",
  };
  localStart(names, { p1: $("#local-deck1").value, p2: $("#local-deck2").value });
});

$("#btn-local-back").addEventListener("click", showTitle);

// ================= 起動 =================

// ---- 音の設定（タイトル画面） ----

function renderSoundToggles() {
  const s = getSettings();
  $("#tg-bgm").textContent = `BGM：${s.bgm ? "ON" : "OFF"}`;
  $("#tg-se").textContent = `効果音：${s.se ? "ON" : "OFF"}`;
}
$("#tg-bgm").addEventListener("click", () => {
  setBgmOn(!getSettings().bgm);
  renderSoundToggles();
});
$("#tg-se").addEventListener("click", () => {
  setSeOn(!getSettings().se);
  renderSoundToggles();
});

// 対戦画面の外のボタンにもタップ音をつける
document.addEventListener("click", (e) => {
  if (e.target.closest(".screen .btn, .deck")) se("tap");
});

async function boot() {
  initAudio();
  renderSoundToggles();
  const [cards, decks] = await Promise.all([
    fetch("data/cards.json").then((r) => r.json()),
    fetch("data/decks.json").then((r) => r.json()),
  ]);
  R.loadCards(cards.cards);
  DECKS = decks;
  showTitle();
}

boot().catch((e) => {
  document.body.innerHTML = `<p style="padding:16px">読み込みに失敗しました：${esc(e.message)}</p>`;
});
