import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { initializeFirestore } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

interface FirebaseAppConfig {
  apiKey?: string;
  authDomain?: string;
  projectId?: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId?: string;
  measurementId?: string;
  firestoreDatabaseId?: string;
}

const config = firebaseConfig as FirebaseAppConfig;

const app = initializeApp(firebaseConfig);
const dbId = config.firestoreDatabaseId && config.firestoreDatabaseId !== "(default)"
  ? config.firestoreDatabaseId
  : undefined;

// Use initializeFirestore with long-polling to prevent proxy/iframe/adblocker WebSocket connection blockages.
// ignoreUndefinedProperties: the app has many optional fields (camera
// department/ownership/location/etc.) that come out as JS `undefined` when
// left blank — Firestore's SDK otherwise rejects the entire write for that,
// rather than just omitting the field.
const firestoreSettings = { experimentalForceLongPolling: true, ignoreUndefinedProperties: true };
export const db = dbId
  ? initializeFirestore(app, firestoreSettings, dbId)
  : initializeFirestore(app, firestoreSettings);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
