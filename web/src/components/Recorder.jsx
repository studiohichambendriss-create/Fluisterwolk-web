import React, { useState, useRef, useEffect } from "react";
import { Mic, Check, X, RefreshCw, VolumeX, AlertTriangle, CheckCircle } from "lucide-react";

// Web Speech API references
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const Recorder = ({ onWhisperSaved, isRecordingActive, setIsRecordingActive }) => {
  const [isRecording, setIsRecording] = useState(false);
  const [rmsValue, setRmsValue] = useState(0);
  const [loudnessLog, setLoudnessLog] = useState([]);
  const [transcription, setTranscription] = useState("");
  const [speechType, setSpeechType] = useState(null); // 'whisper' | 'normal' | null
  const [step, setStep] = useState("idle"); // 'idle' | 'recording' | 'processing' | 'confirm' | 'error'
  const [audioUrl, setAudioUrl] = useState(null);
  const [micError, setMicError] = useState(false);
  const [recognitionActive, setRecognitionActive] = useState(false);

  // Audio nodes refs
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const streamRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const recognitionRef = useRef(null);
  const animationFrameRef = useRef(null);
  const collectedRmsRef = useRef([]);

  // Setup Web Speech Recognition
  useEffect(() => {
    if (!SpeechRecognition) {
      console.warn("Web Speech API is not supported in this browser. Fallback typing mode active.");
      return;
    }

    const rec = new SpeechRecognition();
    rec.continuous = false;
    rec.interimResults = false;
    rec.lang = "nl-NL"; // Default language Dutch, matches original

    rec.onresult = (event) => {
      const text = event.results[0][0].transcript;
      console.log("Speech recognized:", text);
      setTranscription(text);
    };

    rec.onerror = (e) => {
      console.error("Speech Recognition Error:", e);
      if (e.error !== "no-speech") {
        setMicError(true);
      }
    };

    rec.onend = () => {
      setRecognitionActive(false);
    };

    recognitionRef.current = rec;
  }, []);

  // Cleanup helper
  const cleanupRecording = () => {
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
    }
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      audioContextRef.current.close();
    }
  };

  useEffect(() => {
    return cleanupRecording;
  }, []);

  // Real-time volume analyser loop
  const updateVolume = () => {
    if (!analyserRef.current) return;
    const array = new Uint8Array(analyserRef.current.fftSize);
    analyserRef.current.getByteTimeDomainData(array);

    // Calculate RMS (Root Mean Square) volume level
    let sum = 0;
    for (let i = 0; i < array.length; i++) {
      const val = (array[i] - 128) / 128; // Normalize -1 to 1
      sum += val * val;
    }
    const rms = Math.sqrt(sum / array.length);
    setRmsValue(rms);
    collectedRmsRef.current.push(rms);

    animationFrameRef.current = requestAnimationFrame(updateVolume);
  };

  const startRecording = async () => {
    setMicError(false);
    setTranscription("");
    setSpeechType(null);
    setAudioUrl(null);
    audioChunksRef.current = [];
    collectedRmsRef.current = [];
    setIsRecordingActive(true);

    try {
      // 1. Initialize Audio Stream
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // 2. Setup Web Audio RMS Analyzer
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const audioContext = new AudioCtx();
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;

      // 3. Setup Media Recorder (to save audio file)
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        const url = URL.createObjectURL(audioBlob);
        setAudioUrl(url);
        processRecording(audioBlob);
      };

      // Start actual systems
      mediaRecorder.start();
      setIsRecording(true);
      setStep("recording");
      updateVolume();

      // 4. Start Web Speech Recognition
      if (recognitionRef.current) {
        setRecognitionActive(true);
        recognitionRef.current.start();
      }
    } catch (err) {
      console.error("Microphone access denied or error:", err);
      setMicError(true);
      setStep("error");
      setIsRecordingActive(false);
    }
  };

  const stopRecording = () => {
    if (!isRecording) return;
    setIsRecording(false);
    setStep("processing");

    // Stop Media Recorder & Mic stream
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    
    if (recognitionRef.current && recognitionActive) {
      recognitionRef.current.stop();
    }

    cleanupRecording();
  };

  const processRecording = async (blob) => {
    // Math to evaluate whisper based on average collected RMS energy
    const rmsList = collectedRmsRef.current;
    const avgRms = rmsList.reduce((a, b) => a + b, 0) / (rmsList.length || 1);
    
    // Threshold Calibration (Lower RMS means softer volume)
    // python whisper_threshold was 0.006 or 0.1 depending on scale
    // In our Web Audio scale, typical normal speech has avgRms > 0.08, whispers are around 0.005 to 0.035
    const WHISPER_THRESHOLD = 0.038; 
    const calculatedConfidence = Math.max(50, 100 - (avgRms / WHISPER_THRESHOLD) * 50);

    console.log(`Audio analysis completed. Average RMS: ${avgRms.toFixed(4)}. Threshold: ${WHISPER_THRESHOLD}`);

    // Set speech type based on loudness threshold
    const isWhispered = avgRms < WHISPER_THRESHOLD;
    setSpeechType(isWhispered ? "whisper" : "normal");

    // Wait a brief second to allow transcription to settle if delayed
    setTimeout(() => {
      setStep("confirm");
    }, 800);
  };

  const saveWhisper = async () => {
    if (!audioUrl) return;
    setStep("uploading");
    
    try {
      // Get the recorded blob
      const audioBlob = await fetch(audioUrl).then(r => r.blob());
      const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
      
      const fileName = `whisper_${Date.now()}.webm`;
      
      // Save
      await onWhisperSaved({
        blob: audioBlob,
        filename: fileName,
        transcription: transcription || "Onbekende Naam", // Fallback if Web Speech API missed it
        confidence: speechType === "whisper" ? 95.0 : 45.0, // Confidence rating
        speechType: speechType,
        timestamp: timestamp
      });

      // Clear states
      setStep("success");
      setTimeout(() => {
        resetRecorder();
      }, 2000);
    } catch (e) {
      console.error(e);
      setStep("error");
    }
  };

  const resetRecorder = () => {
    cleanupRecording();
    setStep("idle");
    setIsRecording(false);
    setTranscription("");
    setSpeechType(null);
    setAudioUrl(null);
    setIsRecordingActive(false);
  };

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center pointer-events-none">
      {/* Visual background overlay when recording is active */}
      {isRecordingActive && (
        <div className="absolute inset-0 bg-white/75 backdrop-blur-md transition-all duration-700 pointer-events-auto" />
      )}

      {/* Main trigger button or Modal window */}
      <div className="z-50 pointer-events-auto flex flex-col items-center">
        {step === "idle" && (
          <button
            onClick={startRecording}
            className="btn-premium py-5 px-9 flex items-center gap-3 animate-breathe hover:scale-105"
            style={{ pointerEvents: "auto" }}
          >
            <Mic size={20} className="text-[rgba(45,43,42,0.8)]" />
            <span>Fluister een naam</span>
          </button>
        )}

        {/* Full recording interface sheet */}
        {step !== "idle" && (
          <div className="glass-panel max-w-md w-[90vw] p-8 text-center flex flex-col items-center gap-6 animate-float">
            {step === "recording" && (
              <>
                <h2 className="title-serif text-2xl text-[rgba(45,43,42,0.85)]">Opname Gestart...</h2>
                <p className="text-sm text-muted">Fluister de naam van uw dierbare in de microfoon.</p>
                
                {/* Voice Volume breathing orb */}
                <div 
                  className="w-24 h-24 rounded-full bg-accent-color/30 flex items-center justify-center transition-all duration-75 relative"
                  style={{ transform: `scale(${1 + rmsValue * 1.5})` }}
                >
                  <div className="w-16 h-16 rounded-full bg-accent-color/60 flex items-center justify-center">
                    <Mic size={24} className="text-white animate-pulse" />
                  </div>
                  {/* Outer pulse boundary */}
                  <div className="absolute inset-0 rounded-full border border-accent-color/30 animate-ping opacity-70" />
                </div>

                <button
                  onClick={stopRecording}
                  className="btn-premium px-8 py-3 bg-[rgba(45,43,42,0.05)] border-red-200/50 hover:bg-red-50"
                >
                  <span>Stop en controleer</span>
                </button>
              </>
            )}

            {step === "processing" && (
              <div className="flex flex-col items-center gap-4 py-6">
                <RefreshCw size={36} className="text-accent-color animate-spin" />
                <h3 className="font-serif italic text-lg text-color-primary">Audio bestanden analyseren...</h3>
              </div>
            )}

            {step === "confirm" && (
              <div className="flex flex-col gap-5 w-full">
                {speechType === "whisper" ? (
                  <div className="flex flex-col items-center gap-2">
                    <CheckCircle size={44} className="text-emerald-500/80" />
                    <h3 className="title-serif text-2xl text-emerald-700/80">Fluistering Gedetecteerd</h3>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-2">
                    <AlertTriangle size={44} className="text-amber-500/80" />
                    <h3 className="title-serif text-2xl text-amber-700/80">Te Luid Gesproken?</h3>
                    <p className="text-xs text-muted max-w-[280px]">
                      Voor de beste ervaring vragen wij u om de naam echt in te <strong>fluisteren</strong>.
                    </p>
                  </div>
                )}

                {/* Sound playback preview */}
                {audioUrl && (
                  <div className="bg-[rgba(45,43,42,0.03)] p-4 rounded-xl border border-[rgba(45,43,42,0.05)] flex flex-col items-center gap-2">
                    <span className="text-xs uppercase tracking-wider text-muted">Luister terug:</span>
                    <audio src={audioUrl} controls className="w-full max-w-[280px] h-8 bg-transparent" />
                  </div>
                )}

                {/* Transcription output box */}
                <div className="flex flex-col gap-1 text-left w-full px-2">
                  <span className="text-xs text-muted font-medium">Gedetecteerde Naam:</span>
                  <div 
                    className="p-3 bg-white border border-[rgba(45,43,42,0.1)] rounded-lg text-color-primary font-serif italic text-lg text-center select-all"
                    contentEditable
                    suppressContentEditableWarning
                    onBlur={(e) => setTranscription(e.target.textContent)}
                  >
                    {transcription || "..."}
                  </div>
                  <span className="text-[10px] text-muted italic text-center">
                    (U kunt de naam hierboven eventueel corrigeren voor de cloud)
                  </span>
                </div>

                <div className="flex justify-center gap-3 mt-2">
                  <button
                    onClick={resetRecorder}
                    className="btn-premium px-5 py-3 flex items-center gap-2 hover:bg-gray-100"
                  >
                    <X size={16} />
                    <span>Opnieuw</span>
                  </button>
                  
                  {speechType === "whisper" ? (
                    <button
                      onClick={saveWhisper}
                      className="btn-premium px-5 py-3 bg-emerald-500/10 border-emerald-500/30 text-emerald-800 hover:bg-emerald-500/20"
                    >
                      <Check size={16} />
                      <span>Verzenden</span>
                    </button>
                  ) : (
                    <button
                      onClick={resetRecorder}
                      className="btn-premium px-5 py-3 border-amber-500/30 text-amber-800 hover:bg-amber-50"
                    >
                      <RefreshCw size={16} />
                      <span>Probeer Zachter</span>
                    </button>
                  )}
                </div>
              </div>
            )}

            {step === "uploading" && (
              <div className="flex flex-col items-center gap-4 py-8">
                <RefreshCw size={32} className="text-accent-color animate-spin" />
                <h3 className="font-serif text-lg text-color-primary">Verzenden naar de fluisterwolk...</h3>
              </div>
            )}

            {step === "success" && (
              <div className="flex flex-col items-center gap-4 py-6">
                <CheckCircle size={48} className="text-emerald-500 animate-bounce" />
                <h3 className="title-serif text-2xl text-emerald-800">Fluistering opgenomen!</h3>
                <p className="text-sm text-muted">Dank u voor uw bijdrage aan de wolk.</p>
              </div>
            )}

            {step === "error" && (
              <div className="flex flex-col items-center gap-4 py-6">
                <AlertTriangle size={48} className="text-red-500" />
                <h3 className="title-serif text-2xl text-red-800">Fout opgetreden</h3>
                <p className="text-sm text-muted">
                  {micError 
                    ? "Kan geen verbinding maken met microfoon. Controleer uw browserinstellingen." 
                    : "Uploaden mislukt. Probeer het later nog eens."}
                </p>
                <button
                  onClick={resetRecorder}
                  className="btn-premium px-6 py-2 mt-2"
                >
                  <span>Sluiten</span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default Recorder;
