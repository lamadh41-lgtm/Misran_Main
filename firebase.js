// Firebase configuration - misran-4b187
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged, updateProfile, reauthenticateWithCredential, EmailAuthProvider, updateEmail, updatePassword } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, collection, doc, setDoc, getDoc, getDocs, addDoc, updateDoc, deleteDoc, query, where, orderBy, limit, startAfter, onSnapshot, serverTimestamp, arrayUnion, increment } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getStorage, ref, uploadBytes, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-analytics.js";

const firebaseConfig = {
  apiKey: "AIzaSyDZsj-4Oni6z1eTVGVChF2Lvs5cmLQURf4",
  authDomain: "misran-4b187.firebaseapp.com",
  projectId: "misran-4b187",
  storageBucket: "misran-4b187.firebasestorage.app",
  messagingSenderId: "381350421430",
  appId: "1:381350421430:web:4fde62abf0defa8ec35717",
  measurementId: "G-9VDVH0GLG1"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);
let analytics = null;
try { analytics = getAnalytics(app); } catch (_) { analytics = null; }

export { app, auth, db, storage, analytics, 
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged, 
  updateProfile, reauthenticateWithCredential, EmailAuthProvider, updateEmail, updatePassword,
  collection, doc, setDoc, getDoc, getDocs, addDoc, updateDoc, deleteDoc, query, where, orderBy, limit, startAfter, onSnapshot, serverTimestamp, arrayUnion, increment,
  ref, uploadBytes, getDownloadURL, deleteObject
};
