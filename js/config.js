// ---------------------------------------------------------------------------
// Firebase configuration — needed for Google sign-in and online lobbies.
// See README.md ("Enable online play") for the 5-minute setup. Until you paste
// your own values here the game still works fully in offline mode vs bots.
//
// These values are NOT secrets (they identify your project; security comes from
// firestore.rules and the authorised-domain list in Firebase Auth).
// ---------------------------------------------------------------------------
export const firebaseConfig = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: '',
};

export const ONLINE_ENABLED = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);
