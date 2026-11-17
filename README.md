# מיקומך

אפליקציה לשיתוף מיקום עם משפחה וחברים: זמן הגעה, מסלול, וניתוח "למה מתעכב?".

- **אפליקציית אנדרואיד** (Capacitor) – שיתוף מיקום גם ברקע.
- **גרסת אתר** (PWA) – בכתובת `/app/` באתר ההורדה.
- **שרת**: Firebase (התחברות עם Google + Firestore). חוקי האבטחה ב-`firestore.rules`.
- **מפות**: OpenStreetMap / CARTO, מסלולים: OSRM, זיהוי מקומות: Nominatim.

## בנייה
כל דחיפה ל-`main` בונה APK ומפרסמת את אתר ההורדה ל-GitHub Pages (`.github/workflows/build.yml`).
מפתח החתימה שמור מוצפן ב-`keys/release.jks.enc`, והסיסמה בסוד `KEYSTORE_PASSWORD` של המאגר.

## פיתוח מקומי
```
npm install
npm run dev
```
