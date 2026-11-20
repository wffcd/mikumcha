// בדיקות אבטחה לחוקי Firestore – רצות אוטומטית בכל בנייה מול אמולטור.
// כל בדיקה מנסה פעולה לגיטימית (חייבת להצליח) או התקפה (חייבת להיכשל).
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection, getDocs, query, where, writeBatch, arrayUnion, arrayRemove, serverTimestamp } from 'firebase/firestore';

const A = 'aliceAAAAAAAAAAAAAAAAAAAAAAA', B = 'bobBBBBBBBBBBBBBBBBBBBBBBBBB', C = 'carolCCCCCCCCCCCCCCCCCCCCCCC', EVE = 'eveEEEEEEEEEEEEEEEEEEEEEEEEE';
const GID = 'group0000000000000001';
let env;
const db = u => env.authenticatedContext(u).firestore();
const anon = () => env.unauthenticatedContext().firestore();
const user = (name, code, photo = null) => ({ name, photo, color: '#2563eb', code });

before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-mikumcha', firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 } });
});
after(async () => { await env?.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const d = ctx.firestore();
    await setDoc(doc(d, 'users', A), user('Alice', 'AAAAAA'));
    await setDoc(doc(d, 'users', B), user('Bob', 'BBBBBB'));
    await setDoc(doc(d, 'users', EVE), user('Eve', 'EEEEEE'));
    await setDoc(doc(d, 'locations', A), { phone: '972501111111', sharing: true, viewers: [B], lat: 32.1, lng: 34.8, ts: 1 });
    await setDoc(doc(d, 'locations', B), { phone: '972502222222', sharing: true, viewers: [A], lat: 32.0, lng: 34.7, ts: 1 });
    await setDoc(doc(d, 'locations', A, 'trail', 'p1'), { lat: 32.1, lng: 34.8, ts: 1, speed: 3 });
    await setDoc(doc(d, 'groups', GID), { name: 'משפחה', emoji: '🏠', owner: A, members: [A, B], createdAt: new Date() });
    await setDoc(doc(d, 'phones', '972501111111'), { uid: A });
  });
});

// ---------- גישה בלי התחברות ----------
test('בלי התחברות: אין גישה לשום דבר', async () => {
  await assertFails(getDoc(doc(anon(), 'users', A)));
  await assertFails(getDoc(doc(anon(), 'locations', A)));
  await assertFails(getDoc(doc(anon(), 'groups', GID)));
  await assertFails(setDoc(doc(anon(), 'users', 'x'), user('x', 'XXXXXX')));
});

// ---------- פרופילים ----------
test('פרופיל: אפשר לקרוא לפי מזהה אבל לא לקבל רשימה של כולם', async () => {
  await assertSucceeds(getDoc(doc(db(EVE), 'users', A)));
  await assertFails(getDocs(collection(db(EVE), 'users')));
});
test('פרופיל: אי אפשר לשנות פרופיל של מישהו אחר', async () => {
  await assertFails(setDoc(doc(db(EVE), 'users', A), user('Hacked', 'AAAAAA')));
});
test('פרופיל: חוסם צבע/תמונה/שדות זדוניים', async () => {
  const d = db(A);
  await assertSucceeds(setDoc(doc(d, 'users', A), { ...user('Alice', 'AAAAAA', 'https://lh3.googleusercontent.com/a/x'), updatedAt: serverTimestamp() }));
  await assertFails(setDoc(doc(d, 'users', A), { ...user('Alice', 'AAAAAA'), color: 'red;background:url(javascript:alert(1))' }));
  await assertFails(setDoc(doc(d, 'users', A), user('Alice', 'AAAAAA', 'javascript:alert(1)')));
  await assertFails(setDoc(doc(d, 'users', A), user('Alice', 'AAAAAA', 'https://evil.com/x.png')));
  await assertFails(setDoc(doc(d, 'users', A), { ...user('Alice', 'AAAAAA'), isAdmin: true }));
  await assertFails(setDoc(doc(d, 'users', A), user('x'.repeat(200), 'AAAAAA')));
});

// ---------- טלפונים וקודים ----------
test('טלפון: אפשר לבדוק מספר מסוים, אי אפשר לקבל את כל הרשימה', async () => {
  await assertSucceeds(getDoc(doc(db(EVE), 'phones', '972501111111')));
  await assertFails(getDocs(collection(db(EVE), 'phones')));
});
test('טלפון: אי אפשר להשתלט על מספר של מישהו אחר', async () => {
  await assertFails(setDoc(doc(db(EVE), 'phones', '972501111111'), { uid: EVE }));
  await assertFails(deleteDoc(doc(db(EVE), 'phones', '972501111111')));
});
test('טלפון: רישום רק של המספר שבפרופיל שלי (באותה פעולה)', async () => {
  const d = db(EVE);
  const b = writeBatch(d);
  b.set(doc(d, 'locations', EVE), { phone: '972509999999', sharing: true, viewers: [] }, { merge: true });
  b.set(doc(d, 'phones', '972509999999'), { uid: EVE });
  await assertSucceeds(b.commit());
  await assertFails(setDoc(doc(d, 'phones', '972508888888'), { uid: EVE }));
});
test('קוד משתמש: רק הקוד שבפרופיל שלי', async () => {
  await assertSucceeds(setDoc(doc(db(EVE), 'codes', 'EEEEEE'), { uid: EVE }));
  await assertFails(setDoc(doc(db(EVE), 'codes', 'ZZZZZZ'), { uid: EVE }));
  await assertFails(setDoc(doc(db(EVE), 'codes', 'AAAAAA'), { uid: EVE }));
});

// ---------- מיקומים ----------
test('מיקום: רק מי שברשימת הצופים רואה', async () => {
  await assertSucceeds(getDoc(doc(db(B), 'locations', A)));
  await assertFails(getDoc(doc(db(EVE), 'locations', A)));
  await assertSucceeds(getDocs(collection(db(B), 'locations', A, 'trail')));
  await assertFails(getDocs(collection(db(EVE), 'locations', A, 'trail')));
  await assertFails(getDocs(collection(db(EVE), 'locations')));
});
test('מיקום: אי אפשר לכתוב מיקום של מישהו אחר או להוסיף את עצמי לצופים', async () => {
  await assertFails(setDoc(doc(db(EVE), 'locations', A), { lat: 0, lng: 0 }, { merge: true }));
  await assertFails(updateDoc(doc(db(EVE), 'locations', A), { viewers: arrayUnion(EVE) }));
  await assertFails(addDoc(collection(db(EVE), 'locations', A, 'trail'), { lat: 1, lng: 1, ts: 1, speed: null }));
});
test('מיקום: כתיבה תקינה של המיקום שלי מצליחה, ערכים זדוניים נחסמים', async () => {
  const d = db(A);
  await assertSucceeds(setDoc(doc(d, 'locations', A), { lat: 32.2, lng: 34.9, acc: 10, speed: 12.5, heading: null, ts: 5, stillSince: 4, tripStart: 3, tripFrom: { lat: 32, lng: 34 }, battery: 80, charging: false }, { merge: true }));
  await assertSucceeds(updateDoc(doc(d, 'locations', A), { home: { lat: 32, lng: 34.8, label: 'הבית' } }));
  await assertSucceeds(updateDoc(doc(d, 'locations', A), { home: null }));
  await assertFails(setDoc(doc(d, 'locations', A), { lat: 999 }, { merge: true }));
  await assertFails(setDoc(doc(d, 'locations', A), { lat: '<img src=x>' }, { merge: true }));
  await assertFails(setDoc(doc(d, 'locations', A), { evil: true }, { merge: true }));
  await assertSucceeds(addDoc(collection(d, 'locations', A, 'trail'), { lat: 1, lng: 1, ts: 1, speed: null }));
  await assertFails(addDoc(collection(d, 'locations', A, 'trail'), { lat: 1, lng: 1, ts: 1, speed: null, extra: 'x' }));
});

// ---------- קבוצות ----------
test('קבוצה: זר לא רואה ולא יכול להצטרף בלי הזמנה', async () => {
  await assertFails(getDoc(doc(db(EVE), 'groups', GID)));
  await assertFails(updateDoc(doc(db(EVE), 'groups', GID), { members: arrayUnion(EVE) }));
});
test('קבוצה: יצירה תקינה, וחסימת יצירה עם חברים שלא אישרו', async () => {
  const d = db(C);
  await assertSucceeds(addDoc(collection(d, 'groups'), { name: 'חברים', emoji: '🎉', owner: C, members: [C], createdAt: serverTimestamp() }));
  await assertFails(addDoc(collection(d, 'groups'), { name: 'x', emoji: '🎉', owner: C, members: [C, A], createdAt: serverTimestamp() }));
  await assertFails(addDoc(collection(d, 'groups'), { name: 'x', emoji: '🎉', owner: A, members: [C], createdAt: serverTimestamp() }));
  await assertFails(setDoc(doc(d, 'groups', 'bad"id<script>'), { name: 'x', emoji: '🎉', owner: C, members: [C], createdAt: serverTimestamp() }));
});
test('קבוצה: חבר רגיל לא יכול להוסיף/להסיר אחרים', async () => {
  await assertFails(updateDoc(doc(db(B), 'groups', GID), { members: arrayUnion(EVE) }));
  await assertFails(updateDoc(doc(db(B), 'groups', GID), { members: arrayRemove(A) }));
  await assertFails(updateDoc(doc(db(B), 'groups', GID), { owner: B }));
});
test('קבוצה: מנהל מסיר, חבר יוצא, שינוי שם', async () => {
  await assertSucceeds(updateDoc(doc(db(B), 'groups', GID), { name: 'משפחה שלנו' }));
  await assertSucceeds(updateDoc(doc(db(A), 'groups', GID), { members: arrayRemove(B) }));
});
test('קבוצה: חבר יכול לצאת בעצמו', async () => {
  await assertSucceeds(updateDoc(doc(db(B), 'groups', GID), { members: arrayRemove(B) }));
});
test('קבוצה: מנהל שיוצא חייב להעביר ניהול', async () => {
  await assertFails(updateDoc(doc(db(A), 'groups', GID), { members: arrayRemove(A) }));
  await assertSucceeds(updateDoc(doc(db(A), 'groups', GID), { members: arrayRemove(A), owner: B }));
});

// ---------- הזמנות ----------
const invite = (over = {}) => ({ gid: GID, groupName: 'משפחה', groupEmoji: '🏠', from: A, fromName: 'Alice', fromPhoto: null, to: C, toName: 'Carol', toPhoto: null, createdAt: serverTimestamp(), ...over });
test('הזמנה: תהליך מלא – הזמנה, אישור והצטרפות', async () => {
  await assertSucceeds(setDoc(doc(db(A), 'invites', GID + '_' + C), invite()));
  await assertSucceeds(getDocs(query(collection(db(C), 'invites'), where('to', '==', C))));
  await assertSucceeds(getDoc(doc(db(C), 'groups', GID)));
  await assertSucceeds(updateDoc(doc(db(C), 'groups', GID), { members: arrayUnion(C) }));
  await assertSucceeds(deleteDoc(doc(db(C), 'invites', GID + '_' + C)));
});
test('הזמנה: אי אפשר להתחזות לשולח אחר או לשנות את שם הקבוצה', async () => {
  await assertFails(setDoc(doc(db(A), 'invites', GID + '_' + C), invite({ fromName: 'המשטרה' })));
  await assertFails(setDoc(doc(db(A), 'invites', GID + '_' + C), invite({ groupName: 'זכית בפרס!' })));
  await assertFails(setDoc(doc(db(A), 'invites', GID + '_' + C), invite({ from: B, fromName: 'Bob' })));
});
test('הזמנה: זר לא יכול להזמין לקבוצה שהוא לא בה', async () => {
  await assertFails(setDoc(doc(db(EVE), 'invites', GID + '_' + C), invite({ from: EVE, fromName: 'Eve' })));
});
test('הזמנה: אי אפשר לקרוא הזמנות של אחרים', async () => {
  await env.withSecurityRulesDisabled(async ctx => setDoc(doc(ctx.firestore(), 'invites', GID + '_' + C), invite()));
  await assertFails(getDoc(doc(db(EVE), 'invites', GID + '_' + C)));
  await assertFails(getDocs(collection(db(EVE), 'invites')));
});
test('כל אוסף אחר חסום', async () => {
  await assertFails(setDoc(doc(db(A), 'admin', 'x'), { a: 1 }));
  await assertFails(getDoc(doc(db(A), 'admin', 'x')));
});
