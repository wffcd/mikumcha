import { Capacitor } from '@capacitor/core';
import { initializeApp } from 'firebase/app';
import {
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, browserPopupRedirectResolver,
  GoogleAuthProvider, signInWithCredential, signInWithPopup, signInWithRedirect, signOut
} from 'firebase/auth';
import { initializeFirestore } from 'firebase/firestore';
import { firebaseConfig } from '../firebase-config.js';

export const isNative = Capacitor.isNativePlatform();
export const configured = !String(firebaseConfig.apiKey).startsWith('REPLACE');

export const app = configured ? initializeApp(firebaseConfig) : null;
export const auth = configured ? initializeAuth(app, {
  persistence: [indexedDBLocalPersistence, browserLocalPersistence],
  popupRedirectResolver: isNative ? undefined : browserPopupRedirectResolver
}) : null;
export const db = configured ? initializeFirestore(app, { experimentalAutoDetectLongPolling: true }) : null;

export async function signInGoogle() {
  if (isNative) {
    const { FirebaseAuthentication } = await import('@capacitor-firebase/authentication');
    const r = await FirebaseAuthentication.signInWithGoogle();
    const cred = GoogleAuthProvider.credential(r.credential?.idToken, r.credential?.accessToken);
    return signInWithCredential(auth, cred);
  }
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try { return await signInWithPopup(auth, provider); }
  catch (e) {
    if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment', 'auth/cancelled-popup-request'].includes(e.code)) return signInWithRedirect(auth, provider);
    throw e;
  }
}

export async function logout() {
  if (isNative) { try { const { FirebaseAuthentication } = await import('@capacitor-firebase/authentication'); await FirebaseAuthentication.signOut(); } catch (e) { } }
  await signOut(auth);
}
