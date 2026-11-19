// "למה מתעכב?" – ניתוח לפי מיקום, מהירות, זמן עמידה, סוג המקום, סוללה ותגובה לשיחות
import { haversine, fmtDur, fmtDist, clockIn } from './util.js';

export function derive(P, alertMin) {
  const L = P.loc, now = Date.now();
  if (P.denied) return { kind: 'off' };
  if (!L || L.lat == null) return { kind: 'none' };
  if (L.sharing === false) return { kind: 'off' };
  const ageMin = (now - (L.ts || 0)) / 60000;
  const stillMin = L.stillSince ? Math.max(0, (now - L.stillSince) / 60000) : 0;
  const kmh = L.speed != null ? L.speed * 3.6 : null;
  const moving = stillMin < 2 && ageMin < 6;
  const atDest = P.dest && haversine(L, P.dest) < 150;
  const place = P.place;
  const onRoad = place && place.type === 'road';
  const startedTrip = L.tripStart && (!L.stillSince || L.tripStart <= L.stillSince + 60000) && (moving || stillMin < 30);
  let etaMin = null, remain = null, delayMin = null;
  if (P.route && !atDest) {
    remain = P.route.distance;
    const slow = moving && kmh != null && kmh < 20;
    etaMin = Math.max(1, Math.round(P.route.duration / 60 * (slow ? 1.5 : 1.1)));
    if (P.expected && L.tripStart && startedTrip) {
      delayMin = ((now - L.tripStart) / 1000 + P.route.duration - P.expected.duration) / 60;
    }
  }
  const alert = !atDest && onRoad && stillMin > alertMin && (P.noAnswer > 0 || ageMin > 20);
  const roadLong = !atDest && onRoad && stillMin > alertMin && !alert;
  return { kind: 'ok', ageMin, stillMin, kmh, moving, atDest, place, onRoad, etaMin, remain, delayMin, alert, roadLong, startedTrip, battery: L.battery, charging: L.charging };
}

const DOT = { ok: '#16a34a', warn: '#f59e0b', bad: '#dc2626', idle: '#94a3b8' };
const CLS = { ok: 'b-ok', warn: 'b-warn', bad: 'b-bad', idle: 'b-idle' };
function S(level, txt, badge) { return { level, txt, badge, cls: CLS[level], dot: DOT[level] }; }

export function status(P, alertMin) {
  const d = derive(P, alertMin);
  if (d.kind === 'none') return S('idle', 'ממתין/ה למיקום ראשון', '—');
  if (d.kind === 'off') return S('idle', 'לא משתף/ת מיקום כרגע', 'מוסתר');
  const eta = d.etaMin != null && (d.moving || d.startedTrip) ? d.etaMin + ' דק׳' : null;
  const where = d.place?.name ? ' · ' + d.place.name : '';
  if (d.ageMin > 20 && !d.alert) return S('warn', `לא מעודכן ${fmtDur(d.ageMin)}${d.atDest ? (P.destKind === 'me' ? ' · נראה/תה לאחרונה לידך' : ' · נראה/תה לאחרונה בבית') : d.place?.name ? ' · נראה/תה לאחרונה ב' + d.place.name : ''}`, 'לא מעודכן');
  if (d.atDest) return S('ok', P.destKind === 'me' ? 'הגיע/ה אליך' : 'בבית', P.destKind === 'me' ? 'הגיע/ה' : 'בבית');
  if (d.alert) return S('bad', `עומד/ת ${fmtDur(d.stillMin)}${where}`, '⚠ חריג');
  if (d.roadLong) return S('warn', `עומד/ת ${fmtDur(d.stillMin)} על כביש${where}`, 'לבדוק');
  if (!d.moving && d.stillMin >= 2 && !d.onRoad) return S('idle', `${d.place?.name || 'במקום'} · ${fmtDur(d.stillMin)}`, 'במקום');
  if (!d.moving && d.stillMin >= 2) return S('warn', `עומד/ת ${fmtDur(d.stillMin)}${where}`, eta || 'עומד/ת');
  if (d.kmh != null && d.kmh < 15) return S('warn', `זוחל/ת ב-${Math.round(d.kmh)} קמ״ש${where}`, eta || 'איטי');
  return S('ok', `בדרך${d.kmh != null ? ' · ' + Math.round(d.kmh) + ' קמ״ש' : ''}`, eta || 'בדרך');
}

export function analyze(P, alertMin) {
  const d = derive(P, alertMin), n = P.name;
  if (d.kind === 'none') return { sev: 'info', title: 'אין עדיין מיקום', lead: `${n} עוד לא שלח/ה מיקום. ייתכן שהאפליקציה לא נפתחה אצלו/ה או שהרשאת המיקום כבויה.`, facts: [], hyp: [] };
  if (d.kind === 'off') return { sev: 'info', title: 'שיתוף המיקום כבוי', lead: `${n} הפסיק/ה לשתף מיקום, ולכן אי אפשר לבדוק. אפשר להתקשר.`, facts: [], hyp: [] };
  const facts = [
    d.kmh != null ? `מהירות: ${Math.round(d.kmh)} קמ״ש` : 'מהירות: לא ידועה',
    d.stillMin >= 2 ? `באותו מקום: ${fmtDur(d.stillMin)}` : (d.remain != null ? `נשאר: ${fmtDist(d.remain)}` : 'בתנועה'),
    d.battery != null ? `סוללה${d.ageMin > 20 ? ' (בעדכון האחרון)' : ''}: ${d.battery}%${d.charging ? ' ⚡' : ''}` : null,
    `עדכון אחרון: ${d.ageMin < 1 ? 'עכשיו' : 'לפני ' + fmtDur(d.ageMin)}`,
    P.noAnswer ? `שיחות שלא נענו: ${P.noAnswer}` : null,
    d.place?.name ? `📍 ${d.place.name}` : null
  ].filter(Boolean);
  const delayTxt = d.delayMin != null && d.delayMin > 4 ? ` ביחס לנסיעה רגילה הוא/היא מאחר/ת בכ-${Math.round(d.delayMin)} דק׳.` : '';

  if (d.ageMin > 20) {
    const low = d.battery != null && d.battery <= 15 && !d.charging;
    const hyp = [
      { l: 'הטלפון כבה (נגמרה הסוללה)', p: low ? 60 : 25, why: low ? `בעדכון האחרון הסוללה הייתה ${d.battery}%` : 'אין עדכונים מהטלפון' },
      { l: 'אין קליטה באזור', p: low ? 25 : 45, why: 'לפעמים במנהרות, חניונים ואזורים פתוחים אין קליטה' },
      { l: 'האפליקציה נסגרה / הטלפון הופעל מחדש', p: low ? 15 : 30, why: 'חיסכון בסוללה או הפעלה מחדש עוצרים את השיתוף עד שפותחים את האפליקציה' }];
    return { sev: d.alert ? 'alert' : 'warn', title: 'המיקום הפסיק להתעדכן', lead: `העדכון האחרון מ${n} התקבל לפני ${fmtDur(d.ageMin)}${d.atDest ? (P.destKind === 'me' ? ', כשהיה/תה לידך' : ', כשהיה/תה בבית') : d.place?.name ? ', ב' + d.place.name : ''}. המיקום שמוצג הוא הישן – ייתכן שהוא/היא כבר במקום אחר. כדאי להתקשר, ולבקש לפתוח את האפליקציה.`, facts, hyp };
  }
  if (d.atDest) return { sev: 'ok', title: 'הכול בסדר', lead: `${n} ${P.destKind === 'me' ? 'כבר אצלך' : 'כבר בבית'}.`, facts, hyp: [] };

  if (d.alert || d.roadLong) {
    const major = d.place?.major;
    const hyp = d.alert ? [
      { l: 'תקלה ברכב או תאונה', p: major ? 50 : 40, why: `עצירה מלאה על ${major ? 'כביש ראשי' : 'כביש'} ${fmtDur(d.stillMin)}, בלי תזוזה` },
      { l: 'הטלפון לא נשמע / בתיק', p: d.battery != null && d.battery < 20 ? 30 : 25, why: 'לא ענה/תה לשיחה' },
      { l: 'פקק עומד בגלל תאונה של אחרים', p: major ? 20 : 35, why: 'עמידה ארוכה קורית גם בחסימות' }]
      : [
        { l: 'פקק כבד / חסימה', p: 55, why: `עומד/ת על כביש ${fmtDur(d.stillMin)}` },
        { l: 'עצירה בצד הדרך', p: 30, why: 'למשל לדבר בטלפון או לחכות למישהו' },
        { l: 'תקלה ברכב', p: 15, why: 'עמידה ארוכה במקום שאינו חניה' }];
    return {
      sev: d.alert ? 'alert' : 'warn', title: d.alert ? 'עיכוב חריג – כדאי לבדוק' : 'עומד/ת זמן רב על כביש',
      lead: d.alert ? `${n} עומד/ת באותה נקודה ${fmtDur(d.stillMin)}${d.place?.name ? ' על ' + d.place.name : ''} ולא עונה. זה לא נראה כמו פקק רגיל.`
        : `${n} עומד/ת ${fmtDur(d.stillMin)}${d.place?.name ? ' על ' + d.place.name : ''}. מומלץ להתקשר – אם לא יענה/תענה, האפליקציה תציע לפנות לעזרה.`,
      facts, hyp, suggestCall: !d.alert
    };
  }
  if (!d.moving && d.stillMin >= 2 && !d.onRoad) {
    const notLeft = !d.startedTrip;
    return {
      sev: 'info', title: notLeft ? 'עוד לא יצא/ה לדרך' : 'עצירה במקום',
      lead: `${n} נמצא/ת ב${d.place?.name || 'אותו מקום'} כבר ${fmtDur(d.stillMin)}.${d.etaMin ? ` אם יצא/ה עכשיו – הגעה בערך ב-${clockIn(d.etaMin)}.` : ''}`,
      facts, hyp: [
        { l: notLeft ? 'עדיין עסוק/ה – יוצא/ת מאוחר' : 'עצירה מתוכננת (קניות / סידורים / חברים)', p: 75, why: 'המיקום הוא מקום ולא כביש' },
        { l: 'ממתין/ה להסעה או למישהו', p: 17, why: 'שהייה באותה נקודה' },
        { l: 'משהו לא תקין', p: 8, why: 'אין סימנים חריגים' }]
    };
  }
  if (d.kmh != null && d.kmh < 15 && d.moving) {
    return {
      sev: 'warn', title: 'כנראה פקק',
      lead: `${n} זז/ה לאט (${Math.round(d.kmh)} קמ״ש)${d.place?.name ? ' על ' + d.place.name : ''}.${d.etaMin ? ` הגעה משוערת בערך ב-${clockIn(d.etaMin)}.` : ''}${delayTxt}`,
      facts, hyp: [
        { l: 'עומס תנועה', p: 80, why: 'תנועה איטית אבל רציפה' },
        { l: 'עבודות בכביש / הסטת תנועה', p: 12, why: 'האטה מקומית' },
        { l: 'הליכה ברגל / חיפוש חניה', p: 8, why: 'מהירות נמוכה מאוד' }]
    };
  }
  if (!d.moving && d.stillMin >= 2) {
    return { sev: 'warn', title: 'עצירה קצרה', lead: `${n} עומד/ת ${fmtDur(d.stillMin)} – כנראה רמזור, פקק נקודתי או עצירה קצרה.${delayTxt}`, facts,
      hyp: [{ l: 'רמזור / צומת עמוס', p: 65, why: 'עצירה קצרה' }, { l: 'עצירה מכוונת', p: 35, why: '—' }] };
  }
  if (d.delayMin != null && d.delayMin > 6) {
    return { sev: 'warn', title: `מאחר/ת בכ-${Math.round(d.delayMin)} דק׳`, lead: `${n} נוסע/ת עכשיו כרגיל, אבל מאז היציאה הנסיעה לקחה יותר מהרגיל.${d.etaMin ? ` הגעה משוערת ב-${clockIn(d.etaMin)}.` : ''}`, facts,
      hyp: [{ l: 'עומס בקטע שכבר עבר/ה', p: 70, why: 'הזמן מאז היציאה ארוך מזמן נסיעה רגיל' }, { l: 'עצירה בדרך', p: 30, why: 'עצירות קצרות מצטברות' }] };
  }
  return { sev: 'ok', title: 'לא מתעכב/ת 👍', lead: `${n} בדרך${d.kmh != null ? ` במהירות רגילה (${Math.round(d.kmh)} קמ״ש)` : ''}.${d.etaMin ? ` הגעה משוערת ב-${clockIn(d.etaMin)}, בעוד כ-${d.etaMin} דק׳.` : ''}`, facts,
    hyp: [{ l: 'בדרך כרגיל', p: 92, why: 'תזוזה רציפה' }, { l: 'עיכוב קטן בהמשך', p: 8, why: 'עומס אפשרי בדרך' }] };
}
