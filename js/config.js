// ---------------------------------------------------------------------------
// Firebase configuration — needed for Google sign-in and online lobbies.
// See README.md ("Enable online play") for the 5-minute setup. Until you paste
// your own values here the game still works fully in offline mode vs bots.
//
// These values are NOT secrets (they identify your project; security comes from
// firestore.rules and the authorised-domain list in Firebase Auth).
// ---------------------------------------------------------------------------
/*
export const firebaseConfig = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: '',
};
*/
export const firebaseConfig = {
  apiKey: "AIzaSyB8iVG6p1gXL4CHSGm5EFGhKfXdvucGCRU",
  authDomain: "game-catan.firebaseapp.com",
  projectId: "game-catan",
  storageBucket: "game-catan.firebasestorage.app",
  messagingSenderId: "594734912272",
  appId: "1:594734912272:web:3a0d5f1e341d395ed44b95",
  measurementId: "G-7G090RY1WY"
};

export const ONLINE_ENABLED = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);
