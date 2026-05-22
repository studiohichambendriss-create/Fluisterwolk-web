import React, { useState, useEffect, useRef } from "react";
import AdminPanel from "./components/AdminPanel";
import { dbService, storageService, settingsService, DEFAULT_SETTINGS } from "./firebase";
import { Shield } from "lucide-react";
import "./App.css";

// Web Speech API
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

// Auto-scaling centered text component (Mirrors Pygame's auto-font binary search layout)
const AutoScalingText = ({ text, color }) => {
  const [fontSize, setFontSize] = useState(32);

  useEffect(() => {
    if (!text) return;

    const handleResize = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const marginRatio = 0.12; // 12% margin
      const availableWidth = width * (1 - marginRatio * 2);
      const availableHeight = height * (1 - marginRatio * 2);

      const lines = text.split("\n");
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");

      const fits = (size) => {
        ctx.font = `${size}px 'Outfit', sans-serif`;
        // Check line widths
        for (const line of lines) {
          const metrics = ctx.measureText(line);
          if (metrics.width > availableWidth) return false;
        }
        // Estimate total height (line height factor 1.45)
        const lineHeight = size * 1.45;
        const totalHeight = lines.length * lineHeight;
        return totalHeight <= availableHeight;
      };

      let low = 14;
      let high = 150; // Maximum bounds
      let best = 14;

      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (fits(mid)) {
          best = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      setFontSize(best);
    };

    window.addEventListener("resize", handleResize);
    handleResize();

    return () => window.removeEventListener("resize", handleResize);
  }, [text]);

  const rgb = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;

  return (
    <div
      style={{
        color: rgb,
        fontSize: `${fontSize}px`,
        lineHeight: "1.45",
        textAlign: "center",
        whiteSpace: "pre-wrap",
        fontFamily: "'Outfit', sans-serif",
        fontWeight: "400",
        maxWidth: "85vw",
        wordBreak: "break-word",
        userSelect: "none",
        transition: "color 0.4s ease"
      }}
    >
      {text}
    </div>
  );
};

function App() {
  const [state, setState] = useState("IDLE"); // IDLE | RECORDING | CHECKING | CONFIRMATION | TOO_LOUD | RETRY | SUCCESS
  const stateRef = useRef(state);
  
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [whispers, setWhispers] = useState([]);
  const [showAdmin, setShowAdmin] = useState(window.location.hash === "#/admin");
  const [transcription, setTranscription] = useState("");

  useEffect(() => {
    const handleHashChange = () => {
      setShowAdmin(window.location.hash === "#/admin");
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);
  const [recordedUrl, setRecordedUrl] = useState(null);
  const [recordedBlob, setRecordedBlob] = useState(null);

  // Audio refs
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const streamRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const collectedRmsRef = useRef([]);
  const animationFrameRef = useRef(null);
  const recognitionRef = useRef(null);
  const autoStopTimerRef = useRef(null);

  // Background audio loops refs
  const playingBackgroundAudiosRef = useRef([]);
  const backgroundPlayTimerRef = useRef(null);
  const confirmationLoopRef = useRef(null);

  // Press control timing
  const isHoldingRef = useRef(false);
  const clickCountRef = useRef(0);
  const firstClickTimeRef = useRef(0);

  const loadDynamicSettings = async () => {
    try {
      const liveSettings = await settingsService.getSettings();
      setSettings(liveSettings);
    } catch (e) {
      console.error("Failed to load settings:", e);
    }
  };

  // 1. Fetch whispers from DB on mount
  useEffect(() => {
    fetchWhispers();
    loadDynamicSettings();
    return () => {
      stopBackgroundWhispers();
      stopConfirmationLoop();
      cleanupMedia();
    };
  }, []);

  const fetchWhispers = async () => {
    try {
      const data = await dbService.getWhispers();
      setWhispers(data);
    } catch (e) {
      console.error("Failed to load whispers:", e);
    }
  };

  // 2. Background playback of random whispers (When IDLE)
  useEffect(() => {
    if (state === "IDLE" && whispers.length > 0 && !showAdmin) {
      scheduleNextBackgroundWhisper();
    } else {
      stopBackgroundWhispers();
    }
    return () => stopBackgroundWhispers();
  }, [state, whispers, showAdmin]);

  const scheduleNextBackgroundWhisper = () => {
    const minWait = (parseFloat(settings.calibration?.bg_whisper_min_wait) || 0.5) * 1000;
    const maxWait = (parseFloat(settings.calibration?.bg_whisper_max_wait) || 3.0) * 1000;
    const interval = Math.random() * (maxWait - minWait) + minWait;
    
    backgroundPlayTimerRef.current = setTimeout(() => {
      playRandomWhisper();
    }, interval);
  };

  const playRandomWhisper = () => {
    if (whispers.length === 0 || state !== "IDLE" || showAdmin) return;

    try {
      const randomIndex = Math.floor(Math.random() * whispers.length);
      const whisper = whispers[randomIndex];
      
      const audio = new Audio(whisper.audioUrl);
      audio.volume = 0.55; // Soft volume for whispering
      playingBackgroundAudiosRef.current.push(audio);

      audio.play().catch(e => {
        console.log("Audio playback blocked/interrupted by browser:", e);
      });

      audio.onended = () => {
        playingBackgroundAudiosRef.current = playingBackgroundAudiosRef.current.filter(a => a !== audio);
      };

      scheduleNextBackgroundWhisper();
    } catch (err) {
      console.error("Error in background whisper play:", err);
      scheduleNextBackgroundWhisper();
    }
  };

  const stopBackgroundWhispers = () => {
    if (backgroundPlayTimerRef.current) {
      clearTimeout(backgroundPlayTimerRef.current);
      backgroundPlayTimerRef.current = null;
    }
    playingBackgroundAudiosRef.current.forEach(audio => {
      try {
        audio.pause();
      } catch (e) {}
    });
    playingBackgroundAudiosRef.current = [];
  };

  // 3. Audio Confirmation Loop playback (loops every 3 seconds)
  const startConfirmationLoop = (url) => {
    stopConfirmationLoop();
    
    const loopObj = { intervalId: null, audio: null };
    confirmationLoopRef.current = loopObj;

    const play = () => {
      if (stateRef.current !== "CONFIRMATION") {
        stopConfirmationLoop();
        return;
      }
      
      try {
        if (loopObj.audio) {
          loopObj.audio.pause();
        }
        const audio = new Audio(url);
        audio.volume = 0.85;
        loopObj.audio = audio;
        audio.play().catch(e => console.log("Confirm loop play blocked:", e));
      } catch (err) {
        console.error("Error playing whisper loop:", err);
      }
    };

    play();
    loopObj.intervalId = setInterval(play, 3000);
  };

  const stopConfirmationLoop = () => {
    if (confirmationLoopRef.current) {
      if (confirmationLoopRef.current.intervalId) {
        clearInterval(confirmationLoopRef.current.intervalId);
      }
      if (confirmationLoopRef.current.audio) {
        try {
          confirmationLoopRef.current.audio.pause();
        } catch (e) {}
      }
      confirmationLoopRef.current = null;
    }
  };

  // 4. Setup Speech Recognition
  const initSpeechRecognition = () => {
    if (!SpeechRecognition) return null;
    const rec = new SpeechRecognition();
    rec.continuous = false;
    rec.interimResults = false;
    rec.lang = "nl-NL"; // Same as pygame nl config

    rec.onresult = (event) => {
      const text = event.results[0][0].transcript;
      console.log("Web Speech API Recognized:", text);
      setTranscription(text);
    };

    rec.onerror = (e) => {
      console.error("Speech Recognition Error:", e);
    };

    return rec;
  };

  // 5. Volume Analyser Loop (RMS)
  const runRmsAnalyser = () => {
    if (!analyserRef.current) return;
    const array = new Uint8Array(analyserRef.current.fftSize);
    analyserRef.current.getByteTimeDomainData(array);

    let sum = 0;
    for (let i = 0; i < array.length; i++) {
      const val = (array[i] - 128) / 128;
      sum += val * val;
    }
    const rms = Math.sqrt(sum / array.length);
    collectedRmsRef.current.push(rms);

    animationFrameRef.current = requestAnimationFrame(runRmsAnalyser);
  };

  // 6. Media and Recording Cleanup
  const cleanupMedia = () => {
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
  };

  // 7. Core State Transitions
  const startRecording = async () => {
    if (isHoldingRef.current) return;
    isHoldingRef.current = true;
    
    stopBackgroundWhispers();
    setTranscription("");
    setRecordedUrl(null);
    setRecordedBlob(null);
    audioChunksRef.current = [];
    collectedRmsRef.current = [];

    setState("RECORDING");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const audioContext = new AudioCtx();
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;

      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        const url = URL.createObjectURL(blob);
        setRecordedBlob(blob);
        setRecordedUrl(url);
        processAudioResults(blob, url);
      };

      mediaRecorder.start();
      runRmsAnalyser();

      // Start Web Speech API
      const rec = initSpeechRecognition();
      if (rec) {
        recognitionRef.current = rec;
        rec.start();
      }

      // Auto-stop recording if it exceeds max duration from calibration settings
      const maxRecordMs = (parseFloat(settings.calibration?.max_record_duration) || 3.0) * 1000;
      autoStopTimerRef.current = setTimeout(() => {
        stopRecording();
      }, maxRecordMs);

    } catch (err) {
      console.error("Microphone Access Blocked:", err);
      setState("IDLE");
      isHoldingRef.current = false;
    }
  };

  const stopRecording = () => {
    // Clear auto-stop timer
    if (autoStopTimerRef.current) {
      clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }

    if (!isHoldingRef.current && stateRef.current !== "RECORDING") return;
    isHoldingRef.current = false;

    setState("CHECKING");

    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (e) {}
    }
    cleanupMedia();
  };

  const processAudioResults = (blob, url) => {
    // Process RMS
    const rmsList = collectedRmsRef.current;
    const avgRms = rmsList.reduce((a, b) => a + b, 0) / (rmsList.length || 1);
    
    // Dynamic threshold match
    const WHISPER_THRESHOLD = settings.calibration?.whisper_threshold_value !== undefined
      ? parseFloat(settings.calibration.whisper_threshold_value)
      : 0.038;
    const isWhispered = avgRms < WHISPER_THRESHOLD;

    console.log("Audio Processing. Avg RMS:", avgRms, "Threshold:", WHISPER_THRESHOLD, "Is Whisper:", isWhispered);

    const noWhisperTimeoutMs = (parseFloat(settings.calibration?.no_whisper_timeout) || 3.0) * 1000;

    setTimeout(() => {
      if (isWhispered) {
        setState("CONFIRMATION");
        startConfirmationLoop(url);
      } else {
        setState("TOO_LOUD");
        setTimeout(() => {
          setState("IDLE");
        }, noWhisperTimeoutMs);
      }
    }, 1000);
  };

  // Confirmation Decision handlers (Single vs Double Press)
  const registerButtonPress = () => {
    if (state !== "CONFIRMATION") return;

    const now = Date.now();
    if (clickCountRef.current === 0) {
      clickCountRef.current = 1;
      firstClickTimeRef.current = now;
      
      // Wait 1 second to confirm if there is a second tap (Double press)
      setTimeout(() => {
        if (clickCountRef.current === 1) {
          // Confirmed Single Press -> SAVE
          clickCountRef.current = 0;
          confirmSaveWhisper();
        }
      }, 1000);
    } else if (clickCountRef.current === 1) {
      if (now - firstClickTimeRef.current < 1000) {
        // Confirmed Double Press -> DISCARD/RETRY
        clickCountRef.current = 0;
        confirmDiscardWhisper();
      }
    }
  };

  const confirmSaveWhisper = async () => {
    stopConfirmationLoop();
    setState("SUCCESS");

    // Start timer immediately so UI does not hang if upload blocks/fails
    const successDurationMs = (parseFloat(settings.calibration?.success_screen_duration) || 2.0) * 1000;
    setTimeout(() => {
      setState("IDLE");
    }, successDurationMs);

    try {
      const fileName = `whisper_${Date.now()}.webm`;
      const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);

      // 1. Upload audio to Firebase Storage
      const audioUrl = await storageService.uploadAudio(recordedBlob, fileName);

      // 2. Upload metadata to Firestore
      const newEntry = {
        filename: fileName,
        transcription: transcription.trim() || "Onbekende Naam",
        confidence: 95.0,
        speechType: "whisper",
        timestamp: timestamp,
        audioUrl: audioUrl
      };

      await dbService.addWhisper(newEntry);
      
      // Update local cache
      setWhispers(prev => [...prev, newEntry]);

    } catch (e) {
      console.error("Save error:", e);
    }
  };

  const confirmDiscardWhisper = () => {
    stopConfirmationLoop();
    setState("RETRY");

    setTimeout(() => {
      setState("IDLE");
    }, 2000); // Display retry screen for 2 seconds
  };

  // Keyboard and Global Mouse/Touch Event triggers
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (showAdmin) return;
      
      if (e.key === " ") {
        e.preventDefault();
        if (state === "IDLE") {
          startRecording();
        } else if (state === "CONFIRMATION") {
          registerButtonPress();
        }
      } else if (e.key === "Tab") {
        e.preventDefault();
        window.location.hash = "#/admin";
      }
    };

    const handleKeyUp = (e) => {
      if (e.key === " " && state === "RECORDING") {
        e.preventDefault();
        stopRecording();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [state, showAdmin, recordedBlob, whispers, transcription]);

  // Touch triggers for mobile view holding/clicking
  const handleTouchStart = (e) => {
    if (showAdmin) return;
    if (e.target.closest("button")) return; // Don't block admin gear clicks

    if (state === "IDLE") {
      startRecording();
    } else if (state === "CONFIRMATION") {
      registerButtonPress();
    }
  };

  const handleTouchEnd = () => {
    if (state === "RECORDING") {
      stopRecording();
    }
  };

  // Render content according to current installation state
  const renderStateContent = () => {
    const txt = {
      ...DEFAULT_SETTINGS.texts,
      ...(settings?.texts || {})
    };
    switch (state) {
      case "IDLE":
        return <AutoScalingText text={txt.initial_message_text} color={txt.initial_message_color} />;
      case "RECORDING":
        return <AutoScalingText text={txt.whisper_prompt_text} color={txt.whisper_prompt_color} />;
      case "CHECKING":
        return <AutoScalingText text={txt.checking_audio_text} color={txt.checking_audio_color} />;
      case "CONFIRMATION":
        return <AutoScalingText text={txt.whisper_thank_you_text} color={txt.whisper_thank_you_color} />;
      case "TOO_LOUD":
        return <AutoScalingText text={txt.no_whisper_detected_text} color={txt.no_whisper_color} />;
      case "RETRY":
        return <AutoScalingText text={txt.retry_prompt_text} color={txt.retry_prompt_color} />;
      case "SUCCESS":
        return <AutoScalingText text={txt.whisper_sent_text} color={txt.whisper_sent_color} />;
      default:
        return null;
    }
  };

  return (
    <div 
      className="app-container"
      onMouseDown={handleTouchStart}
      onMouseUp={handleTouchEnd}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* Centered auto-scaled text element */}
      <div 
        style={{
          zIndex: 10,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "100%",
          height: "100%",
          padding: "5%",
          pointerEvents: "none"
        }}
      >
        {renderStateContent()}
      </div>

      {/* Very subtle background visual breathing indicator */}
      {state === "RECORDING" && <div className="pulsing-bg-orb" />}

      {/* Elegant, tiny unobtrusive gear in top right corner for admin portal */}
      {!showAdmin && state === "IDLE" && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            window.location.hash = "#/admin";
          }}
          style={{
            position: "absolute",
            top: "24px",
            right: "24px",
            background: "none",
            border: "none",
            color: "rgba(255, 255, 255, 0.2)",
            cursor: "pointer",
            zIndex: 30,
            transition: "color 0.2s ease"
          }}
          onMouseEnter={(e) => e.target.style.color = "rgba(255, 255, 255, 0.6)"}
          onMouseLeave={(e) => e.target.style.color = "rgba(255, 255, 255, 0.2)"}
          title="Admin Paneel"
        >
          <Shield size={18} />
        </button>
      )}

      {/* Admin Panel overlay */}
      {showAdmin && (
        <AdminPanel 
          onClose={() => {
            window.location.hash = "#/";
            fetchWhispers(); // Refresh list on exit
            loadDynamicSettings(); // Sync edited texts/calibration settings
          }} 
        />
      )}
    </div>
  );
}

export default App;
