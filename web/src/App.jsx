import React, { useState, useEffect } from "react";
import WhisperCloud from "./components/WhisperCloud";
import Recorder from "./components/Recorder";
import AdminPanel from "./components/AdminPanel";
import { dbService, storageService } from "./firebase";
import { Settings, Shield } from "lucide-react";
import "./App.css";

function App() {
  const [whispers, setWhispers] = useState([]);
  const [showAdmin, setShowAdmin] = useState(false);
  const [isRecordingActive, setIsRecordingActive] = useState(false);
  const [selectedWhisper, setSelectedWhisper] = useState(null);

  // Load whispers list on mount
  useEffect(() => {
    fetchWhispers();
  }, []);

  const fetchWhispers = async () => {
    try {
      const data = await dbService.getWhispers();
      setWhispers(data);
    } catch (e) {
      console.error("Failed to load whispers:", e);
    }
  };

  // Called when a new whisper is successfully recorded
  const handleWhisperSaved = async (newWhisper) => {
    try {
      // 1. Upload audio file to Storage (returns audio download URL)
      const audioUrl = await storageService.uploadAudio(newWhisper.blob, newWhisper.filename);

      // 2. Prepare database entry
      const dbEntry = {
        filename: newWhisper.filename,
        transcription: newWhisper.transcription,
        confidence: newWhisper.confidence,
        speechType: newWhisper.speechType,
        timestamp: newWhisper.timestamp,
        audioUrl: audioUrl
      };

      // 3. Save to Firestore database
      await dbService.addWhisper(dbEntry);

      // 4. Refresh whispers cloud so the new node shows up immediately
      await fetchWhispers();
    } catch (e) {
      console.error("Failed to upload/save whisper:", e);
      throw e; // Propagate to Recorder for error handling
    }
  };

  return (
    <div className="app-container">
      {/* Dynamic light/cream aesthetic backdrop simulation */}
      <div className="app-bg" />

      {/* Main interactive whisper cloud canvas */}
      <WhisperCloud 
        whispers={whispers} 
        onSelectWhisper={setSelectedWhisper}
        isRecording={isRecordingActive}
      />

      {/* Floating recording node overlay */}
      <Recorder 
        onWhisperSaved={handleWhisperSaved} 
        isRecordingActive={isRecordingActive}
        setIsRecordingActive={setIsRecordingActive}
      />

      {/* Admin Panel page router overlay */}
      {showAdmin && (
        <AdminPanel onClose={() => {
          setShowAdmin(false);
          fetchWhispers(); // Refresh list on close in case entries were deleted
        }} />
      )}

      {/* Floating top bar buttons */}
      {!isRecordingActive && (
        <div className="absolute top-8 right-8 flex items-center gap-2 z-30 pointer-events-auto">
          <button
            onClick={() => setShowAdmin(true)}
            className="p-3 glass-panel border rounded-full hover:bg-[rgba(255,255,255,0.9)] hover:scale-105 transition-all text-[rgba(45,43,42,0.8)] shadow-sm flex items-center gap-2"
            title="Admin Paneel"
          >
            <Shield size={16} />
            <span className="text-[11px] uppercase tracking-wider font-medium hidden sm:inline">Beheer</span>
          </button>
        </div>
      )}

      {/* Elegant selected whisper details popover (displays at the bottom left if clicked) */}
      {selectedWhisper && !isRecordingActive && (
        <div 
          className="absolute bottom-8 left-8 glass-panel max-w-[280px] p-5 animate-float pointer-events-auto flex flex-col gap-1 border border-accent-color/30"
          style={{ zIndex: 30 }}
        >
          <span className="text-[10px] text-muted uppercase tracking-wider font-semibold">Geselecteerde fluistering</span>
          <p className="font-serif italic text-lg text-color-primary font-medium">"{selectedWhisper.transcription}"</p>
          <span className="text-[9px] text-muted">{selectedWhisper.timestamp}</span>
          <button 
            onClick={() => setSelectedWhisper(null)}
            className="text-[9px] text-accent-color hover:text-color-primary text-left mt-2 underline"
          >
            Sluiten
          </button>
        </div>
      )}
    </div>
  );
}

export default App;
