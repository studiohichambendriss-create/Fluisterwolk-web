import { initializeApp } from "firebase/app";
import { getFirestore, collection, addDoc, getDocs, deleteDoc, doc, updateDoc } from "firebase/firestore";
import { getStorage, ref, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "firebase/auth";

// DEFAULT PLACEHOLDER CONFIG
// Users can replace this with their Firebase Config in firebaseConfig.json or directly here
const firebaseConfig = {
  apiKey: "PLACEHOLDER_API_KEY",
  authDomain: "PLACEHOLDER_AUTH_DOMAIN",
  projectId: "PLACEHOLDER_PROJECT_ID",
  storageBucket: "PLACEHOLDER_STORAGE_BUCKET",
  messagingSenderId: "PLACEHOLDER_MESSAGING_SENDER_ID",
  appId: "PLACEHOLDER_APP_ID"
};

// Check if config has placeholders
const isMockMode = !firebaseConfig.apiKey || firebaseConfig.apiKey.includes("PLACEHOLDER");

let app, db, storage, auth;

if (!isMockMode) {
  try {
    app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    storage = getStorage(app);
    auth = getAuth(app);
    console.log("Firebase connection established successfully.");
  } catch (error) {
    console.error("Firebase initialization failed. Falling back to Mock Mode.", error);
  }
} else {
  console.log("Firebase Config is using placeholders. Running in client-side MOCK MODE (localStorage & mock files).");
}

// ==========================================
// MOCK IMPLEMENTATIONS (Failsafe LocalStorage)
// ==========================================

const getMockWhispers = () => {
  const data = localStorage.getItem("fluisterwolk_mock_whispers_v2");
  if (!data) {
    // Start empty. No crazy music.
    const initialSeeds = [];
    localStorage.setItem("fluisterwolk_mock_whispers_v2", JSON.stringify(initialSeeds));
    return initialSeeds;
  }
  return JSON.parse(data);
};

const saveMockWhispers = (whispers) => {
  localStorage.setItem("fluisterwolk_mock_whispers_v2", JSON.stringify(whispers));
};

// ==========================================
// EXPOSED INTERFACE
// ==========================================

export const dbService = {
  // Add new whisper entry
  addWhisper: async (whisperData) => {
    if (!isMockMode && db) {
      try {
        const docRef = await addDoc(collection(db, "whispers"), whisperData);
        return docRef.id;
      } catch (e) {
        console.error("Firestore error, saving to mock db instead:", e);
      }
    }
    
    // Mock
    const mockList = getMockWhispers();
    const newId = "mock-" + Math.random().toString(36).substring(2, 9);
    const newRecord = { id: newId, ...whisperData };
    mockList.push(newRecord);
    saveMockWhispers(mockList);
    return newId;
  },

  // Get all whispers
  getWhispers: async () => {
    if (!isMockMode && db) {
      try {
        const querySnapshot = await getDocs(collection(db, "whispers"));
        const list = [];
        querySnapshot.forEach((doc) => {
          list.push({ id: doc.id, ...doc.data() });
        });
        return list;
      } catch (e) {
        console.error("Firestore error, loading mock db:", e);
      }
    }
    
    // Mock
    return getMockWhispers();
  },

  // Delete whisper
  deleteWhisper: async (id) => {
    if (!isMockMode && db) {
      try {
        await deleteDoc(doc(db, "whispers", id));
        return true;
      } catch (e) {
        console.error("Firestore error:", e);
      }
    }

    // Mock
    let mockList = getMockWhispers();
    mockList = mockList.filter(item => item.id !== id);
    saveMockWhispers(mockList);
    return true;
  }
};

export const storageService = {
  // Upload audio blob
  uploadAudio: async (blob, filename) => {
    if (!isMockMode && storage) {
      try {
        const storageRef = ref(storage, `whispers/${filename}`);
        await uploadBytes(storageRef, blob);
        const url = await getDownloadURL(storageRef);
        return url;
      } catch (e) {
        console.error("Firebase Storage error, simulating upload URL:", e);
      }
    }

    // Mock - Convert blob to data URL for local persistence
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        resolve(reader.result); // Base64 Data URL
      };
      reader.readAsDataURL(blob);
    });
  },

  // Delete audio object
  deleteAudio: async (filename) => {
    if (!isMockMode && storage) {
      try {
        const storageRef = ref(storage, `whispers/${filename}`);
        await deleteObject(storageRef);
        return true;
      } catch (e) {
        console.error("Firebase Storage delete error:", e);
      }
    }
    return true;
  }
};

export const authService = {
  // Login admin
  loginAdmin: async (email, password) => {
    if (!isMockMode && auth) {
      const userCredential = await signInWithEmailAndPassword(auth, email, password);
      return userCredential.user;
    }

    // Mock Admin Bypass (Demo authentication)
    if (email === "admin@fluisterwolk.nl" && password === "fluisteradmin") {
      const mockUser = { email, uid: "mock-admin-uid" };
      localStorage.setItem("fluisterwolk_mock_user", JSON.stringify(mockUser));
      return mockUser;
    } else {
      throw new Error("Invalid mock credentials. (Use email: admin@fluisterwolk.nl, password: fluisteradmin)");
    }
  },

  // Logout admin
  logoutAdmin: async () => {
    if (!isMockMode && auth) {
      await signOut(auth);
      return;
    }
    localStorage.removeItem("fluisterwolk_mock_user");
  },

  // Observe login state changes
  onAuthChange: (callback) => {
    if (!isMockMode && auth) {
      return onAuthStateChanged(auth, callback);
    }
    
    // Mock observer
    const checkState = () => {
      const stored = localStorage.getItem("fluisterwolk_mock_user");
      callback(stored ? JSON.parse(stored) : null);
    };
    checkState();
    // Simulate window focus checks
    window.addEventListener("focus", checkState);
    return () => window.removeEventListener("focus", checkState);
  }
};

export { isMockMode };
