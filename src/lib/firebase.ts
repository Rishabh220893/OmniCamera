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

// Use initializeFirestore with long-polling to prevent proxy/iframe/adblocker WebSocket connection blockages
export const db = dbId 
  ? initializeFirestore(app, { experimentalForceLongPolling: true }, dbId) 
  : initializeFirestore(app, { experimentalForceLongPolling: true });
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
