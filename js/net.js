// Firebase Realtime Database との読み書き。
// データの形は rooms/{合言葉}/{meta, members, seats, public, private/{p1,p2}}
import { auth, db } from "./firebase-config.js";
import { signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  ref,
  get,
  set,
  update,
  remove,
  onValue,
  runTransaction,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

const DAY = 24 * 60 * 60 * 1000;
const roomRef = (code, path = "") => ref(db, `rooms/${code}${path ? "/" + path : ""}`);

let uidPromise = null;

export function signIn() {
  if (uidPromise) return uidPromise;
  uidPromise = new Promise((resolve, reject) => {
    const stop = onAuthStateChanged(auth, async (user) => {
      if (user) {
        stop();
        resolve(user.uid);
        return;
      }
      try {
        await signInAnonymously(auth);
      } catch (e) {
        stop();
        uidPromise = null;
        reject(e);
      }
    });
  });
  return uidPromise;
}

export async function createRoom(name, deck) {
  const uid = await signIn();
  for (let i = 0; i < 20; i++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    const meta = (await get(roomRef(code, "meta"))).val();
    if (meta) {
      if (typeof meta.createdAt === "number" && meta.createdAt < Date.now() - DAY) {
        await remove(roomRef(code)); // 古い部屋は片付けて再利用
      } else {
        continue;
      }
    }
    await set(roomRef(code, "meta"), { host: uid, createdAt: serverTimestamp(), status: "waiting" });
    await set(roomRef(code, "seats/p1"), uid);
    await set(roomRef(code, `members/${uid}`), { name, role: "p1", ready: false, deck });
    return { code, role: "p1" };
  }
  throw new Error("部屋を作れませんでした。もう一度試してください");
}

export async function joinRoom(code, name, deck) {
  const uid = await signIn();
  const meta = (await get(roomRef(code, "meta"))).val();
  if (!meta) throw new Error("その合言葉の部屋は見つかりません");
  const seats = (await get(roomRef(code, "seats"))).val() || {};
  let role = "watch";
  if (seats.p1 === uid) role = "p1";
  else if (seats.p2 === uid) role = "p2";
  else if (!seats.p2) {
    const res = await runTransaction(roomRef(code, "seats/p2"), (cur) => (cur ? undefined : uid));
    if (res.committed && res.snapshot.val() === uid) role = "p2";
  }
  const prev = (await get(roomRef(code, `members/${uid}`))).val();
  await set(roomRef(code, `members/${uid}`), {
    name,
    role,
    ready: prev && prev.role === role ? !!prev.ready : false,
    deck,
  });
  return { code, role, host: meta.host === uid };
}

export function updateMember(code, uid, patch) {
  return update(roomRef(code, `members/${uid}`), patch);
}

// 部屋の公開情報を購読する。戻り値の関数で購読をやめる。
export function watchRoom(code, handlers) {
  const unsubs = [];
  const sub = (path, cb) => {
    unsubs.push(
      onValue(
        roomRef(code, path),
        (snap) => cb(snap.val()),
        (err) => handlers.onError && handlers.onError(err)
      )
    );
  };
  sub("meta", (v) => handlers.onMeta(v));
  sub("members", (v) => handlers.onMembers(v || {}));
  sub("seats", (v) => handlers.onSeats(v || {}));
  sub("public", (v) => handlers.onPublic(v));
  return () => unsubs.forEach((f) => f());
}

// 手札・山札を購読する（本人と観戦者だけが読める）
export function watchPrivate(code, seat, cb, onError) {
  return onValue(
    roomRef(code, `private/${seat}`),
    (snap) => cb(snap.val()),
    (err) => onError && onError(err)
  );
}

// 対戦開始・再戦（ホストのみ）
export function startGame(code, pub) {
  return update(roomRef(code), { public: pub, "meta/status": "playing" });
}

// 配札と引き直し：自分のプレイヤー情報と手札だけを書く（相手と同時に書いてもぶつからない）
export function writeSetup(code, seat, player, mine) {
  return update(roomRef(code), { [`public/players/${seat}`]: player, [`private/${seat}`]: mine });
}

// 自分の手番の結果を書く
export function writeTurn(code, seat, pub, mine) {
  const patch = { public: pub };
  if (mine) patch[`private/${seat}`] = mine;
  return update(roomRef(code), patch);
}

export function writePublic(code, pub) {
  return set(roomRef(code, "public"), pub);
}
