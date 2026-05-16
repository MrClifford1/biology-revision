// Firebase configuration for Streetly Science Hub
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc, updateDoc, arrayUnion, serverTimestamp, collection, getDocs, deleteDoc, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

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
      class: null,
      classSetYear: null,
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

// ── RAG SYSTEM v2 ─────────────────────────────────────────────────────────────
//
// Each topic entry: { score: 0–100, lastActivity: ISO string, retained: bool, retainedSince: ISO|null }
// Tier is computed from score at read time — never stored.
// Input weights are registered here — add new activity types without touching other code.

export const RAG_INPUT_WEIGHTS = {
  mock:      1.0,   // Mini Mock question
  paper:     1.0,   // Practice Paper question
  words:     0.4,   // Keywords game correct match
  flashcard: 0.15,  // Flashcard recognition/recall
  // Future — just add a line:
  // cloze:   0.6,
  // diagram: 0.6,
};

// Activity score caps — limits how high each activity type can push a topic score
export const RAG_SCORE_CAPS = {
  mock:      100,
  paper:     100,
  words:     60,    // Words game caps at Approaching tier
  flashcard: 20,    // Flashcards cap at Beginning tier
};

// Decay rates: % score lost per day of inactivity (after 7-day grace period)
const DECAY_RATES = {
  mastered:    0.3,
  confident:   0.5,
  approaching: 0.8,
  developing:  1.0,
  beginning:   1.2,
  not_started: 0.0,
};

// Days at Mastered tier before ⭐ Retained indicator is shown
const RETAINED_DAYS = 28;

export function computeTier(score) {
  if (score === 0)    return 'not_started';
  if (score <= 33)   return 'beginning';
  if (score <= 55)   return 'developing';
  if (score <= 75)   return 'approaching';
  if (score <= 89)   return 'confident';
  return 'mastered';
}

export const TIER_META = {
  not_started: { label: 'Not Started', emoji: '⬜', colour: '#cbd5e1', bg: '#f8fafc' },
  beginning:   { label: 'Beginning',   emoji: '🔴', colour: '#ef4444', bg: '#fef2f2' },
  developing:  { label: 'Developing',  emoji: '🟠', colour: '#f97316', bg: '#fff7ed' },
  approaching: { label: 'Approaching', emoji: '🟡', colour: '#eab308', bg: '#fefce8' },
  confident:   { label: 'Confident',   emoji: '🟢', colour: '#22c55e', bg: '#f0fdf4' },
  mastered:    { label: 'Mastered',    emoji: '💙', colour: '#3b82f6', bg: '#eff6ff' },
};

// Apply time-based decay to a topic entry. Returns updated entry (does not save).
export function applyDecay(entry) {
  if (!entry || !entry.lastActivity) return entry;
  const score = entry.score || 0;
  if (score === 0) return entry; // nothing to decay

  const daysInactive = (Date.now() - new Date(entry.lastActivity).getTime()) / 86400000;
  const graceDays = 7;
  if (daysInactive <= graceDays) return entry;

  const tier = computeTier(score);
  const rate = DECAY_RATES[tier] || 0;
  const decayableDays = daysInactive - graceDays;
  const newScore = Math.max(0, score - decayableDays * rate);

  // Update retained status
  let { retained, retainedSince } = entry;
  if (newScore < 90) {
    retained = false;
    retainedSince = null;
  }

  return { ...entry, score: Math.round(newScore * 10) / 10, retained, retainedSince };
}

// Evidence cap: maximum score achievable based on number of attempts on this topic.
// Prevents a single perfect answer instantly reaching Mastered.
// attempts 1 → max 40%, 2 → max 60%, 3 → max 75%, 4 → max 87%, 5+ → max 100%
function evidenceCap(attempts) {
  if (attempts <= 1) return 40;
  if (attempts === 2) return 60;
  if (attempts === 3) return 75;
  if (attempts === 4) return 87;
  return 100;
}

// Update a topic score after an activity. inputType must be a key in RAG_INPUT_WEIGHTS.
// activityPct: 0–100 percentage score for this activity on this topic.
export function computeNewTopicScore(currentEntry, activityPct, inputType) {
  const weight = RAG_INPUT_WEIGHTS[inputType] ?? 0.3;
  const oldScore = currentEntry?.score ?? 0;
  const attempts = (currentEntry?.attempts ?? 0) + 1;
  const now = new Date().toISOString();

  // Weighted nudge: moves score toward activityPct, scaled by weight
  const nudged = oldScore + (activityPct - oldScore) * weight;

  // Apply both evidence cap (attempts-based) and activity type cap
  const activityCap = RAG_SCORE_CAPS[inputType] ?? 100;
  const cap = Math.min(evidenceCap(attempts), activityCap);
  const newScore = Math.min(cap, Math.max(0, Math.round(nudged * 10) / 10));

  // Retained logic: track when Mastered tier is first reached
  let retainedSince = currentEntry?.retainedSince ?? null;
  let retained = currentEntry?.retained ?? false;

  if (newScore >= 90) {
    if (!retainedSince) retainedSince = now;
    const daysMastered = (Date.now() - new Date(retainedSince).getTime()) / 86400000;
    if (daysMastered >= RETAINED_DAYS) retained = true;
  } else {
    retainedSince = null;
    retained = false;
  }

  return { score: newScore, lastActivity: now, retained, retainedSince, attempts };
}

// Save full RAG state for a module (topic name → entry object)
export async function saveRAG(uid, moduleId, ragState) {
  await setDoc(
    doc(db, 'users', uid, 'progress', moduleId),
    { rag: ragState, ragUpdated: serverTimestamp() },
    { merge: true }
  );
}

// Load RAG state, applying decay to all entries before returning
export async function loadRAG(uid, moduleId) {
  const snap = await getDoc(doc(db, 'users', uid, 'progress', moduleId));
  if (!snap.exists()) return {};
  const raw = snap.data().rag || {};
  // Apply decay to each entry
  const decayed = {};
  for (const [topic, entry] of Object.entries(raw)) {
    // Support old string format gracefully — treat as score 0
    if (typeof entry === 'string' || typeof entry === 'number') {
      decayed[topic] = { score: 0, lastActivity: null, retained: false, retainedSince: null };
    } else {
      decayed[topic] = applyDecay(entry);
    }
  }
  return decayed;
}

// Convenience: update one topic's score after an activity, then persist
export async function updateTopicScore(uid, moduleId, topicName, activityPct, inputType) {
  const current = await loadRAG(uid, moduleId);
  const updated = { ...current };
  updated[topicName] = computeNewTopicScore(current[topicName] || null, activityPct, inputType);
  await saveRAG(uid, moduleId, updated);
  return updated;
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

// ── CLASS SELECTION ───────────────────────────────────────────────────────────
export async function saveClass(uid, className) {
  const academicYear = getCurrentAcademicYear();
  await setDoc(doc(db, 'users', uid), {
    class: className,
    classSetYear: academicYear,
  }, { merge: true });
}

// Academic year starts in September — returns e.g. 2025 for Sep 2025 – Aug 2026
function getCurrentAcademicYear() {
  const now = new Date();
  return now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
}

export function isClassValid(profile) {
  if (!profile?.class || profile.classSetYear == null) return false;
  return profile.classSetYear >= getCurrentAcademicYear();
}

// ── ROLES ─────────────────────────────────────────────────────────────────────
export async function getUserRole(email) {
  if (email === 'n.clifford@thestreetlyacademy.co.uk') return 'superadmin';
  const snap = await getDoc(doc(db, 'roles', email));
  if (!snap.exists()) return 'student';
  return snap.data().role || 'student';
}

export async function addRole(email, role, addedByUid) {
  await setDoc(doc(db, 'roles', email), {
    role,
    addedBy: addedByUid,
    addedAt: serverTimestamp(),
  });
}

// Keep backwards compat
export async function addTeacherRole(email, addedByUid) {
  return addRole(email, 'teacher', addedByUid);
}

export async function addAdminRole(email, addedByUid) {
  return addRole(email, 'admin', addedByUid);
}

export async function removeRole(email) {
  await deleteDoc(doc(db, 'roles', email));
}

// Keep backwards compat
export async function removeTeacherRole(email) {
  return removeRole(email);
}

export async function getAllTeachers() {
  const snap = await getDocs(collection(db, 'roles'));
  return snap.docs
    .filter(d => d.data().role === 'teacher')
    .map(d => ({ email: d.id, ...d.data() }));
}

export async function getAllStaff() {
  const snap = await getDocs(collection(db, 'roles'));
  return snap.docs.map(d => ({ email: d.id, ...d.data() }));
}

export async function getAllStudents() {
  const snap = await getDocs(collection(db, 'users'));
  return snap.docs.map(d => ({ uid: d.id, ...d.data() }));
}

// ── ROLE HELPERS ──────────────────────────────────────────────────────────────
export function isStaffRole(role) {
  return ['teacher','admin','superadmin'].includes(role);
}
export function canAccessAdmin(role) {
  return ['admin','superadmin'].includes(role);
}
export function isSuperAdmin(email) {
  return email === 'n.clifford@thestreetlyacademy.co.uk';
}
export async function saveTeacherClasses(uid, classes) {
  await setDoc(doc(db, 'teachers', uid), { classes, updatedAt: serverTimestamp() }, { merge: true });
}

export async function getTeacherClasses(uid) {
  const snap = await getDoc(doc(db, 'teachers', uid));
  return snap.exists() ? (snap.data().classes || []) : [];
}

// ── ASSIGNMENTS ───────────────────────────────────────────────────────────────
export async function createAssignment(assignment) {
  // assignment: { title, subject, type, classes[], dueDate, note, link, createdBy }
  const ref = doc(collection(db, 'assignments'));
  await setDoc(ref, {
    ...assignment,
    createdAt: serverTimestamp(),
    active: true,
  });
  return ref.id;
}

export async function getActiveAssignmentsForClass(className) {
  const now = new Date().toISOString();
  const snap = await getDocs(collection(db, 'assignments'));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(a => a.active && a.classes?.includes(className) && a.dueDate >= now)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

export async function getAllAssignments() {
  const snap = await getDocs(collection(db, 'assignments'));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => b.createdAt?.toMillis?.() - a.createdAt?.toMillis?.());
}

export async function deleteAssignment(assignmentId) {
  await deleteDoc(doc(db, 'assignments', assignmentId));
}

export async function getStudentsByClass(className) {
  const snap = await getDocs(collection(db, 'users'));
  return snap.docs
    .map(d => ({ uid: d.id, ...d.data() }))
    .filter(u => u.class === className);
}

export async function getProgressForStudents(uids) {
  const modules = [
    'b1','b2','b3','b4','b5','b6','b7',
    'p1','p2','p3','p4','p5','p6','p7',
    'c1','c2','c3','c4','c5','c6','c7','c8','c9','c10',
  ];
  const result = {};
  for (const uid of uids) {
    result[uid] = {};
    for (const m of modules) {
      const snap = await getDoc(doc(db, 'users', uid, 'progress', m));
      if (snap.exists()) result[uid][m] = snap.data();
    }
  }
  return result;
}

// ── CURRICULUM SCHEDULE ───────────────────────────────────────────────────────
// Stored at schedule/{yearGroup}/{subject}
// Shape: { months: { "0": [block,...], "1": [block,...] ... } }
// Block shape (learning):  { type:'learn', modules:[], partialTopics:{}, span:1 }
// Block shape (assessment): { type:'assess', label:'', modules:[], partialTopics:{}, span:1 }

export async function saveSchedule(yearGroup, subject, monthBlocks) {
  // monthBlocks: plain object { "0": [blocks], "1": [blocks], ... }
  await setDoc(
    doc(db, 'schedule', String(yearGroup), 'subjects', subject),
    { months: monthBlocks, updatedAt: serverTimestamp() },
    { merge: false }
  );
}

export async function loadSchedule(yearGroup, subject) {
  const snap = await getDoc(doc(db, 'schedule', String(yearGroup), 'subjects', subject));
  return snap.exists() ? (snap.data().months || {}) : {};
}

// Load schedule for all three subjects for a given year group in one call
export async function loadScheduleForYear(yearGroup) {
  const subjects = ['Biology', 'Chemistry', 'Physics'];
  const result = {};
  await Promise.all(subjects.map(async s => {
    result[s] = await loadSchedule(yearGroup, s);
  }));
  return result;
}

// Returns the schedule status of a given module for a student's year group.
// Returns one of: 'current' | 'future' | 'past' | 'unknown'
// Used by module.html to badge/dim topics.
export async function getModuleScheduleStatus(yearGroup, subject, moduleId) {
  if (!yearGroup || !subject || !moduleId) return 'unknown';
  const months = await loadSchedule(yearGroup, subject);
  const nowMonthIdx = _academicMonthIndex();
  if (nowMonthIdx === -1) return 'unknown'; // August — outside schedule

  // Collect all month indices where this module appears in a block
  const blockMonths = [];
  Object.entries(months).forEach(([mi, blocks]) => {
    const idx = parseInt(mi);
    (blocks || []).forEach(b => {
      if (b.type !== 'learn') return;
      const mods = b.modules || [];
      if (mods.some(m => m.toLowerCase() === moduleId.toLowerCase())) {
        // block occupies idx through idx + (span-1)
        const span = b.span || 1;
        for (let s = 0; s < span; s++) blockMonths.push(idx + s);
      }
    });
  });

  if (!blockMonths.length) return 'unknown';

  const minM = Math.min(...blockMonths);
  const maxM = Math.max(...blockMonths);

  if (nowMonthIdx >= minM && nowMonthIdx <= maxM) return 'current';
  if (nowMonthIdx > maxM) return 'past';
  return 'future';
}

// Academic month index: Sep=0, Oct=1, ..., Jul=10, Aug=-1 (outside year)
function _academicMonthIndex() {
  const m = new Date().getMonth(); // 0=Jan
  if (m === 7) return -1; // August
  if (m >= 8) return m - 8; // Sep=0, Oct=1, Nov=2, Dec=3
  return m + 4;            // Jan=4, Feb=5, Mar=6, Apr=7, May=8, Jun=9, Jul=10
}

export { auth, db };
