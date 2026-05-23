import React, { useState, useEffect, useRef } from "react";
import AdminPanel from "./components/AdminPanel";
import { dbService, storageService, settingsService, DEFAULT_SETTINGS } from "./firebase";
import { Shield, AlertTriangle } from "lucide-react";
import "./App.css";

// Web Speech API
// Web Speech API
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

// DSP & Encoding helper functions
function getVoicingPeriodicity(timeArray, sampleRate) {
  const n = timeArray.length;
  const samples = new Float32Array(n);
  
  // 1. High-Pass Filter (80Hz cutoff) to remove room rumble, fans, and DC offset
  let prevX = 0;
  let prevY = 0;
  const dt = 1 / sampleRate;
  const rc = 1 / (2 * Math.PI * 80);
  const alpha = rc / (rc + dt);

  for (let i = 0; i < n; i++) {
    const x = (timeArray[i] - 128) / 128;
    samples[i] = alpha * (prevY + x - prevX);
    prevX = x;
    prevY = samples[i];
  }

  // 2. Remove mean
  let mean = 0;
  for (let i = 0; i < n; i++) {
    mean += samples[i];
  }
  mean /= n;
  for (let i = 0; i < n; i++) {
    samples[i] -= mean;
  }

  const checkLength = 512;
  let energy0 = 0;
  for (let i = 0; i < checkLength; i++) {
    energy0 += samples[i] * samples[i];
  }
  if (energy0 < 1e-6) return 0;

  const minLag = Math.round(sampleRate / 350);
  const maxLag = Math.round(sampleRate / 80);

  let maxR = 0;
  
  for (let lag = minLag; lag <= maxLag; lag += 2) {
    if (lag + checkLength > n) break;
    
    let dotProduct = 0;
    let energyLag = 0;
    for (let i = 0; i < checkLength; i++) {
      const s0 = samples[i];
      const s1 = samples[i + lag];
      dotProduct += s0 * s1;
      energyLag += s1 * s1;
    }
    
    if (energyLag > 1e-6) {
      const r = dotProduct / Math.sqrt(energy0 * energyLag);
      if (r > maxR) {
        maxR = r;
      }
    }
  }
  
  return maxR;
}

async function processAudioBlob(blob, minDuration) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const audioContext = new AudioCtx();
  const arrayBuffer = await blob.arrayBuffer();
  
  let audioBuffer;
  try {
    audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
  } catch (err) {
    audioContext.close();
    throw err;
  }
  
  audioContext.close();
  
  const channelData = audioBuffer.getChannelData(0);
  const sourceSampleRate = audioBuffer.sampleRate;
  
  // 1. Silence trimming (amplitude threshold 0.015)
  let startIndex = 0;
  while (startIndex < channelData.length && Math.abs(channelData[startIndex]) < 0.015) {
    startIndex++;
  }
  
  let endIndex = channelData.length - 1;
  while (endIndex > startIndex && Math.abs(channelData[endIndex]) < 0.015) {
    endIndex--;
  }
  
  if (startIndex >= endIndex) {
    startIndex = 0;
    endIndex = channelData.length - 1;
  }
  
  const trimmedDuration = (endIndex - startIndex) / sourceSampleRate;
  if (trimmedDuration < minDuration) {
    return { tooShort: true };
  }
  
  // 2. Downsample to 16kHz Mono
  const targetSampleRate = 16000;
  const scale = sourceSampleRate / targetSampleRate;
  const trimmedLength = endIndex - startIndex + 1;
  const targetLength = Math.round(trimmedLength / scale);
  const downsampledData = new Float32Array(targetLength);
  
  for (let i = 0; i < targetLength; i++) {
    const sourceIndex = startIndex + i * scale;
    const indexLow = Math.floor(sourceIndex);
    const indexHigh = Math.min(endIndex, indexLow + 1);
    const weight = sourceIndex - indexLow;
    downsampledData[i] = (1 - weight) * channelData[indexLow] + weight * channelData[indexHigh];
  }
  
  // 3. Peak Normalization to 0.90
  let maxVal = 0;
  for (let i = 0; i < downsampledData.length; i++) {
    const absVal = Math.abs(downsampledData[i]);
    if (absVal > maxVal) {
      maxVal = absVal;
    }
  }
  
  if (maxVal > 0) {
    const gain = 0.90 / maxVal;
    for (let i = 0; i < downsampledData.length; i++) {
      downsampledData[i] *= gain;
    }
  }
  
  // 4. Encode to 16-bit PCM WAV
  const wavBlob = encodeWAV(downsampledData, targetSampleRate);
  const wavUrl = URL.createObjectURL(wavBlob);
  
  return {
    tooShort: false,
    wavBlob,
    wavUrl,
    duration: trimmedDuration
  };
}

function encodeWAV(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);
  
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  
  return new Blob([view], { type: 'audio/wav' });
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

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
  const [dbError, setDbError] = useState(null);

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
  const collectedRatiosRef = useRef([]);
  const collectedVoicingsRef = useRef([]);
  const collectedLowAvgsRef = useRef([]);
  const collectedHighAvgsRef = useRef([]);
  const animationFrameRef = useRef(null);
  const recognitionRef = useRef(null);
  const autoStopTimerRef = useRef(null);

  // Background audio loops refs
  const playingBackgroundAudiosRef = useRef([]);
  const backgroundPlayTimerRef = useRef(null);
  const confirmationLoopRef = useRef(null);
  const recentPlayedIdsRef = useRef([]);

  // Press control timing
  const isHoldingRef = useRef(false);
  const clickCountRef = useRef(0);
  const firstClickTimeRef = useRef(0);
  const stopRequestedRef = useRef(false);
  const recordingStartTimeRef = useRef(null);
  const ignoreOnStopRef = useRef(false);

  const loadDynamicSettings = async () => {
    try {
      const liveSettings = await settingsService.getSettings();
      setSettings(liveSettings);
    } catch (e) {
      console.error("Failed to load settings:", e);
    }
  };

  // 1. Subscribe to whispers in real time on mount
  useEffect(() => {
    const unsubscribeWhispers = dbService.subscribeWhispers(
      (data) => {
        const sorted = [...data].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        setWhispers(sorted);
        setDbError(null);
      },
      (err) => {
        console.error("Failed to load whispers in real-time:", err);
        setDbError("Verbindingsfout database. Offline modus actief.");
      }
    );

    loadDynamicSettings();

    return () => {
      if (unsubscribeWhispers) unsubscribeWhispers();
      stopBackgroundWhispers();
      stopConfirmationLoop();
      cleanupMedia();
    };
  }, []);

  const fetchWhispers = async () => {
    // Deprecated: real-time subscription handles this automatically
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
    if (whispers.length === 0 || stateRef.current !== "IDLE" || showAdmin) return;

    try {
      const maxHistory = Math.min(Math.max(3, Math.floor(whispers.length * 0.4)), Math.max(0, whispers.length - 1));
      
      let availableWhispers = whispers.filter(w => !recentPlayedIdsRef.current.includes(w.id));
      if (availableWhispers.length === 0) {
        availableWhispers = whispers;
        recentPlayedIdsRef.current = [];
      }

      const randomIndex = Math.floor(Math.random() * availableWhispers.length);
      const whisper = availableWhispers[randomIndex];
      
      recentPlayedIdsRef.current.push(whisper.id);
      if (recentPlayedIdsRef.current.length > maxHistory) {
        recentPlayedIdsRef.current.shift();
      }
      
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

  // 3. Audio Confirmation Loop playback (loops seamlessly)
  const startConfirmationLoop = (url) => {
    stopConfirmationLoop();
    
    const audio = new Audio(url);
    audio.volume = 0.85;
    audio.loop = true;
    
    confirmationLoopRef.current = { intervalId: null, audio: audio };

    const play = () => {
      if (stateRef.current !== "CONFIRMATION") {
        stopConfirmationLoop();
        return;
      }
      audio.play().catch(e => console.log("Confirm loop play blocked:", e));
    };

    play();
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

  // 5. Audio Analyser Loop (RMS & Frequency Spectral Ratio)
  const runAudioAnalyser = () => {
    if (!analyserRef.current) return;
    
    // Time domain for RMS
    const timeArray = new Uint8Array(analyserRef.current.fftSize);
    analyserRef.current.getByteTimeDomainData(timeArray);

    let sum = 0;
    for (let i = 0; i < timeArray.length; i++) {
      const val = (timeArray[i] - 128) / 128;
      sum += val * val;
    }
    const rms = Math.sqrt(sum / timeArray.length);
    collectedRmsRef.current.push(rms);

    const sampleRate = audioContextRef.current?.sampleRate || 44100;
    const voicing = getVoicingPeriodicity(timeArray, sampleRate);
    collectedVoicingsRef.current.push(voicing);

    // Frequency domain for Spectral Ratio
    const freqArray = new Uint8Array(analyserRef.current.frequencyBinCount);
    analyserRef.current.getByteFrequencyData(freqArray);

    const binResolution = sampleRate / analyserRef.current.fftSize;

    // Frequencies: Low: 80Hz - 400Hz, High: 600Hz - 4000Hz
    const lowBinStart = Math.max(1, Math.round(80 / binResolution));
    const lowBinEnd = Math.round(400 / binResolution);
    const highBinStart = Math.round(600 / binResolution);
    const highBinEnd = Math.round(4000 / binResolution);

    let lowSum = 0;
    let lowCount = 0;
    for (let i = lowBinStart; i <= lowBinEnd && i < freqArray.length; i++) {
      lowSum += freqArray[i];
      lowCount++;
    }
    const lowAvg = lowCount > 0 ? (lowSum / lowCount) : 0;

    let highSum = 0;
    let highCount = 0;
    for (let i = highBinStart; i <= highBinEnd && i < freqArray.length; i++) {
      highSum += freqArray[i];
      highCount++;
    }
    const highAvg = highCount > 0 ? (highSum / highCount) : 0;

    const ratio = highAvg / (lowAvg + 0.001);
    collectedRatiosRef.current.push(ratio);
    collectedLowAvgsRef.current.push(lowAvg);
    collectedHighAvgsRef.current.push(highAvg);

    animationFrameRef.current = requestAnimationFrame(runAudioAnalyser);
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
    stopRequestedRef.current = false;
    
    stopBackgroundWhispers();
    setTranscription("");
    setRecordedUrl(null);
    setRecordedBlob(null);
    audioChunksRef.current = [];
    collectedRmsRef.current = [];
    collectedRatiosRef.current = [];
    collectedVoicingsRef.current = [];
    collectedLowAvgsRef.current = [];
    collectedHighAvgsRef.current = [];
    recordingStartTimeRef.current = null;
    ignoreOnStopRef.current = false;

    setState("RECORDING");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      if (stopRequestedRef.current) {
        console.log("Stop requested during getUserMedia. Aborting.");
        stream.getTracks().forEach(t => t.stop());
        setState("IDLE");
        return;
      }
      
      streamRef.current = stream;

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const audioContext = new AudioCtx();
      audioContextRef.current = audioContext;

      if (stopRequestedRef.current) {
        console.log("Stop requested before analyzer. Aborting.");
        setState("IDLE");
        cleanupMedia();
        return;
      }

      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048; // Upgraded from 1024 for highly precise voicing detection
      source.connect(analyser);
      analyserRef.current = analyser;

      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        if (ignoreOnStopRef.current) {
          console.log("onstop: ignoring since ignoreOnStopRef is true");
          return;
        }
        const rawBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        try {
          const minDur = settings.calibration?.min_record_duration !== undefined
            ? parseFloat(settings.calibration.min_record_duration)
            : 0.6;
          const result = await processAudioBlob(rawBlob, minDur);
          if (result.tooShort) {
            console.log("Recording too short in onstop. Auto returning to IDLE state.");
            setState("IDLE");
            return;
          }
          setRecordedBlob(result.wavBlob);
          setRecordedUrl(result.wavUrl);
          processAudioResults(result.wavBlob, result.wavUrl);
        } catch (err) {
          console.error("Error processing audio blob:", err);
          const fallbackUrl = URL.createObjectURL(rawBlob);
          setRecordedBlob(rawBlob);
          setRecordedUrl(fallbackUrl);
          processAudioResults(rawBlob, fallbackUrl);
        }
      };

      if (stopRequestedRef.current) {
        console.log("Stop requested just before start. Aborting.");
        setState("IDLE");
        cleanupMedia();
        return;
      }

      mediaRecorder.start();
      recordingStartTimeRef.current = Date.now();
      runAudioAnalyser();

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
    stopRequestedRef.current = true;

    const minDur = settings.calibration?.min_record_duration !== undefined
      ? parseFloat(settings.calibration.min_record_duration)
      : 0.6;
    const duration = recordingStartTimeRef.current ? (Date.now() - recordingStartTimeRef.current) / 1000 : 0;

    if (duration < minDur || !recordingStartTimeRef.current) {
      console.log(`Recording too short (${duration.toFixed(2)}s < ${minDur}s). Reverting to IDLE directly.`);
      ignoreOnStopRef.current = true;
      setState("IDLE");
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
        try {
          mediaRecorderRef.current.stop();
        } catch (e) {}
      }
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch (e) {}
      }
      cleanupMedia();
      return;
    }

    if (!mediaRecorderRef.current) {
      console.log("Stop requested during initialization. Reverting to IDLE.");
      setState("IDLE");
      cleanupMedia();
      return;
    }

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
    const rmsList = collectedRmsRef.current;
    const lowAvgs = collectedLowAvgsRef.current;
    const highAvgs = collectedHighAvgsRef.current;
    const voicingsList = collectedVoicingsRef.current;

    // Trim first and last frames to discard button press/release mechanical transients/handling noise
    const trimCount = 15;
    let slicedRms = rmsList;
    let slicedLowAvgs = lowAvgs;
    let slicedHighAvgs = highAvgs;
    let slicedVoicings = voicingsList;

    if (rmsList.length > trimCount * 2 + 10) {
      slicedRms = rmsList.slice(trimCount, rmsList.length - trimCount);
      slicedLowAvgs = lowAvgs.slice(trimCount, lowAvgs.length - trimCount);
      slicedHighAvgs = highAvgs.slice(trimCount, highAvgs.length - trimCount);
      slicedVoicings = voicingsList.slice(trimCount, voicingsList.length - trimCount);
    } else if (rmsList.length > 10) {
      const dynamicTrim = Math.floor(rmsList.length * 0.25);
      slicedRms = rmsList.slice(dynamicTrim, rmsList.length - dynamicTrim);
      slicedLowAvgs = lowAvgs.slice(dynamicTrim, lowAvgs.length - dynamicTrim);
      slicedHighAvgs = highAvgs.slice(dynamicTrim, highAvgs.length - dynamicTrim);
      slicedVoicings = voicingsList.slice(dynamicTrim, voicingsList.length - dynamicTrim);
    }

    const SILENCE_THRESHOLD = settings.calibration?.silence_threshold !== undefined
      ? parseFloat(settings.calibration.silence_threshold)
      : 0.005;

    const WHISPER_RATIO_THRESHOLD = settings.calibration?.whisper_ratio_threshold !== undefined
      ? parseFloat(settings.calibration.whisper_ratio_threshold)
      : 1.8;

    const VOICING_THRESHOLD = settings.calibration?.voicing_threshold !== undefined
      ? parseFloat(settings.calibration.voicing_threshold)
      : 0.30;

    // Use a fixed minimal baseline for noise floor to prevent self-canceling whispers
    const fixedNoiseFloor = 5.0;

    // Process active frames
    let activeRmsSum = 0;
    let activeVoicingSum = 0;
    let activeRatioSum = 0;
    let activeFrameCount = 0;

    for (let i = 0; i < slicedRms.length; i++) {
      const rms = slicedRms[i];
      if (rms >= SILENCE_THRESHOLD) {
        activeRmsSum += rms;
        activeVoicingSum += slicedVoicings[i] || 0;

        const lowSignal = Math.max(0.01, (slicedLowAvgs[i] || 0) - fixedNoiseFloor);
        const highSignal = Math.max(0.01, (slicedHighAvgs[i] || 0) - fixedNoiseFloor);
        const activeRatio = highSignal / lowSignal;
        activeRatioSum += activeRatio;
        
        activeFrameCount++;
      }
    }

    const avgRms = slicedRms.reduce((a, b) => a + b, 0) / (slicedRms.length || 1);
    const avgVoicing = activeFrameCount > 0 ? (activeVoicingSum / activeFrameCount) : 0;
    const avgActiveRatio = activeFrameCount > 0 ? (activeRatioSum / activeFrameCount) : 1.0;

    const isSilence = avgRms < SILENCE_THRESHOLD;
    const isVoiced = !isSilence && avgVoicing >= VOICING_THRESHOLD;
    const isWhispered = !isSilence && !isVoiced && avgActiveRatio >= WHISPER_RATIO_THRESHOLD;

    let classification = "other";
    if (isSilence) classification = "silence";
    else if (isVoiced) classification = "talk";
    else if (isWhispered) classification = "whisper";

    console.log(`=================== MAIN APP OPNAME RESULTAAT ===================
Totale frames: ${rmsList.length} -> Sliced frames: ${slicedRms.length}
Silence Threshold: ${SILENCE_THRESHOLD} | Avg RMS: ${avgRms.toFixed(5)}
Ratio Threshold: ${WHISPER_RATIO_THRESHOLD} | Avg Active Ratio: ${avgActiveRatio.toFixed(3)}
Voicing Threshold: ${VOICING_THRESHOLD} | Avg Voicing: ${avgVoicing.toFixed(3)}
Is Silence: ${isSilence} | Is Voiced: ${isVoiced} | Is Whisper: ${isWhispered}
Resultaat: ${classification}
===========================================================`);

    console.log("Raw RMS List:", rmsList);
    console.log("Raw Ratio List:", highAvgs.map((h, i) => Math.max(0.01, h - fixedNoiseFloor) / Math.max(0.01, lowAvgs[i] - fixedNoiseFloor)));
    console.log("Raw Voicing List:", voicingsList);
    console.log("Sliced RMS List:", slicedRms);
    console.log("Sliced Ratio List:", slicedHighAvgs.map((h, i) => Math.max(0.01, h - fixedNoiseFloor) / Math.max(0.01, slicedLowAvgs[i] - fixedNoiseFloor)));
    console.log("Sliced Voicing List:", slicedVoicings);

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
      const fileName = `whisper_${Date.now()}.wav`;
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

      const savedId = await dbService.addWhisper(newEntry);
      const entryWithId = { id: savedId, ...newEntry };
      
      // Update local cache
      setWhispers(prev => [entryWithId, ...prev]);

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
        <div style={{ position: "absolute", top: "24px", right: "24px", display: "flex", alignItems: "center", gap: "10px", zIndex: 30 }}>
          {dbError && (
            <div 
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                backgroundColor: "rgba(245, 158, 11, 0.15)",
                border: "1px solid rgba(245, 158, 11, 0.3)",
                borderRadius: "12px",
                padding: "4px 10px",
                fontSize: "10px",
                color: "#f59e0b",
                fontFamily: "Outfit, sans-serif"
              }}
              title={dbError}
            >
              <AlertTriangle size={10} />
              <span>Offline Modus</span>
            </div>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              window.location.hash = "#/admin";
            }}
            style={{
              background: "none",
              border: "none",
              color: dbError ? "rgba(245, 158, 11, 0.4)" : "rgba(255, 255, 255, 0.2)",
              cursor: "pointer",
              transition: "color 0.2s ease",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 0
            }}
            onMouseEnter={(e) => e.target.style.color = dbError ? "rgba(245, 158, 11, 0.8)" : "rgba(255, 255, 255, 0.6)"}
            onMouseLeave={(e) => e.target.style.color = dbError ? "rgba(245, 158, 11, 0.4)" : "rgba(255, 255, 255, 0.2)"}
            title="Admin Paneel"
          >
            <Shield size={18} />
          </button>
        </div>
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
