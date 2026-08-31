// lib/firebaseClient.js
// -----------------------------------------------------------------------
// Thin wrapper around the (locally vendored, see lib/vendor/README.md)
// Firebase compat SDK. Two responsibilities:
//   1. Auth: expose the current user + a subscribe function.
//   2. Firestore: persist account info and a redaction event log, scoped
//      per-user under /users/{uid}.
//
// Firestore layout:
//   users/{uid}                          — account profile (see saveUserProfile)
//   users/{uid}/redactionEvents/{eventId} — one doc per pipeline run (see logRedactionEvent)
// -----------------------------------------------------------------------

import { FIREBASE_CONFIG } from "./firebaseConfig.js";

let app = null;
let authInstance = null;
let dbInstance = null;

export function initFirebase() {
  if (typeof firebase === "undefined") {
    throw new Error(
      "Firebase SDK not found. See lib/vendor/README.md — the compat SDK files need to be downloaded into lib/vendor/."
    );
  }
  if (!app) {
    app = firebase.initializeApp(FIREBASE_CONFIG);
    authInstance = firebase.auth();
    dbInstance = firebase.firestore();
  }
  return { app, auth: authInstance, db: dbInstance };
}

export function onAuthStateChanged(callback) {
  const { auth } = initFirebase();
  return auth.onAuthStateChanged(callback);
}

export function getCurrentUser() {
  const { auth } = initFirebase();
  return auth.currentUser;
}

/** Exchange a Google OAuth access token (from chrome.identity) for a Firebase session. */
export async function signInWithGoogleAccessToken(accessToken) {
  const { auth } = initFirebase();
  const credential = firebase.auth.GoogleAuthProvider.credential(null, accessToken);
  const result = await auth.signInWithCredential(credential);
  await saveUserProfile(result.user);
  return result.user;
}

export async function signOutUser() {
  const { auth } = initFirebase();
  await auth.signOut();
}

/** Upsert the account-info document shown in the "Account" section of the UI. */
export async function saveUserProfile(user) {
  const { db } = initFirebase();
  if (!user) return;
  await db
    .collection("users")
    .doc(user.uid)
    .set(
      {
        displayName: user.displayName,
        email: user.email,
        photoURL: user.photoURL,
        lastLoginAt: firebase.firestore.FieldValue.serverTimestamp(),
        createdAt: firebase.firestore.FieldValue.serverTimestamp(), // no-op on merge if already set
      },
      { merge: true }
    );
}

export async function fetchUserProfile(uid) {
  const { db } = initFirebase();
  const snap = await db.collection("users").doc(uid).get();
  return snap.exists ? snap.data() : null;
}

/** One document per completed pipeline run — powers the expandable redaction log. */
export async function logRedactionEvent(uid, { task, manifest, actionPlan, latencyMs, simulated }) {
  const { db } = initFirebase();
  if (!uid) return;
  await db
    .collection("users")
    .doc(uid)
    .collection("redactionEvents")
    .add({
      task,
      manifest, // [{source, category}] — categories only, never redacted content
      actionSummary: actionPlan?.reasoning || null,
      actionCount: actionPlan?.actions?.length ?? 0,
      latencyMs: latencyMs ?? null,
      simulated: !!simulated,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
}

/** Most recent N redaction events, newest first — for the expandable log section. */
export async function fetchRedactionHistory(uid, limit = 50) {
  const { db } = initFirebase();
  if (!uid) return [];
  const snap = await db
    .collection("users")
    .doc(uid)
    .collection("redactionEvents")
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}
