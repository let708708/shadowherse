// 対戦画面の描画とタップ操作。ルール判定は rules.js、通信は main.js 側が受け持つ。
import * as R from "./rules.js";

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

const KW = { guard: "🛡", rush: "⚡" };

export function cardHtml(id, { unit = null, cls = "", attrs = "" } = {}) {
  const c = R.getCard(id);
  if (!c) return "";
  const stats =
    c.type === "follower"
      ? `<span class="atk">${unit ? unit.atk : c.atk}</span><span class="hp ${unit && unit.hp < unit.maxHp ? "hurt" : ""}">${unit ? unit.hp : c.hp}</span>`
      : `<span class="spell-tag">スペル</span>`;
  const kws = (unit ? unit.keywords : c.keywords || []).map((k) => KW[k] || "").join("");
  return `<div class="card ${c.type} ${cls}" ${attrs}>
    <img src="${c.img}" alt="${esc(c.name)}" draggable="false">
    ${unit ? "" : `<span class="cost">${c.cost}</span>`}
    ${stats}
    ${kws ? `<span class="kw">${kws}</span>` : ""}
    <span class="name">${esc(c.name)}</span>
  </div>`;
}

export function createGameUI(root, h) {
  let view = null;
  let sel = null; // {type:'unit', uid} | {type:'target', idx, targets}
  let modal = null; // {kind:'card', id, unit, handIdx} | {kind:'log'} | {kind:'menu'}
  let mull = new Set();
  let mullKey = "";
  let lastLog = "";
  let toastTimer = 0;

  const toastEl = document.createElement("div");
  toastEl.className = "toast";
  document.body.appendChild(toastEl);

  root.addEventListener("click", onClick);

  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
  }

  function render(v) {
    view = v;
    const pub = v.pub;
    // 状況が変わって無効になった選択を外す
    if (!v.canAct) sel = null;
    if (sel && sel.type === "unit" && !pub.players[v.bottom].board.some((u) => u.uid === sel.uid)) sel = null;
    const key = `${pub.gameId}:${v.bottom}`;
    if (key !== mullKey) {
      mullKey = key;
      mull = new Set();
    }
    const last = pub.log[pub.log.length - 1] || "";
    if (last && last !== lastLog) {
      if (lastLog) toast(last);
      lastLog = last;
    }
    draw();
  }

  function targetsNow() {
    if (!view || !sel) return [];
    if (sel.type === "target") return sel.targets;
    if (sel.type === "unit") return R.attackTargets(view.pub, view.bottom, sel.uid);
    return [];
  }

  const isTarget = (list, t) => list.some((x) => R.sameTarget(x, t));

  function bar(seat, pos) {
    const p = view.pub.players[seat];
    const t = targetsNow();
    const tgt = isTarget(t, { kind: "leader", seat });
    const active = view.pub.phase === "play" && view.pub.active === seat;
    const pips = Array.from({ length: Math.max(p.maxPp, 1) }, (_, i) => `<i class="${i < p.pp ? "on" : ""}"></i>`).join("");
    return `<div class="bar ${pos} ${active ? "active" : ""} ${tgt ? "targetable" : ""}" data-leader="${seat}">
      <div class="who"><span class="pname">${esc(p.name)}</span>${active ? '<span class="turn-tag">手番</span>' : ""}</div>
      <div class="hp-big ${p.hp <= 5 ? "low" : ""}">♥${p.hp}</div>
      <div class="pp"><span>${p.pp}/${p.maxPp}</span><span class="pips">${pips}</span></div>
      <div class="counts">手札${p.handCount}<br>山札${p.deckCount}</div>
    </div>`;
  }

  function board(seat, pos) {
    const t = targetsNow();
    const units = view.pub.players[seat].board;
    const slots = [];
    for (let i = 0; i < R.RULES.boardMax; i++) {
      const u = units[i];
      if (!u) {
        slots.push('<div class="slot"></div>');
        continue;
      }
      const cls = [
        "unit",
        isTarget(t, { kind: "unit", seat, uid: u.uid }) ? "targetable" : "",
        sel && sel.type === "unit" && sel.uid === u.uid ? "selected" : "",
        view.canAct && seat === view.bottom && u.canAttack && u.atk > 0 ? "ready" : "",
      ].join(" ");
      slots.push(`<div class="slot">${cardHtml(u.id, { unit: u, cls, attrs: `data-unit="${u.uid}" data-seat="${seat}"` })}</div>`);
    }
    return `<div class="board ${pos}">${slots.join("")}</div>`;
  }

  function handRow(seat, pos) {
    const hand = view.hands[seat];
    if (!hand) return "";
    const mine = { hand, deck: [] };
    const cards = hand
      .map((id, i) => {
        const ok = pos === "me" && view.canAct && R.playable(view.pub, mine, seat, i).ok;
        const chosen = sel && sel.type === "target" && sel.idx === i && pos === "me";
        return cardHtml(id, {
          cls: `${ok ? "playable" : ""} ${chosen ? "selected" : ""}`,
          attrs: `data-hand="${i}" data-seat="${seat}"`,
        });
      })
      .join("");
    return `<div class="hand ${pos}">${cards || '<span class="empty">手札なし</span>'}</div>`;
  }

  function overlays() {
    const v = view;
    const pub = v.pub;
    if (v.handoff) {
      return `<div class="overlay" data-act="handoff"><div class="panel">
        <p class="big">${esc(v.handoff)} さんの番です</p>
        <p>端末を渡したら、画面をタップしてください</p></div></div>`;
    }
    if (pub.winner) {
      let title;
      if (pub.winner === "draw") title = "引き分け";
      else if (v.isSpectator || v.mode === "local") title = `${esc(pub.players[pub.winner].name)} の勝ち！`;
      else title = pub.winner === v.bottom ? "勝ち！" : "負け…";
      return `<div class="overlay"><div class="panel">
        <p class="result">${title}</p>
        ${v.canRematch ? '<button class="btn primary" data-act="rematch">もう一度</button>' : ""}
        ${!v.canRematch && v.mode === "online" ? "<p>ホストが再戦を始めるのを待っています</p>" : ""}
        <button class="btn" data-act="exit">タイトルへ</button></div></div>`;
    }
    if (v.mulligan) {
      const cards = v.mulligan
        .map((id, i) => cardHtml(id, { cls: mull.has(i) ? "swap" : "", attrs: `data-mull="${i}"` }))
        .join("");
      return `<div class="overlay"><div class="panel">
        <p class="big">引き直し</p>
        <p>交換したいカードをタップ（1回だけ）</p>
        <div class="mull">${cards}</div>
        <button class="btn primary" data-act="mull-ok">${mull.size ? `${mull.size}枚 交換する` : "このまま始める"}</button>
      </div></div>`;
    }
    if (modal && modal.kind === "card") return cardModal();
    if (modal && modal.kind === "log") {
      const lines = [...pub.log].reverse().map((l) => `<li>${esc(l)}</li>`).join("");
      return `<div class="overlay" data-act="close"><div class="panel log"><p class="big">ログ</p><ul>${lines}</ul>
        <button class="btn" data-act="close">閉じる</button></div></div>`;
    }
    if (modal && modal.kind === "menu") {
      return `<div class="overlay" data-act="close"><div class="panel">
        ${v.canSurrender ? '<button class="btn danger" data-act="surrender">降参する</button>' : ""}
        <button class="btn" data-act="exit">タイトルへ戻る</button>
        <button class="btn" data-act="close">閉じる</button></div></div>`;
    }
    return "";
  }

  function cardModal() {
    const { id, unit, handIdx } = modal;
    const c = R.getCard(id);
    let action = "";
    if (handIdx !== undefined && handIdx !== null && view.canAct) {
      const chk = R.playable(view.pub, { hand: view.hands[view.bottom], deck: [] }, view.bottom, handIdx);
      action = chk.ok
        ? `<button class="btn primary" data-act="play">出す（コスト${c.cost}）</button>`
        : `<p class="reason">${esc(chk.reason)}</p>`;
    }
    const stats =
      c.type === "follower"
        ? `攻撃 ${unit ? unit.atk : c.atk} ／ 体力 ${unit ? `${unit.hp}/${unit.maxHp}` : c.hp}`
        : "スペル";
    return `<div class="overlay" data-act="close"><div class="panel detail">
      <img src="${c.img}" alt="">
      <p class="big">${esc(c.name)}</p>
      <p>コスト ${c.cost} ／ ${stats}</p>
      <p class="ctext">${esc(c.text || "（能力なし）")}</p>
      ${action}
      <button class="btn" data-act="close">閉じる</button>
    </div></div>`;
  }

  function draw() {
    const v = view;
    const pub = v.pub;
    let banner = "";
    if (sel && sel.type === "target") {
      banner = `<div class="prompt">対象を選んでください <button class="btn small" data-act="cancel">やめる</button></div>`;
    } else if (sel && sel.type === "unit") {
      banner = `<div class="prompt">攻撃先を選んでください <button class="btn small" data-act="cancel">やめる</button></div>`;
    } else if (v.waiting) {
      banner = `<div class="prompt quiet">${esc(v.waiting)}</div>`;
    } else if (pub.phase === "play" && !v.canAct) {
      banner = `<div class="prompt quiet">${esc(pub.players[pub.active].name)} のターン</div>`;
    }
    root.innerHTML = `<div class="game">
      ${bar(v.top, "opp")}
      ${v.showTopHand ? handRow(v.top, "opp") : ""}
      ${board(v.top, "opp")}
      <div class="mid">${banner}</div>
      ${board(v.bottom, "me")}
      ${bar(v.bottom, "me")}
      ${handRow(v.bottom, "me")}
      <div class="controls">
        <button class="btn" data-act="log">ログ</button>
        <button class="btn" data-act="menu">メニュー</button>
        <button class="btn primary end" data-act="end" ${v.canAct ? "" : "disabled"}>ターン終了</button>
      </div>
      ${overlays()}
    </div>`;
  }

  function onClick(e) {
    if (!view) return;
    const el = e.target.closest("[data-act],[data-hand],[data-unit],[data-leader],[data-mull]");
    if (!el) return;
    const v = view;
    const act = el.dataset.act;

    if (act) {
      // パネルの内側をタップしても閉じないようにする
      if (act === "close" && el.classList.contains("overlay") && e.target !== el) return;
      e.stopPropagation();
      switch (act) {
        case "close":
          modal = null;
          break;
        case "cancel":
          sel = null;
          break;
        case "log":
          modal = { kind: "log" };
          break;
        case "menu":
          modal = { kind: "menu" };
          break;
        case "end":
          sel = null;
          h.onEndTurn();
          return;
        case "play":
          return startPlay(modal.handIdx);
        case "mull-ok": {
          const picked = [...mull];
          mull = new Set();
          h.onMulligan(picked);
          return;
        }
        case "handoff":
          h.onHandoff();
          return;
        case "surrender":
          modal = null;
          if (confirm("本当に降参しますか？")) h.onSurrender();
          return;
        case "rematch":
          h.onRematch();
          return;
        case "exit":
          modal = null;
          h.onExit();
          return;
      }
      draw();
      return;
    }

    if (el.dataset.mull !== undefined) {
      const i = Number(el.dataset.mull);
      mull.has(i) ? mull.delete(i) : mull.add(i);
      draw();
      return;
    }

    const targets = targetsNow();
    let target = null;
    if (el.dataset.unit) target = { kind: "unit", seat: el.dataset.seat, uid: el.dataset.unit };
    else if (el.dataset.leader) target = { kind: "leader", seat: el.dataset.leader };

    if (target && sel && isTarget(targets, target)) {
      const s = sel;
      sel = null;
      if (s.type === "target") h.onPlay(s.idx, target);
      else h.onAttack(s.uid, target);
      return;
    }

    if (el.dataset.hand !== undefined) {
      sel = null;
      const seat = el.dataset.seat;
      const idx = Number(el.dataset.hand);
      modal = { kind: "card", id: v.hands[seat][idx], handIdx: seat === v.bottom ? idx : null };
      draw();
      return;
    }

    if (el.dataset.unit) {
      const seat = el.dataset.seat;
      const u = v.pub.players[seat].board.find((x) => x.uid === el.dataset.unit);
      if (!u) return;
      if (seat === v.bottom && v.canAct && u.canAttack && u.atk > 0 && !(sel && sel.uid === u.uid)) {
        if (R.attackTargets(v.pub, seat, u.uid).length) {
          sel = { type: "unit", uid: u.uid };
          draw();
          return;
        }
      }
      sel = null;
      modal = { kind: "card", id: u.id, unit: u, handIdx: null };
      draw();
      return;
    }

    if (el.dataset.leader && sel) {
      sel = null;
      draw();
    }
  }

  function startPlay(idx) {
    modal = null;
    const chk = R.playable(view.pub, { hand: view.hands[view.bottom], deck: [] }, view.bottom, idx);
    if (!chk.ok) {
      toast(chk.reason);
      draw();
      return;
    }
    if (chk.targets.length) {
      sel = { type: "target", idx, targets: chk.targets };
      draw();
      return;
    }
    h.onPlay(idx, null);
  }

  return { render, toast };
}
