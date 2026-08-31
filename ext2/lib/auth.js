// lib/auth.js
// -----------------------------------------------------------------------
// Google sign-in for a Chrome extension: chrome.identity.getAuthToken()
// uses the manifest's oauth2.client_id to get a Google access token via
// the browser's signed-in account (no popup-blocked OAuth redirect flow
// needed), which we then hand to Firebase Auth to mint a Firebase session.
//
// Requires (see README "Firebase + Google sign-in setup"):
//   1. A Google Cloud OAuth client of type "Chrome extension", using this
//      extension's ID, with its client_id pasted into manifest.json.
//   2. Google sign-in enabled as a provider in the Firebase project.
// -----------------------------------------------------------------------

import { signInWithGoogleAccessToken, signOutUser as firebaseSignOut } from "./firebaseClient.js";

export function getGoogleAccessToken({ interactive = true } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof chrome === "undefined" || !chrome.identity?.getAuthToken) {
      reject(new Error("chrome.identity is unavailable in this context."));
      return;
    }
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || "No token returned."));
      } else {
        resolve(token);
      }
    });
  });
}

export async function signInWithGoogle() {
  const token = await getGoogleAccessToken({ interactive: true });
  const user = await signInWithGoogleAccessToken(token);
  return user;
}

export async function signOut() {
  // Also revoke the cached Chrome token so the next sign-in re-prompts
  // account chooser rather than silently reusing a stale token.
  try {
    const token = await getGoogleAccessToken({ interactive: false });
    if (token && chrome.identity?.removeCachedAuthToken) {
      chrome.identity.removeCachedAuthToken({ token }, () => {});
    }
  } catch {
    /* no cached token — fine */
  }
  await firebaseSignOut();
}
