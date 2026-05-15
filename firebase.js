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

export { auth, db };
