import { initializeApp } from "firebase/app";
import { getFirestore, collection, addDoc, getDocs, deleteDoc, doc, updateDoc, setDoc } from "firebase/firestore";
import { getStorage, ref, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "firebase/auth";

// DEFAULT CONFIG
const defaultFirebaseConfig = {
  apiKey: "AIzaSyACL17XUx2MIgGh5qjfoaRy8iCRYByR4ak",
  authDomain: "fluisterwolk.firebaseapp.com",
  projectId: "fluisterwolk",
  storageBucket: "fluisterwolk.firebasestorage.app",
  messagingSenderId: "981385480319",
  appId: "1:981385480319:web:bd8ffdb0180ffbb669174a",
  measurementId: "G-7WZ83V1N50"
};

// Load dynamic config override if present in localStorage
let firebaseConfig = { ...defaultFirebaseConfig };
const configOverride = localStorage.getItem("fluisterwolk_firebase_config");
if (configOverride) {
  try {
    const parsed = JSON.parse(configOverride);
    if (parsed && parsed.apiKey) {
      firebaseConfig = parsed;
      console.log("Firebase config override loaded from localStorage.");
    }
  } catch (e) {
    console.error("Failed to parse Firebase config override:", e);
  }
}

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
    const initialSeeds = [];
    localStorage.setItem("fluisterwolk_mock_whispers_v2", JSON.stringify(initialSeeds));
    return initialSeeds;
  }
  return JSON.parse(data);
};

const saveMockWhispers = (whispers) => {
  localStorage.setItem("fluisterwolk_mock_whispers_v2", JSON.stringify(whispers));
};

const getMockDeletedWhispers = () => {
  const data = localStorage.getItem("fluisterwolk_mock_deleted_whispers");
  if (!data) {
    localStorage.setItem("fluisterwolk_mock_deleted_whispers", JSON.stringify([]));
    return [];
  }
  return JSON.parse(data);
};

const saveMockDeletedWhispers = (whispers) => {
  localStorage.setItem("fluisterwolk_mock_deleted_whispers", JSON.stringify(whispers));
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

  // Get all active whispers
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

  // Get all deleted whispers from trash bin
  getDeletedWhispers: async () => {
    if (!isMockMode && db) {
      try {
        const querySnapshot = await getDocs(collection(db, "deleted_whispers"));
        const list = [];
        querySnapshot.forEach((doc) => {
          list.push({ id: doc.id, ...doc.data() });
        });
        return list;
      } catch (e) {
        console.error("Firestore loading trash error:", e);
      }
    }
    return getMockDeletedWhispers();
  },

  // Soft delete: move to trash bin
  deleteWhisper: async (whisper) => {
    const { id, ...data } = whisper;
    if (!isMockMode && db) {
      try {
        // 1. Write to deleted_whispers collection
        await setDoc(doc(db, "deleted_whispers", id), {
          ...data,
          deletedAt: new Date().toISOString()
        });
        // 2. Remove from active whispers collection
        await deleteDoc(doc(db, "whispers", id));
        return true;
      } catch (e) {
        console.error("Firestore soft delete error:", e);
      }
    }

    // Mock soft delete
    let mockList = getMockWhispers();
    const itemToDelete = mockList.find(item => item.id === id);
    if (itemToDelete) {
      mockList = mockList.filter(item => item.id !== id);
      saveMockWhispers(mockList);

      const mockTrash = getMockDeletedWhispers();
      mockTrash.push({
        ...itemToDelete,
        deletedAt: new Date().toISOString()
      });
      saveMockDeletedWhispers(mockTrash);
    }
    return true;
  },

  // Restore from trash bin back to active
  restoreWhisper: async (whisper) => {
    const { id, deletedAt, ...data } = whisper;
    if (!isMockMode && db) {
      try {
        // 1. Write back to active whispers collection
        await setDoc(doc(db, "whispers", id), data);
        // 2. Delete from trash collection
        await deleteDoc(doc(doc(db, "deleted_whispers", id)));
        return true;
      } catch (e) {
        console.error("Firestore restore error:", e);
      }
    }

    // Mock restore
    let mockTrash = getMockDeletedWhispers();
    const itemToRestore = mockTrash.find(item => item.id === id);
    if (itemToRestore) {
      mockTrash = mockTrash.filter(item => item.id !== id);
      saveMockDeletedWhispers(mockTrash);

      const mockList = getMockWhispers();
      const { deletedAt: dummy, ...cleanItem } = itemToRestore;
      mockList.push(cleanItem);
      saveMockWhispers(mockList);
    }
    return true;
  },

  // Permanent purge
  purgeWhisper: async (id) => {
    if (!isMockMode && db) {
      try {
        await deleteDoc(doc(db, "deleted_whispers", id));
        return true;
      } catch (e) {
        console.error("Firestore purge error:", e);
      }
    }

    // Mock purge
    let mockTrash = getMockDeletedWhispers();
    mockTrash = mockTrash.filter(item => item.id !== id);
    saveMockDeletedWhispers(mockTrash);
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

export const DEFAULT_SETTINGS = {
  calibration: {
    whisper_threshold_value: 0.038,
    max_record_duration: 3.0,
    confirmation_timeout: 10.0,
    no_whisper_timeout: 3.0
  },
  texts: {
    initial_message_text: `DE FLUISTERWOLK\nomhult je met namen van dierbare overleden.\nWie mis jij?\nFluister deze naam terwijl je de knop ingedrukt houdt.\n\n\n\n\nTHE WHISPERING CLOUD\nsurrounds you with names of deceased beloved ones. \nWho are you missing? \nWhisper this name while you keep the button pressed.`,
    initial_message_color: [165, 231, 253],

    whisper_prompt_text: `Fluister zachtjes de naam in de microfoon\n\n\n\nWhisper softly the name into the mic`,
    whisper_prompt_color: [247, 196, 255],

    checking_audio_text: `Dank,\nwacht nog even op mij\n\n\nThank you,\nWait a little for me`,
    checking_audio_color: [158, 236, 255],

    whisper_thank_you_text: `Om de naam aan de Fluisterwolk toe te voegen, druk de knop 1 maal\nOm te verwijderen druk de knop 2 maal\n\n\n\nTo save the name press the button once\nTo delete press twice`,
    whisper_thank_you_color: [194, 251, 255],

    whisper_sent_text: `Zolang hun namen genoemd worden is niemand vergeten\nDankjewel voor je bijdrage!\n\n\nAs long as their names are named they will not be forgotten\nThank you for your contribution!`,
    whisper_sent_color: [142, 245, 243],

    retry_prompt_text: `Heb respect\nAlsjeblieft alleen de naam van een overledene influisteren in de microfoon\n\n\n\nBe respectful\nPlease only whisper the name of a deceased person into the mic`,
    retry_prompt_color: [255, 255, 0],

    no_whisper_detected_text: `Zachtjes fluisteren alsjeblieft\nDoe het nog eens\n\n\nPlease whisper the name softly into the mic again`,
    no_whisper_color: [255, 0, 0]
  }
};

export const settingsService = {
  getSettings: async () => {
    if (!isMockMode && db) {
      try {
        const querySnapshot = await getDocs(collection(db, "settings"));
        let docData = null;
        querySnapshot.forEach((doc) => {
          if (doc.id === "global") {
            docData = doc.data();
          }
        });
        if (docData) return docData;
      } catch (e) {
        console.error("Firestore settings load error:", e);
      }
    }

    const local = localStorage.getItem("fluisterwolk_settings_v3");
    if (local) {
      try {
        return JSON.parse(local);
      } catch (e) {
        console.error(e);
      }
    }
    return DEFAULT_SETTINGS;
  },

  saveSettings: async (settingsData) => {
    if (!isMockMode && db) {
      try {
        await setDoc(doc(db, "settings", "global"), settingsData);
        console.log("Firestore settings saved.");
      } catch (e) {
        console.error("Firestore settings save error:", e);
      }
    }
    localStorage.setItem("fluisterwolk_settings_v3", JSON.stringify(settingsData));
    return true;
  }
};

export { isMockMode };
