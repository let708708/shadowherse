// ゲームルール。画面や通信のことは知らない純粋な処理だけを置く。
// 関数は受け取った pub（公開情報）と mine（自分の手札・山札）を直接書き換える。
// 呼び出し側は必要なら clone() したものを渡すこと。

export const RULES = {
  leaderHp: 20,
  deckSize: 30,
  maxCopies: 3,
  startHand: 3,
  maxPp: 10,
  boardMax: 5,
  handMax: 9,
  logMax: 40,
};

const CARDS = new Map();

export function loadCards(list) {
  CARDS.clear();
  for (const c of list) CARDS.set(c.id, c);
}

export function getCard(id) {
  return CARDS.get(id);
}

export function allCards() {
  return [...CARDS.values()];
}

export const other = (seat) => (seat === "p1" ? "p2" : "p1");
export const clone = (o) => JSON.parse(JSON.stringify(o));

export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Firebase は空配列を保存しないので、読み込んだ後に形を整える
export function normPub(pub) {
  if (!pub) return null;
  pub.log = pub.log || [];
  pub.winner = pub.winner || "";
  for (const s of ["p1", "p2"]) {
    const p = pub.players[s];
    p.board = (p.board || []).map((u) => ({ ...u, keywords: u.keywords || [] }));
  }
  return pub;
}

export function normMine(mine) {
  if (!mine) return null;
  mine.hand = mine.hand || [];
  mine.deck = mine.deck || [];
  return mine;
}

// ---- デッキ ----

export function deckList(deckDef) {
  const ids = [];
  if (deckDef.id === "random") {
    const pool = allCards().filter((c) => !c.token);
    const count = {};
    while (ids.length < RULES.deckSize) {
      const c = pool[Math.floor(Math.random() * pool.length)];
      if ((count[c.id] || 0) >= 2) continue;
      count[c.id] = (count[c.id] || 0) + 1;
      ids.push(c.id);
    }
    return ids;
  }
  for (const [id, n] of Object.entries(deckDef.cards)) {
    for (let i = 0; i < n; i++) ids.push(id);
  }
  return ids;
}

// ---- 対戦の準備 ----

function newPlayer(name) {
  return {
    name,
    hp: RULES.leaderHp,
    maxPp: 0,
    pp: 0,
    board: [],
    handCount: 0,
    deckCount: 0,
    mulliganDone: false,
    ready: false,
  };
}

export function newGame({ names, first, gameId }) {
  return {
    gameId,
    phase: "mulligan",
    turn: 1,
    active: first,
    first,
    winner: "",
    turnStarted: false,
    uidSeq: 0,
    players: { p1: newPlayer(names.p1), p2: newPlayer(names.p2) },
    log: [`対戦開始！ 先攻は ${first === "p1" ? names.p1 : names.p2}`],
  };
}

function log(pub, text) {
  pub.log.push(text);
  if (pub.log.length > RULES.logMax) pub.log = pub.log.slice(-RULES.logMax);
}

function syncCounts(pub, mine, seat) {
  pub.players[seat].handCount = mine.hand.length;
  pub.players[seat].deckCount = mine.deck.length;
}

// 山札を配り、初期手札を引く。後攻は1枚多い。
export function deal(pub, seat, deckIds) {
  const mine = { gameId: pub.gameId, deck: shuffle([...deckIds]), hand: [] };
  const n = RULES.startHand + (seat === pub.first ? 0 : 1);
  for (let i = 0; i < n; i++) mine.hand.push(mine.deck.pop());
  pub.players[seat].ready = true;
  syncCounts(pub, mine, seat);
  return mine;
}

// 選んだ手札を山札に戻し、同じ枚数を引き直す（1回だけ）
export function mulligan(pub, mine, seat, indices) {
  const p = pub.players[seat];
  if (p.mulliganDone) throw new Error("引き直しは済んでいます");
  const picked = [...new Set(indices)].filter((i) => i >= 0 && i < mine.hand.length).sort((a, b) => b - a);
  const returned = picked.map((i) => mine.hand.splice(i, 1)[0]);
  for (let i = 0; i < returned.length; i++) mine.hand.push(mine.deck.pop());
  mine.deck.push(...returned);
  shuffle(mine.deck);
  p.mulliganDone = true;
  syncCounts(pub, mine, seat);
  if (returned.length) log(pub, `${p.name} は ${returned.length} 枚引き直した`);
}

export function bothMulliganDone(pub) {
  return pub.players.p1.mulliganDone && pub.players.p2.mulliganDone;
}

export function beginPlay(pub) {
  if (pub.phase === "mulligan" && bothMulliganDone(pub)) pub.phase = "play";
}

// ---- ターン ----

export function startTurn(pub, mine, seat) {
  if (pub.phase !== "play" || pub.active !== seat || pub.turnStarted) return;
  const p = pub.players[seat];
  p.maxPp = Math.min(RULES.maxPp, p.maxPp + 1);
  p.pp = p.maxPp;
  for (const u of p.board) u.canAttack = true;
  pub.turnStarted = true;
  log(pub, `― ${p.name} のターン（${pub.turn}）―`);
  if (pub.turn > 1) drawCards(pub, mine, seat, 1);
}

export function endTurn(pub, seat) {
  assertMyTurn(pub, seat);
  log(pub, `${pub.players[seat].name} はターンを終了した`);
  pub.active = other(seat);
  pub.turn += 1;
  pub.turnStarted = false;
}

export function surrender(pub, seat) {
  if (pub.winner) return;
  pub.winner = other(seat);
  pub.phase = "end";
  log(pub, `${pub.players[seat].name} は降参した`);
}

function drawCards(pub, mine, seat, n) {
  const p = pub.players[seat];
  for (let i = 0; i < n; i++) {
    if (pub.winner) return;
    if (mine.deck.length === 0) {
      log(pub, `${p.name} の山札が尽きた！`);
      pub.winner = other(seat);
      pub.phase = "end";
      return;
    }
    const id = mine.deck.pop();
    if (mine.hand.length >= RULES.handMax) {
      log(pub, `${p.name} の手札があふれ「${getCard(id).name}」を捨てた`);
    } else {
      mine.hand.push(id);
    }
  }
  syncCounts(pub, mine, seat);
}

function assertMyTurn(pub, seat) {
  if (pub.phase !== "play" || pub.winner) throw new Error("対戦中ではありません");
  if (pub.active !== seat) throw new Error("相手のターンです");
  if (!pub.turnStarted) throw new Error("ターン開始の処理中です");
}

export function isMyTurn(pub, seat) {
  return !!pub && pub.phase === "play" && !pub.winner && pub.active === seat && pub.turnStarted;
}

// ---- 対象 ----

function findUnit(pub, seat, uid) {
  return pub.players[seat].board.find((u) => u.uid === uid);
}

export function sameTarget(a, b) {
  return a && b && a.kind === b.kind && a.seat === b.seat && (a.kind === "leader" || a.uid === b.uid);
}

export function chooseTargets(pub, seat, kind) {
  const opp = other(seat);
  const enemyUnits = pub.players[opp].board.map((u) => ({ kind: "unit", seat: opp, uid: u.uid }));
  switch (kind) {
    case "enemyFollower":
      return enemyUnits;
    case "enemy":
      return [...enemyUnits, { kind: "leader", seat: opp }];
    case "allyFollower":
      return pub.players[seat].board.map((u) => ({ kind: "unit", seat, uid: u.uid }));
    default:
      return [];
  }
}

// 手札のカードが出せるか。出せない理由と、選ぶ対象の候補も返す。
export function playable(pub, mine, seat, idx) {
  if (!isMyTurn(pub, seat)) return { ok: false, reason: "自分のターンではありません" };
  const id = mine.hand[idx];
  const c = getCard(id);
  if (!c) return { ok: false, reason: "カードが見つかりません" };
  const p = pub.players[seat];
  if (c.cost > p.pp) return { ok: false, reason: "コストが足りません" };
  if (c.type === "follower" && p.board.length >= RULES.boardMax) return { ok: false, reason: "場がいっぱいです" };
  const targets = c.choose ? chooseTargets(pub, seat, c.choose) : [];
  if (c.type === "spell" && c.choose && targets.length === 0) return { ok: false, reason: "対象がいません" };
  return { ok: true, choose: c.choose || "", targets };
}

export function playCard(pub, mine, seat, idx, target) {
  const chk = playable(pub, mine, seat, idx);
  if (!chk.ok) throw new Error(chk.reason);
  if (chk.targets.length > 0 && !chk.targets.some((t) => sameTarget(t, target))) {
    throw new Error("対象を選んでください");
  }
  const p = pub.players[seat];
  const id = mine.hand.splice(idx, 1)[0];
  const c = getCard(id);
  p.pp -= c.cost;
  let selfUid = "";
  if (c.type === "follower") {
    const u = makeUnit(pub, c);
    u.canAttack = u.keywords.includes("rush");
    p.board.push(u);
    selfUid = u.uid;
    log(pub, `${p.name} は「${c.name}」を出した`);
  } else {
    log(pub, `${p.name} は「${c.name}」を使った`);
  }
  const ctx = { pub, mine, seat, selfUid, target: chk.targets.length ? target : null };
  for (const eff of c.effects || []) {
    if (eff.on === "play") applyEffect(ctx, eff);
  }
  resolveDeaths(pub);
  syncCounts(pub, mine, seat);
}

function makeUnit(pub, c) {
  pub.uidSeq += 1;
  return {
    uid: "u" + pub.uidSeq,
    id: c.id,
    atk: c.atk,
    hp: c.hp,
    maxHp: c.hp,
    keywords: [...(c.keywords || [])],
    canAttack: false,
  };
}

// ---- 攻撃 ----

export function attackTargets(pub, seat, uid) {
  if (!isMyTurn(pub, seat)) return [];
  const u = findUnit(pub, seat, uid);
  if (!u || !u.canAttack || u.atk <= 0) return [];
  const opp = other(seat);
  const board = pub.players[opp].board;
  const guards = board.filter((x) => x.keywords.includes("guard"));
  if (guards.length) return guards.map((x) => ({ kind: "unit", seat: opp, uid: x.uid }));
  return [...board.map((x) => ({ kind: "unit", seat: opp, uid: x.uid })), { kind: "leader", seat: opp }];
}

export function attack(pub, seat, uid, target) {
  const targets = attackTargets(pub, seat, uid);
  if (!targets.some((t) => sameTarget(t, target))) throw new Error("そこには攻撃できません");
  const a = findUnit(pub, seat, uid);
  const an = getCard(a.id).name;
  a.canAttack = false;
  if (target.kind === "leader") {
    const lp = pub.players[target.seat];
    lp.hp -= a.atk;
    log(pub, `「${an}」が ${lp.name} に ${a.atk} ダメージ`);
  } else {
    const d = findUnit(pub, target.seat, target.uid);
    d.hp -= a.atk;
    a.hp -= d.atk;
    log(pub, `「${an}」が「${getCard(d.id).name}」を攻撃`);
  }
  resolveDeaths(pub);
}

// ---- 効果 ----

function resolveTo(ctx, to) {
  const { pub, seat } = ctx;
  const opp = other(seat);
  const units = (s) => pub.players[s].board.map((u) => ({ kind: "unit", seat: s, uid: u.uid }));
  switch (to) {
    case "chosen":
      return ctx.target ? [ctx.target] : [];
    case "enemyLeader":
      return [{ kind: "leader", seat: opp }];
    case "myLeader":
      return [{ kind: "leader", seat }];
    case "allEnemyFollowers":
      return units(opp);
    case "allFollowers":
      return [...units(seat), ...units(opp)];
    case "allAllies":
      return units(seat);
    case "otherAllies":
      return units(seat).filter((t) => t.uid !== ctx.selfUid);
    case "self":
      return ctx.selfUid ? [{ kind: "unit", seat, uid: ctx.selfUid }] : [];
    default:
      return [];
  }
}

function applyEffect(ctx, eff) {
  const { pub, seat } = ctx;
  switch (eff.do) {
    case "damage":
      for (const t of resolveTo(ctx, eff.to)) {
        if (t.kind === "leader") {
          pub.players[t.seat].hp -= eff.value;
        } else {
          const u = findUnit(pub, t.seat, t.uid);
          if (u) u.hp -= eff.value;
        }
      }
      break;
    case "heal":
      for (const t of resolveTo(ctx, eff.to)) {
        if (t.kind === "leader") {
          const p = pub.players[t.seat];
          p.hp = Math.min(RULES.leaderHp, p.hp + eff.value);
        } else {
          const u = findUnit(pub, t.seat, t.uid);
          if (u) u.hp = Math.min(u.maxHp, u.hp + eff.value);
        }
      }
      break;
    case "draw":
      // 自分の手札を触れるのは自分の端末だけ。退場時の効果ではドローしない。
      if (ctx.mine) drawCards(pub, ctx.mine, seat, eff.value);
      break;
    case "buff":
      for (const t of resolveTo(ctx, eff.to)) {
        if (t.kind !== "unit") continue;
        const u = findUnit(pub, t.seat, t.uid);
        if (!u) continue;
        u.atk += eff.atk || 0;
        u.hp += eff.hp || 0;
        u.maxHp += eff.hp || 0;
      }
      break;
    case "summon": {
      const c = getCard(eff.card);
      const board = pub.players[seat].board;
      for (let i = 0; i < (eff.count || 1); i++) {
        if (board.length >= RULES.boardMax) break;
        board.push(makeUnit(pub, c));
      }
      break;
    }
  }
}

// 体力0以下のフォロワーを取り除き、退場時の効果を処理する。最後に勝敗を判定する。
function resolveDeaths(pub) {
  for (let loop = 0; loop < 20; loop++) {
    const dead = [];
    for (const s of [pub.active, other(pub.active)]) {
      const p = pub.players[s];
      const keep = [];
      for (const u of p.board) (u.hp <= 0 ? dead : keep).push(u.hp <= 0 ? { u, seat: s } : u);
      p.board = keep;
    }
    if (!dead.length) break;
    for (const { u, seat } of dead) {
      const c = getCard(u.id);
      log(pub, `「${c.name}」は倒れた`);
      const ctx = { pub, mine: null, seat, selfUid: "", target: null };
      for (const eff of c.effects || []) {
        if (eff.on === "death") applyEffect(ctx, eff);
      }
    }
  }
  checkWinner(pub);
}

function checkWinner(pub) {
  if (pub.winner) return;
  const d1 = pub.players.p1.hp <= 0;
  const d2 = pub.players.p2.hp <= 0;
  if (!d1 && !d2) return;
  pub.winner = d1 && d2 ? "draw" : d1 ? "p2" : "p1";
  pub.phase = "end";
  log(pub, pub.winner === "draw" ? "引き分け！" : `${pub.players[pub.winner].name} の勝ち！`);
}
