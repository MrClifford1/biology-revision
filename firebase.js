// Firebase configuration for Streetly Science Hub
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc, updateDoc, arrayUnion, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBNVM9Dx8vAYOtt79BVwKK1u3St5BsIxsY",
  authDomain: "streetly-science-hub.firebaseapp.com",
  projectId: "streetly-science-hub",
  storageBucket: "streetly-science-hub.firebasestorage.app",
  messagingSenderId: "728114314219",
  appId: "1:728114314219:web:49d2c428abfd75940b77ae"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();

// ── AUTH FUNCTIONS ────────────────────────────────────────────────────────────
export async function signInWithGoogle() {
  try {
    const result = await signInWithPopup(auth, provider);
    await ensureUserProfile(result.user);
    return result.user;
  } catch (err) {
    console.error('Sign in error:', err);
    throw err;
  }
}

export async function signOutUser() {
  await signOut(auth);
}

export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}

// ── USER PROFILE ──────────────────────────────────────────────────────────────
async function ensureUserProfile(user) {
  const ref = doc(db, 'users', user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      name: user.displayName,
      email: user.email,
      photoURL: user.photoURL,
      createdAt: serverTimestamp(),
      examTarget: null,
      yearGroup: null,
    });
  }
}

export async function getUserProfile(uid) {
  const snap = await getDoc(doc(db, 'users', uid));
  return snap.exists() ? snap.data() : null;
}

export async function updateExamTarget(uid, examTarget, yearGroup) {
  await updateDoc(doc(db, 'users', uid), { examTarget, yearGroup });
}

// ── RAG STATE ─────────────────────────────────────────────────────────────────
export async function saveRAG(uid, moduleId, ragState) {
  await setDoc(
    doc(db, 'users', uid, 'progress', moduleId),
    { rag: ragState, ragUpdated: serverTimestamp() },
    { merge: true }
  );
}

export async function loadRAG(uid, moduleId) {
  const snap = await getDoc(doc(db, 'users', uid, 'progress', moduleId));
  return snap.exists() ? (snap.data().rag || {}) : {};
}

// ── MOCK SCORES ───────────────────────────────────────────────────────────────
export async function saveMockScore(uid, moduleId, score, total, questions) {
  const entry = {
    date: new Date().toISOString(),
    score,
    total,
    pct: Math.round((score / total) * 100),
    questions: questions.map(q => ({
      id: q.id,
      topic: q.topic,
      marks: q.marks,
      awarded: q.awarded,
    })),
  };

  await setDoc(
    doc(db, 'users', uid, 'progress', moduleId),
    { mocks: arrayUnion(entry), lastAttempt: serverTimestamp() },
    { merge: true }
  );
}

export async function getModuleProgress(uid, moduleId) {
  const snap = await getDoc(doc(db, 'users', uid, 'progress', moduleId));
  return snap.exists() ? snap.data() : null;
}

export async function getAllProgress(uid) {
  const modules = [
    'b1','b2','b3','b4','b5','b6','b7',
    'p1','p2','p3','p4','p5','p6','p7',
    'c1','c2','c3','c4','c5','c6','c7','c8','c9','c10',
  ];
  const progress = {};
  for (const m of modules) {
    const snap = await getDoc(doc(db, 'users', uid, 'progress', m));
    if (snap.exists()) progress[m] = snap.data();
  }
  return progress;
}

export { auth, db };
