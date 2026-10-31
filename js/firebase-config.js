// Firebase の接続設定。
// apiKey などはブラウザに公開される前提の値なので、リポジトリに含めて問題ない。
// データの保護は database.rules.json（Firebase コンソールの「ルール」に貼る）で行う。
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyAmE9bUZNi5-Z6RhtX8QYdb8ZQSkhjkoeI",
  authDomain: "shadowherse.firebaseapp.com",
  databaseURL: "https://shadowherse-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "shadowherse",
  storageBucket: "shadowherse.firebasestorage.app",
  messagingSenderId: "792580364783",
  appId: "1:792580364783:web:d5bb3e565f1b2622aa7e1a",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);
