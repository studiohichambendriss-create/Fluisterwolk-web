import React, { useState, useEffect, useRef } from "react";
import { authService, dbService, storageService, settingsService, DEFAULT_SETTINGS, isMockMode, checkBadLanguage } from "../firebase";
import { Lock, Mail, Play, Trash2, ArrowLeft, Download, LogOut, CheckCircle, AlertTriangle, ShieldCheck, Sliders, Type, Database, RefreshCw, Undo2 } from "lucide-react";
import { saveSandboxClip, loadSandboxClips, deleteSandboxClip } from "../indexedDB";

// Color Conversions Helper
const rgbToHex = (rgb) => {
  if (!rgb || rgb.length < 3) return "#ffffff";
  const r = Math.min(255, Math.max(0, Math.round(rgb[0]))).toString(16).padStart(2, "0");
  const g = Math.min(255, Math.max(0, Math.round(rgb[1]))).toString(16).padStart(2, "0");
  const b = Math.min(255, Math.max(0, Math.round(rgb[2]))).toString(16).padStart(2, "0");
  return `#${r}${g}${b}`;
};

const hexToRgb = (hex) => {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? [
    parseInt(result[1], 16),
    parseInt(result[2], 16),
    parseInt(result[3], 16)
  ] : [255, 255, 255];
};

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

const AdminPanel = ({ onClose }) => {
  const [user, setUser] = useState(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [activeTab, setActiveTab] = useState("whispers"); // whispers | trash | calibration | texts | firebase

  // Data States
  const [whispers, setWhispers] = useState([]);
  const [deletedWhispers, setDeletedWhispers] = useState([]);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const settingsRef = useRef(settings);
  const saveTimeoutRef = useRef(null);

  useEffect(() => {
    settingsRef.current = settings;
    // Auto-save settings on change, debounced
    if (settings !== DEFAULT_SETTINGS) {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(() => {
        settingsService.saveSettings(settings).catch(e => console.error("Auto-save error:", e));
      }, 1000);
    }
  }, [settings]);

  useEffect(() => {
    loadSandboxClips().then(clips => {
      // Recreate object URLs for loaded blobs
      const loaded = clips.map(c => ({
        ...c,
        url: URL.createObjectURL(c.blob)
      }));
      setSandboxClips(loaded);
      
      // Auto-recalculate optimal thresholds based on loaded clips
      if (loaded.length > 0) {
        setTimeout(() => optimizeThresholds(loaded), 500);
      }
    }).catch(e => console.error("Failed to load sandbox clips:", e));
  }, []);

  const [rawConfigInput, setRawConfigInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [playingId, setPlayingId] = useState(null);
  const [actionMessage, setActionMessage] = useState("");
  const [dbError, setDbError] = useState(null);

  const [liveVolume, setLiveVolume] = useState(0);
  const [liveRatio, setLiveRatio] = useState(0);
  const [liveVoicing, setLiveVoicing] = useState(0);
  const [liveStatus, setLiveStatus] = useState("silence");
  const canvasRef = useRef(null);
  const liveAudioCtxRef = useRef(null);
  const liveAnalyserRef = useRef(null);
  const liveStreamRef = useRef(null);
  const liveAnimFrameRef = useRef(null);
  const lowNoiseFloorRef = useRef(5.0);
  const highNoiseFloorRef = useRef(5.0);

  // Advanced Live Telemetry States
  const [liveLowAvgState, setLiveLowAvgState] = useState(0);
  const [liveHighAvgState, setLiveHighAvgState] = useState(0);
  const [liveLowNoiseState, setLiveLowNoiseState] = useState(5.0);
  const [liveHighNoiseState, setLiveHighNoiseState] = useState(5.0);

  // Manual Calibration States
  const [calibStatus, setCalibStatus] = useState({
    active: false,
    type: "", // silence | whisper | voice
    countdown: 0,
    text: ""
  });
  const calibPhaseRef = useRef("idle");
  const calibSamplesRef = useRef([]);
  const calibIntervalsRef = useRef([]);

  // Sandbox Clip States & Refs
  const [sandboxClips, setSandboxClips] = useState([]);
  const [recordingCategory, setRecordingCategoryState] = useState("");
  const [recordingCountdown, setRecordingCountdown] = useState(0);
  const recordingCategoryRef = useRef("");
  const recordingFramesRef = useRef([]);
  const isPlaybackActiveRef = useRef(false);
  const playbackIntervalRef = useRef(null);
  const playbackAudioRef = useRef(null);

  const setRecordingCategory = (cat) => {
    recordingCategoryRef.current = cat;
    setRecordingCategoryState(cat);
  };

  const clearAllCalibIntervals = () => {
    calibIntervalsRef.current.forEach(timer => clearInterval(timer));
    calibIntervalsRef.current = [];
  };

  // Shared visualizer drawer function
  const drawSpectrogramFrame = (canvas, freqArray, timeArray, rms, lowAvg, highAvg, activeRatio, voicing) => {
    const canvasCtx = canvas.getContext("2d");
    if (!canvasCtx) return;
    const w = canvas.width;
    const h = canvas.height;

    // Draw dark background with rounded corners
    canvasCtx.fillStyle = "rgba(18, 18, 18, 0.95)";
    canvasCtx.fillRect(0, 0, w, h);

    // Subtle vertical background grid lines (every 1000Hz up to 5000Hz)
    canvasCtx.strokeStyle = "rgba(255, 255, 255, 0.03)";
    canvasCtx.lineWidth = 1;
    for (let hz = 1000; hz <= 5000; hz += 1000) {
      const gridX = (hz / 6000) * w;
      canvasCtx.beginPath();
      canvasCtx.moveTo(gridX, 0);
      canvasCtx.lineTo(gridX, h);
      canvasCtx.stroke();
    }

    // Draw low frequency region highlighted (80Hz - 400Hz)
    const xLowStart = (80 / 6000) * w;
    const xLowEnd = (400 / 6000) * w;
    canvasCtx.fillStyle = "rgba(239, 68, 68, 0.08)"; // Coral/Red tint
    canvasCtx.fillRect(xLowStart, 0, xLowEnd - xLowStart, h);

    // Draw high frequency region highlighted (600Hz - 4000Hz)
    const xHighStart = (600 / 6000) * w;
    const xHighEnd = (4000 / 6000) * w;
    canvasCtx.fillStyle = "rgba(16, 185, 129, 0.08)"; // Emerald/Green tint
    canvasCtx.fillRect(xHighStart, 0, xHighEnd - xHighStart, h);

    // Draw noise floor dashed lines in low & high regions
    canvasCtx.setLineDash([4, 4]);
    const yLowNoise = h - ((lowNoiseFloorRef.current || 5) / 255) * (h - 24) - 2;
    canvasCtx.strokeStyle = "rgba(239, 68, 68, 0.4)";
    canvasCtx.lineWidth = 1.5;
    canvasCtx.beginPath();
    canvasCtx.moveTo(xLowStart, yLowNoise);
    canvasCtx.lineTo(xLowEnd, yLowNoise);
    canvasCtx.stroke();

    const yHighNoise = h - ((highNoiseFloorRef.current || 5) / 255) * (h - 24) - 2;
    canvasCtx.strokeStyle = "rgba(16, 185, 129, 0.4)";
    canvasCtx.beginPath();
    canvasCtx.moveTo(xHighStart, yHighNoise);
    canvasCtx.lineTo(xHighEnd, yHighNoise);
    canvasCtx.stroke();
    canvasCtx.setLineDash([]);

    // Dashed borders for low & high regions
    canvasCtx.strokeStyle = "rgba(239, 68, 68, 0.25)";
    canvasCtx.beginPath();
    canvasCtx.moveTo(xLowStart, 0); canvasCtx.lineTo(xLowStart, h);
    canvasCtx.moveTo(xLowEnd, 0); canvasCtx.lineTo(xLowEnd, h);
    canvasCtx.stroke();

    canvasCtx.strokeStyle = "rgba(16, 185, 129, 0.25)";
    canvasCtx.beginPath();
    canvasCtx.moveTo(xHighStart, 0); canvasCtx.lineTo(xHighStart, h);
    canvasCtx.moveTo(xHighEnd, 0); canvasCtx.lineTo(xHighEnd, h);
    canvasCtx.stroke();

    // Draw region text labels at the top
    canvasCtx.font = "bold 9px Outfit, sans-serif";
    canvasCtx.fillStyle = "rgba(239, 68, 68, 0.75)";
    canvasCtx.fillText(`STEM PITCH (80-400Hz) - Ruis: ${Math.round(lowNoiseFloorRef.current)}`, xLowStart + 2, 14);

    canvasCtx.fillStyle = "rgba(16, 185, 129, 0.75)";
    canvasCtx.fillText(`FLUISTER BEREIK (600-4000Hz) - Ruis: ${Math.round(highNoiseFloorRef.current)}`, xHighStart + 4, 14);

    // Plot frequency spectrum path
    const sampleRate = (liveAudioCtxRef.current?.sampleRate || 44100);
    const binResolution = sampleRate / (freqArray.length * 2);
    const gradient = canvasCtx.createLinearGradient(0, h, 0, 0);
    gradient.addColorStop(0, "rgba(99, 102, 241, 0.02)"); 
    gradient.addColorStop(0.5, "rgba(99, 102, 241, 0.12)");
    gradient.addColorStop(1, "rgba(6, 182, 212, 0.45)"); // Neon cyan at peak

    canvasCtx.beginPath();
    canvasCtx.moveTo(0, h);

    for (let x = 0; x <= w; x++) {
      const f = (x / w) * 6000;
      const binFloat = f / binResolution;
      const binLow = Math.floor(binFloat);
      const binHigh = Math.min(freqArray.length - 1, binLow + 1);
      const weight = binFloat - binLow;

      const valLow = freqArray[binLow] || 0;
      const valHigh = freqArray[binHigh] || 0;
      const val = (1 - weight) * valLow + weight * valHigh;

      const y = h - (val / 255) * (h - 24) - 2;
      canvasCtx.lineTo(x, y);
    }
    canvasCtx.lineTo(w, h);
    canvasCtx.closePath();
    canvasCtx.fillStyle = gradient;
    canvasCtx.fill();

    // Draw curve line
    canvasCtx.beginPath();
    for (let x = 0; x <= w; x++) {
      const f = (x / w) * 6000;
      const binFloat = f / binResolution;
      const binLow = Math.floor(binFloat);
      const binHigh = Math.min(freqArray.length - 1, binLow + 1);
      const weight = binFloat - binLow;

      const valLow = freqArray[binLow] || 0;
      const valHigh = freqArray[binHigh] || 0;
      const val = (1 - weight) * valLow + weight * valHigh;

      const y = h - (val / 255) * (h - 24) - 2;
      if (x === 0) canvasCtx.moveTo(x, y);
      else canvasCtx.lineTo(x, y);
    }
    canvasCtx.strokeStyle = "rgba(6, 182, 212, 0.85)"; // Glowing cyan curve
    canvasCtx.lineWidth = 1.5;
    canvasCtx.stroke();
  };

  const handleRecordSandboxClip = (category) => {
    if (!liveStreamRef.current) {
      console.warn("Live stream not active!");
      return;
    }

    clearAllCalibIntervals();
    if (playbackAudioRef.current) {
      playbackAudioRef.current.pause();
      playbackAudioRef.current = null;
    }
    if (playbackIntervalRef.current) {
      clearInterval(playbackIntervalRef.current);
      playbackIntervalRef.current = null;
    }
    isPlaybackActiveRef.current = false;

    setRecordingCategory(category);
    setRecordingCountdown(2);
    recordingFramesRef.current = [];

    // Start audio recorder
    const rec = new MediaRecorder(liveStreamRef.current);
    const chunks = [];
    rec.ondataavailable = e => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    rec.onstop = () => {
      const blob = new Blob(chunks, { type: "audio/webm" });
      const url = URL.createObjectURL(blob);

      const newClip = {
        id: `sandbox_${Date.now()}`,
        category,
        url,
        blob, // Keep blob for IDB
        frames: [...recordingFramesRef.current]
      };

      // Save to IDB
      saveSandboxClip({ id: newClip.id, category: newClip.category, blob: newClip.blob, frames: newClip.frames })
        .catch(e => console.error("Failed to save clip to IDB:", e));

      setSandboxClips(prev => {
        const next = [...prev, newClip];
        // Automatically optimize parameters whenever a new clip is recorded!
        setTimeout(() => optimizeThresholds(next), 100);
        return next;
      });

      setRecordingCategory("");
      setRecordingCountdown(0);
    };

    rec.start();

    // 2-second countdown
    let left = 2;
    const interval = setInterval(() => {
      left--;
      if (left > 0) {
        setRecordingCountdown(left);
      } else {
        clearInterval(interval);
        rec.stop();
      }
    }, 1000);

    calibIntervalsRef.current.push(interval);
  };

  const handlePlaySandboxClip = (clip) => {
    // 1. Stop any active playback
    if (playbackAudioRef.current) {
      playbackAudioRef.current.pause();
      playbackAudioRef.current = null;
    }
    if (playbackIntervalRef.current) {
      clearInterval(playbackIntervalRef.current);
      playbackIntervalRef.current = null;
    }

    // 2. Set playback active
    isPlaybackActiveRef.current = true;
    
    // 3. Play audio
    const audio = new Audio(clip.url);
    playbackAudioRef.current = audio;
    audio.play().catch(e => console.warn("Playback block:", e));

    // 4. Feed frames to live visuals at the original interval rate (e.g. ~30ms per frame)
    let frameIdx = 0;
    const totalFrames = clip.frames.length;
    if (totalFrames === 0) {
      isPlaybackActiveRef.current = false;
      return;
    }

    const frameRateMs = 2000 / totalFrames; // Clip is exactly 2 seconds long!

    playbackIntervalRef.current = setInterval(() => {
      if (frameIdx >= totalFrames) {
        clearInterval(playbackIntervalRef.current);
        isPlaybackActiveRef.current = false;
        playbackIntervalRef.current = null;
        playbackAudioRef.current = null;
        return;
      }

      const frame = clip.frames[frameIdx];
      
      // Update telemetry states so HUD & Sliders bounce during playback!
      setLiveVolume(frame.rms);
      setLiveRatio(frame.ratio);
      setLiveVoicing(frame.voicing);
      setLiveLowAvgState(frame.lowAvg);
      setLiveHighAvgState(frame.highAvg);

      // Determine classification status
      const silenceThreshold = settingsRef.current?.calibration?.silence_threshold || 0.005;
      const voicingThreshold = settingsRef.current?.calibration?.voicing_threshold || 0.28;
      const whisperRatioThreshold = settingsRef.current?.calibration?.whisper_ratio_threshold || 1.80;

      let status = "silence";
      if (frame.rms >= silenceThreshold) {
        const isVoiced = frame.voicing >= voicingThreshold;
        const isWhisper = !isVoiced && frame.ratio >= whisperRatioThreshold;
        if (isVoiced) status = "normal";
        else if (isWhisper) status = "whisper";
        else status = "other";
      }
      setLiveStatus(status);

      // Draw the stored frequency and time domain data on the canvas spectrogram!
      const canvas = canvasRef.current;
      if (canvas && frame.freqData && frame.timeData) {
        drawSpectrogramFrame(canvas, frame.freqData, frame.timeData, frame.rms, frame.lowAvg, frame.highAvg, frame.ratio, frame.voicing);
      }

      frameIdx++;
    }, frameRateMs);

    audio.onended = () => {
      clearInterval(playbackIntervalRef.current);
      isPlaybackActiveRef.current = false;
      playbackIntervalRef.current = null;
      playbackAudioRef.current = null;
    };
  };

  const handleDeleteSandboxClip = (clipId) => {
      deleteSandboxClip(clipId).catch(e => console.error("Failed to delete clip from IDB:", e));
      
      setSandboxClips(prev => {
        const next = prev.filter(c => c.id !== clipId);
        // Automatically re-optimize whenever a clip is deleted
        setTimeout(() => optimizeThresholds(next), 100);
        return next;
      });
    };

  const getClipClassification = (clip) => {
    const silence = settingsRef.current?.calibration?.silence_threshold || 0.005;
    const ratio = settingsRef.current?.calibration?.whisper_ratio_threshold || 1.80;
    const voicing = settingsRef.current?.calibration?.voicing_threshold || 0.28;

    const frames = clip.frames;
    if (!frames || frames.length === 0) return "silence";

    let activeRmsSum = 0;
    let activeVoicingSum = 0;
    let activeRatioSum = 0;
    let activeCount = 0;
    let totalRms = 0;

    for (const f of frames) {
      totalRms += f.rms;
      if (f.rms >= silence) {
        activeRmsSum += f.rms;
        activeVoicingSum += f.voicing;
        activeRatioSum += f.ratio;
        activeCount++;
      }
    }

    const avgRMS = totalRms / frames.length;
    const avgVoicing = activeCount > 0 ? (activeVoicingSum / activeCount) : 0;
    const avgRatio = activeCount > 0 ? (activeRatioSum / activeCount) : 1.0;

    if (avgRMS < silence) return "silence";
    if (avgVoicing >= voicing) return "talk";
    if (avgRatio >= ratio) return "whisper";
    return "other";
  };

  const optimizeThresholds = (clips) => {
    if (!clips || clips.length === 0) return;

    const evaluatedClips = clips.map(clip => ({
      id: clip.id,
      category: clip.category,
      frames: clip.frames
    }));

    let maxAcc = -1;
    let bestCombinations = [];

    // Search parameter space (Matching UI sliders)
    for (let silence = 0.001; silence <= 0.030; silence += 0.001) {
      for (let ratio = 0.50; ratio <= 6.00; ratio += 0.10) {
        for (let voicing = 0.05; voicing <= 0.80; voicing += 0.02) {
          
          let correctCount = 0;
          
          for (const clip of evaluatedClips) {
            const frames = clip.frames;
            if (frames.length === 0) continue;

            let activeRmsSum = 0;
            let activeVoicingSum = 0;
            let activeRatioSum = 0;
            let activeCount = 0;
            let totalRms = 0;

            for (const f of frames) {
              totalRms += f.rms;
              if (f.rms >= silence) {
                activeRmsSum += f.rms;
                activeVoicingSum += f.voicing;
                
                // Recalculate ratio exactly how App.jsx does it using a fixed noise floor
                const lowSignal = Math.max(0.01, (f.lowAvg || 0) - 5.0);
                const highSignal = Math.max(0.01, (f.highAvg || 0) - 5.0);
                activeRatioSum += highSignal / lowSignal;
                
                activeCount++;
              }
            }

            const avgRMS = totalRms / frames.length;
            const avgVoicing = activeCount > 0 ? (activeVoicingSum / activeCount) : 0;
            const avgRatio = activeCount > 0 ? (activeRatioSum / activeCount) : 1.0;

            let classification = "silence";
            if (avgRMS >= silence) {
              const isVoiced = avgVoicing >= voicing;
              const isWhisper = !isVoiced && avgRatio >= ratio;
              if (isVoiced) classification = "talk";
              else if (isWhisper) classification = "whisper";
              else classification = "other";
            }

            if (classification === clip.category) {
              correctCount++;
            }
          }

          const acc = correctCount / evaluatedClips.length;
          
          if (acc > maxAcc) {
            maxAcc = acc;
            bestCombinations = [{ silence, ratio, voicing }];
          } else if (acc === maxAcc) {
            bestCombinations.push({ silence, ratio, voicing });
          }
        }
      }
    }

    if (bestCombinations.length > 0) {
      // Find the center of mass of all best combinations
      let sumSilence = 0, sumRatio = 0, sumVoicing = 0;
      for (const c of bestCombinations) {
        sumSilence += c.silence;
        sumRatio += c.ratio;
        sumVoicing += c.voicing;
      }
      const centerSilence = sumSilence / bestCombinations.length;
      const centerRatio = sumRatio / bestCombinations.length;
      const centerVoicing = sumVoicing / bestCombinations.length;
      
      // Pick the single proven combination closest to the center of mass.
      // This guarantees we use a 100% accurate combination (avoiding disjoint union bugs),
      // while maximizing the margin of error for all three parameters in the real world.
      let bestParams = bestCombinations[0];
      let minDistance = Infinity;

      for (const c of bestCombinations) {
        // Normalize distance metrics so parameters have equal weight
        const dSilence = (c.silence - centerSilence) / 0.030;
        const dRatio = (c.ratio - centerRatio) / 6.0;
        const dVoicing = (c.voicing - centerVoicing) / 0.80;
        
        const distSq = (dSilence * dSilence) + (dRatio * dRatio) + (dVoicing * dVoicing);
        if (distSq < minDistance) {
          minDistance = distSq;
          bestParams = c;
        }
      }
      
      const currentSettings = settingsRef.current;
      const finalSettings = {
        ...currentSettings,
        calibration: {
          ...currentSettings.calibration,
          silence_threshold: bestParams.silence,
          whisper_ratio_threshold: bestParams.ratio,
          voicing_threshold: bestParams.voicing
        }
      };
      setSettings(finalSettings);
      settingsService.saveSettings(finalSettings).then(() => {
        console.log(`Auto-tweak optimized settings saved.`, bestParams);
      }).catch(err => {
        console.error("Auto-tweak failed to save settings:", err);
      });
    }
  };


  const runManualCalib = (type) => {
    clearAllCalibIntervals();
    calibSamplesRef.current = [];
    calibPhaseRef.current = `measuring_${type}`;
    
    let text = "";
    if (type === "silence") {
      text = "Wees a.u.b. stil. Omgevingsgeluid meten...";
    } else if (type === "whisper") {
      text = "Fluister nu zachtjes in de microfoon...";
    } else if (type === "voice") {
      text = "Praat nu op een normaal volume...";
    } else if (type === "test_clip") {
      text = "Praat of fluister nu. Test-opname loopt...";
    }

    setCalibStatus({
      active: true,
      type,
      countdown: 3,
      text
    });

    let count = 3;
    const timer = setInterval(() => {
      count--;
      if (count > 0) {
        setCalibStatus(prev => ({ ...prev, countdown: count }));
      } else {
        clearInterval(timer);
        
        // Finalize measurement
        calibPhaseRef.current = "idle";
        const samples = calibSamplesRef.current;
        const currentSettings = settingsRef.current;
        let updatedSettings = { ...currentSettings };
        let shouldSave = true;

        if (type === "silence") {
          const avgRMS = samples.reduce((sum, s) => sum + s.rms, 0) / (samples.length || 1);
          const avgLow = samples.reduce((sum, s) => sum + s.lowAvg, 0) / (samples.length || 1);
          const avgHigh = samples.reduce((sum, s) => sum + s.highAvg, 0) / (samples.length || 1);

          lowNoiseFloorRef.current = avgLow;
          highNoiseFloorRef.current = avgHigh;

          const recommendedSilence = Math.max(0.003, Math.min(0.020, avgRMS * 1.5));
          updatedSettings.calibration = {
            ...updatedSettings.calibration,
            silence_threshold: recommendedSilence
          };
          
          setCalibStatus({
            active: true,
            type: "silence_complete",
            countdown: 0,
            text: `Stilte succesvol gemeten! Aanbevolen drempel: ${recommendedSilence.toFixed(4)}`
          });
        } else if (type === "whisper") {
          const avgRatio = samples.reduce((sum, s) => sum + s.ratio, 0) / (samples.length || 1);
          const recommendedRatio = Math.max(1.00, Math.min(5.50, avgRatio * 0.70));
          
          updatedSettings.calibration = {
            ...updatedSettings.calibration,
            whisper_ratio_threshold: recommendedRatio
          };

          setCalibStatus({
            active: true,
            type: "whisper_complete",
            countdown: 0,
            text: `Fluister ratio succesvol gemeten! Aanbevolen drempel: ${recommendedRatio.toFixed(2)}`
          });
        } else if (type === "voice") {
          const avgVoicing = samples.reduce((sum, s) => sum + s.voicing, 0) / (samples.length || 1);
          const recommendedVoicing = Math.max(0.15, Math.min(0.50, avgVoicing * 0.75));

          updatedSettings.calibration = {
            ...updatedSettings.calibration,
            voicing_threshold: recommendedVoicing
          };

          setCalibStatus({
            active: true,
            type: "voice_complete",
            countdown: 0,
            text: `Stem periodiciteit succesvol gemeten! Aanbevolen drempel: ${recommendedVoicing.toFixed(2)}`
          });
        } else if (type === "test_clip") {
          shouldSave = false;
          
          const rmsList = samples.map(s => s.rms);
          const lowAvgs = samples.map(s => s.lowAvg);
          const highAvgs = samples.map(s => s.highAvg);
          const voicingsList = samples.map(s => s.voicing);

          // Use the exact same trimming logic as App.jsx!
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

          const SILENCE_THRESHOLD = currentSettings.calibration?.silence_threshold !== undefined
            ? parseFloat(currentSettings.calibration.silence_threshold)
            : 0.005;

          const WHISPER_RATIO_THRESHOLD = currentSettings.calibration?.whisper_ratio_threshold !== undefined
            ? parseFloat(currentSettings.calibration.whisper_ratio_threshold)
            : 1.8;

          const VOICING_THRESHOLD = currentSettings.calibration?.voicing_threshold !== undefined
            ? parseFloat(currentSettings.calibration.voicing_threshold)
            : 0.30;

          const fixedNoiseFloor = 5.0;

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

          let resultText = "Ander geluid";
          if (isSilence) resultText = "Stilte";
          else if (isVoiced) resultText = "Spreken (Te Luid)";
          else if (isWhispered) resultText = "Fluistering (Correct!)";

          console.log(
            "=================== TEST OPNAME RESULTAAT ===================\n" +
            `Totale frames: ${rmsList.length} -> Sliced frames: ${slicedRms.length}\n` +
            `Silence Threshold: ${SILENCE_THRESHOLD} | Avg RMS: ${avgRms.toFixed(5)}\n` +
            `Ratio Threshold: ${WHISPER_RATIO_THRESHOLD} | Avg Active Ratio: ${avgActiveRatio.toFixed(3)}\n` +
            `Voicing Threshold: ${VOICING_THRESHOLD} | Avg Voicing: ${avgVoicing.toFixed(3)}\n` +
            `Is Silence: ${isSilence} | Is Voiced: ${isVoiced} | Is Whisper: ${isWhispered}\n` +
            `Resultaat: ${resultText}\n` +
            "==========================================================="
          );

          console.log("Raw RMS List:", rmsList);
          console.log("Raw Ratio List:", samples.map(s => s.ratio));
          console.log("Raw Voicing List:", voicingsList);
          console.log("Sliced RMS List:", slicedRms);
          console.log("Sliced Ratio List:", slicedRms.map((rms, idx) => {
            const lowSignal = Math.max(0.01, (slicedLowAvgs[idx] || 0) - fixedNoiseFloor);
            const highSignal = Math.max(0.01, (slicedHighAvgs[idx] || 0) - fixedNoiseFloor);
            return highSignal / lowSignal;
          }));
          console.log("Sliced Voicing List:", slicedVoicings);

          setCalibStatus({
            active: true,
            type: "test_complete",
            countdown: 0,
            text: `Test opname klaar! Resultaat: ${resultText}. Bekijk console (F12) voor details.`
          });
        }

        if (shouldSave) {
          // Save immediately to Firestore
          setSettings(updatedSettings);
          settingsService.saveSettings(updatedSettings).then(() => {
            console.log(`Successfully saved ${type} calibration to Firestore.`);
          }).catch(err => {
            console.error("Failed to save manual calibration:", err);
          });
        }
      }
    }, 1000);

    calibIntervalsRef.current.push(timer);
  };

  // Active state texts editing state
  const [selectedTextState, setSelectedTextState] = useState("initial_message");

  const startLiveMonitor = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      liveStreamRef.current = stream;

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx();
      liveAudioCtxRef.current = ctx;

      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048; // Increased from 1024 for highly precise voicing detection
      src.connect(analyser);
      liveAnalyserRef.current = analyser;

      let smoothedRMS = 0;
      let smoothedVoicing = 0;
      let smoothedRatio = 1.0;

      const update = () => {
        if (!liveAnalyserRef.current) return;
        
        // 1. Calculate RMS Volume
        const timeArray = new Uint8Array(liveAnalyserRef.current.fftSize);
        liveAnalyserRef.current.getByteTimeDomainData(timeArray);
        let sum = 0;
        for (let i = 0; i < timeArray.length; i++) {
          const val = (timeArray[i] - 128) / 128;
          sum += val * val;
        }
        const rms = Math.sqrt(sum / timeArray.length);

        // Leaky integration smoothing for RMS
        smoothedRMS = smoothedRMS * 0.85 + rms * 0.15;
        setLiveVolume(smoothedRMS);

        // 2. Calculate Whisper Frequency Ratio
        const freqArray = new Uint8Array(liveAnalyserRef.current.frequencyBinCount);
        liveAnalyserRef.current.getByteFrequencyData(freqArray);

        const sampleRate = liveAudioCtxRef.current?.sampleRate || 44100;
        const binResolution = sampleRate / liveAnalyserRef.current.fftSize;

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

        const silenceThreshold = settingsRef.current?.calibration?.silence_threshold !== undefined
          ? parseFloat(settingsRef.current.calibration.silence_threshold)
          : 0.005;

        const voicingThreshold = settingsRef.current?.calibration?.voicing_threshold !== undefined
          ? parseFloat(settingsRef.current.calibration.voicing_threshold)
          : 0.30;

        const whisperRatioThreshold = settingsRef.current?.calibration?.whisper_ratio_threshold !== undefined
          ? parseFloat(settingsRef.current.calibration.whisper_ratio_threshold)
          : 1.80;

        const isSilenceFrame = smoothedRMS < silenceThreshold;

        // Leaky Noise Floor adaptation
        if (isSilenceFrame) {
          lowNoiseFloorRef.current = lowNoiseFloorRef.current * 0.95 + lowAvg * 0.05;
          highNoiseFloorRef.current = highNoiseFloorRef.current * 0.95 + highAvg * 0.05;
        } else {
          if (lowAvg < lowNoiseFloorRef.current) {
            lowNoiseFloorRef.current = lowNoiseFloorRef.current * 0.9 + lowAvg * 0.1;
          } else {
            lowNoiseFloorRef.current = lowNoiseFloorRef.current * 0.9995 + lowAvg * 0.0005;
          }

          if (highAvg < highNoiseFloorRef.current) {
            highNoiseFloorRef.current = highNoiseFloorRef.current * 0.9 + highAvg * 0.1;
          } else {
            highNoiseFloorRef.current = highNoiseFloorRef.current * 0.9995 + highAvg * 0.0005;
          }
        }

        const lowSignal = Math.max(0.01, lowAvg - lowNoiseFloorRef.current);
        const highSignal = Math.max(0.01, highAvg - highNoiseFloorRef.current);
        const activeRatio = highSignal / lowSignal;

        const voicing = getVoicingPeriodicity(timeArray, sampleRate);

        // Smooth active ratio and voicing to eliminate jittering!
        smoothedRatio = smoothedRatio * 0.75 + activeRatio * 0.25;
        smoothedVoicing = smoothedVoicing * 0.75 + voicing * 0.25;

        setLiveLowAvgState(lowAvg);
        setLiveHighAvgState(highAvg);
        setLiveLowNoiseState(lowNoiseFloorRef.current);
        setLiveHighNoiseState(highNoiseFloorRef.current);

        // Record samples for Auto-Calibration Wizard
        if (calibPhaseRef.current === "measuring_silence") {
          calibSamplesRef.current.push({
            rms,
            lowAvg,
            highAvg
          });
        } else if (calibPhaseRef.current === "measuring_whisper") {
          calibSamplesRef.current.push({
            rms,
            lowAvg,
            highAvg,
            ratio: activeRatio,
            voicing
          });
        } else if (calibPhaseRef.current === "measuring_voice") {
          calibSamplesRef.current.push({
            rms,
            lowAvg,
            highAvg,
            ratio: activeRatio,
            voicing
          });
        } else if (calibPhaseRef.current === "measuring_test_clip") {
          calibSamplesRef.current.push({
            rms,
            lowAvg,
            highAvg,
            ratio: activeRatio,
            voicing
          });
        }

        let status = "silence";

        if (smoothedRMS >= silenceThreshold) {
          setLiveRatio(smoothedRatio);
          setLiveVoicing(smoothedVoicing);

          const isVoiced = smoothedVoicing >= voicingThreshold;
          const isWhisper = !isVoiced && smoothedRatio >= whisperRatioThreshold;

          if (isVoiced) {
            status = "normal";
          } else if (isWhisper) {
            status = "whisper";
          } else {
            status = "other";
          }
        } else {
          setLiveRatio(0);
          setLiveVoicing(0);
        }
        setLiveStatus(status);

        // 3. Record sandbox clip frames in real-time if active
        if (recordingCategoryRef.current !== "") {
          recordingFramesRef.current.push({
            rms,
            lowAvg,
            highAvg,
            ratio: activeRatio,
            voicing,
            freqData: new Uint8Array(freqArray),
            timeData: new Uint8Array(timeArray)
          });
        }

        // 4. Draw to visualizer spectrogram only if playback is not active
        if (!isPlaybackActiveRef.current && canvasRef.current) {
          drawSpectrogramFrame(canvasRef.current, freqArray, timeArray, rms, lowAvg, highAvg, activeRatio, voicing);
        }

        liveAnimFrameRef.current = requestAnimationFrame(update);
      };
      update();
    } catch (e) {
      console.warn("Live monitoring mic blocked:", e);
    }
  };

  const stopLiveMonitor = () => {
    clearAllCalibIntervals();
    setCalibStatus({ active: false, type: "", countdown: 0, text: "" });
    calibPhaseRef.current = "idle";
    
    // Stop playback
    if (playbackAudioRef.current) {
      playbackAudioRef.current.pause();
      playbackAudioRef.current = null;
    }
    if (playbackIntervalRef.current) {
      clearInterval(playbackIntervalRef.current);
      playbackIntervalRef.current = null;
    }
    isPlaybackActiveRef.current = false;
    if (liveAnimFrameRef.current) cancelAnimationFrame(liveAnimFrameRef.current);
    if (liveStreamRef.current) {
      liveStreamRef.current.getTracks().forEach(t => t.stop());
      liveStreamRef.current = null;
    }
    if (liveAudioCtxRef.current && liveAudioCtxRef.current.state !== "closed") {
      liveAudioCtxRef.current.close();
      liveAudioCtxRef.current = null;
    }
  };

  useEffect(() => {
    let unsubWhispers = null;
    let unsubDeleted = null;

    const unsubscribeAuth = authService.onAuthChange((currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        // Load configurations
        loadSettingsAndConfig();

        // 1. Subscribe to active whispers
        unsubWhispers = dbService.subscribeWhispers(
          (data) => {
            const sorted = [...data].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
            setWhispers(sorted);
            setDbError(null);
          },
          (err) => {
            console.error("Admin active whispers load error:", err);
            setDbError(err.message || "Fout bij live-verbinding met Firestore database.");
          }
        );

        // 2. Subscribe to deleted whispers
        unsubDeleted = dbService.subscribeDeletedWhispers(
          (data) => {
            const sorted = [...data].sort((a, b) => new Date(b.deletedAt || b.timestamp) - new Date(a.deletedAt || a.timestamp));
            setDeletedWhispers(sorted);
          },
          (err) => {
            console.error("Admin deleted whispers load error:", err);
          }
        );
      } else {
        if (unsubWhispers) { unsubWhispers(); unsubWhispers = null; }
        if (unsubDeleted) { unsubDeleted(); unsubDeleted = null; }
        setWhispers([]);
        setDeletedWhispers([]);
      }
    });

    return () => {
      unsubscribeAuth();
      if (unsubWhispers) unsubWhispers();
      if (unsubDeleted) unsubDeleted();
    };
  }, []);

  // Monitor tab change to trigger/stop mic levels
  useEffect(() => {
    if (activeTab === "calibration" && user) {
      startLiveMonitor();
    } else {
      stopLiveMonitor();
    }
    return () => stopLiveMonitor();
  }, [activeTab, user]);

  const loadSettingsAndConfig = async () => {
    setIsLoading(true);
    try {
      const currentSettings = await settingsService.getSettings();
      setSettings(currentSettings);

      // Load cached raw config if any
      const savedConfig = localStorage.getItem("fluisterwolk_firebase_config");
      if (savedConfig) {
        setRawConfigInput(JSON.stringify(JSON.parse(savedConfig), null, 2));
      }
    } catch (e) {
      console.error("Failed to load settings & config:", e);
    }
    setIsLoading(false);
  };

  const loadData = async () => {
    await loadSettingsAndConfig();
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginError("");

    try {
      const userResult = await authService.loginWithGoogle();
      if (userResult.email?.trim().toLowerCase() !== "studiohichambendriss@gmail.com") {
        await authService.logoutAdmin(); // force logout immediately
        setLoginError("Toegang geweigerd: Alleen studiohichambendriss@gmail.com is toegestaan.");
      }
    } catch (err) {
      setLoginError(err.message || "Fout bij inloggen met Google.");
    }
  };

  if (!user) {
    return (
      <div className="admin-overlay" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="glass-panel" style={{ width: "100%", maxWidth: "420px", padding: "40px", display: "flex", flexDirection: "column", gap: "24px", position: "relative" }}>
          
          <button 
            onClick={onClose}
            style={{
              position: "absolute",
              top: "20px",
              right: "20px",
              background: "none",
              border: "none",
              color: "rgba(255,255,255,0.4)",
              cursor: "pointer",
              transition: "color 0.2s ease"
            }}
            onMouseEnter={(e) => e.target.style.color = "#fff"}
            onMouseLeave={(e) => e.target.style.color = "rgba(255,255,255,0.4)"}
          >
            <LogOut size={20} />
          </button>

          <div style={{ textAlign: "center", marginBottom: "8px" }}>
            <ShieldCheck size={48} color="#a5e7fd" style={{ marginBottom: "16px" }} />
            <h2 style={{ fontFamily: "var(--font-serif)", fontSize: "1.75rem", margin: "0 0 8px 0" }}>Beheerderspaneel</h2>
            <p style={{ color: "rgba(255,255,255,0.6)", fontSize: "0.9rem", margin: 0 }}>Log in met je Google account om verder te gaan.</p>
          </div>

          <form onSubmit={handleLogin} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            
            <button 
              type="submit" 
              className="btn-premium"
              style={{
                width: "100%",
                padding: "16px",
                fontSize: "1rem",
                marginTop: "8px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "12px",
                background: "linear-gradient(45deg, #1a1a1a, #2a2a2a)",
                border: "1px solid rgba(165, 231, 253, 0.3)"
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              <span>Inloggen met Google</span>
            </button>

            {loginError && (
              <div style={{ padding: "12px", backgroundColor: "rgba(239, 68, 68, 0.1)", border: "1px solid rgba(239, 68, 68, 0.3)", borderRadius: "8px", color: "#ef4444", fontSize: "0.85rem", textAlign: "center" }}>
                {loginError}
              </div>
            )}
          </form>
        </div>
      </div>
    );
  }

  const handleLogout = async () => {
    await authService.logoutAdmin();
    setWhispers([]);
    setDeletedWhispers([]);
  };

  // Whisper actions
  const handleDelete = async (whisper) => {
    if (!window.confirm(`Weet u zeker dat u "${whisper.transcription}" naar de prullenbak wilt verplaatsen?`)) return;

    try {
      setActionMessage("Verplaatsen naar prullenbak...");
      await dbService.deleteWhisper(whisper);
      
      setWhispers(prev => prev.filter(item => item.id !== whisper.id));
      setDeletedWhispers(prev => [
        { ...whisper, deletedAt: new Date().toISOString() },
        ...prev
      ]);
      
      setActionMessage("Verplaatst.");
      setTimeout(() => setActionMessage(""), 2000);
    } catch (err) {
      console.error(err);
      setActionMessage("Fout bij verwijderen.");
    }
  };

  const handleRestore = async (whisper) => {
    try {
      setActionMessage("Herstellen...");
      await dbService.restoreWhisper(whisper);
      
      setDeletedWhispers(prev => prev.filter(item => item.id !== whisper.id));
      const { deletedAt, ...cleanWhisper } = whisper;
      setWhispers(prev => [cleanWhisper, ...prev]);

      setActionMessage("Hersteld.");
      setTimeout(() => setActionMessage(""), 2000);
    } catch (err) {
      console.error(err);
      setActionMessage("Fout bij herstellen.");
    }
  };

  const handlePurge = async (whisper) => {
    if (!window.confirm(`Let op: "${whisper.transcription}" permanent verwijderen? Dit kan niet ongedaan gemaakt worden!`)) return;

    try {
      setActionMessage("Permanent verwijderen...");
      await dbService.purgeWhisper(whisper.id);
      if (whisper.filename) {
        await storageService.deleteAudio(whisper.filename);
      }
      setDeletedWhispers(prev => prev.filter(item => item.id !== whisper.id));
      setActionMessage("Permanent verwijderd.");
      setTimeout(() => setActionMessage(""), 2000);
    } catch (err) {
      console.error(err);
      setActionMessage("Fout bij purgen.");
    }
  };

  const playAudio = (whisper) => {
    if (playingId === whisper.id) {
      setPlayingId(null);
      return;
    }
    
    const audio = new Audio(whisper.audioUrl);
    
    const TARGET_RMS = 0.05;
    const whisperRms = whisper.avgRms || 0.01;
    const normalizationGain = TARGET_RMS / whisperRms;
    
    const globalNormRaw = settings.calibration?.global_normalization;
    const globalNorm = globalNormRaw !== undefined ? parseFloat(globalNormRaw) : 0.0;
    const normMultiplier = 1.0 + (normalizationGain - 1.0) * globalNorm;
    
    const globalVolRaw = settings.calibration?.global_volume;
    const globalVol = globalVolRaw !== undefined ? parseFloat(globalVolRaw) : 1.0;
    
    const indVolRaw = whisper.volumeMultiplier;
    const indVol = indVolRaw !== undefined ? parseFloat(indVolRaw) : 1.0;
    
    let finalVolume = 0.55 * normMultiplier * globalVol * indVol;
    
    if (isNaN(finalVolume)) {
      finalVolume = 0.55;
    }
    
    audio.volume = Math.max(0.0, Math.min(1.0, finalVolume));
    
    setPlayingId(whisper.id);
    
    audio.play().catch(e => {
      console.error("Audio blocked:", e);
      setPlayingId(null);
    });
    
    audio.onended = () => {
      setPlayingId(null);
    };
  };

  // Configuration updates
  const handleSaveCalibration = async (e) => {
    e.preventDefault();
    try {
      setActionMessage("Kalibratie opslaan...");
      await settingsService.saveSettings(settings);
      setActionMessage("Kalibratie succesvol opgeslagen.");
      setTimeout(() => setActionMessage(""), 2500);
    } catch (err) {
      console.error(err);
      setActionMessage("Fout bij opslaan.");
    }
  };

  const handleUpdateTextValue = (key, val) => {
    setSettings(prev => ({
      ...prev,
      texts: {
        ...prev.texts,
        [key]: val
      }
    }));
  };

  const handleSaveTexts = async (e) => {
    e.preventDefault();
    try {
      setActionMessage("Teksten en kleuren opslaan...");
      await settingsService.saveSettings(settings);
      setActionMessage("Teksten en kleuren succesvol opgeslagen.");
      setTimeout(() => setActionMessage(""), 2500);
    } catch (err) {
      console.error(err);
      setActionMessage("Fout bij opslaan.");
    }
  };

  const handleApplyFirebaseJSON = () => {
    try {
      if (!rawConfigInput.trim()) {
        localStorage.removeItem("fluisterwolk_firebase_config");
        setActionMessage("Firebase config gewist. Mock modus actief.");
        setTimeout(() => setActionMessage(""), 3000);
        return;
      }
      
      const parsed = JSON.parse(rawConfigInput);
      if (!parsed.apiKey || !parsed.projectId) {
        throw new Error("Ongeldig Firebase Config. API Key en Project ID zijn verplicht.");
      }
      
      localStorage.setItem("fluisterwolk_firebase_config", JSON.stringify(parsed));
      setActionMessage("Firebase config toegepast! Herlaad de pagina.");
      setTimeout(() => setActionMessage(""), 5000);
    } catch (e) {
      alert("Configuratiefout: " + e.message);
    }
  };

  const handleExportJSON = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(whispers, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `whisperbook_export_${Date.now()}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  // Statistics
  const totalCount = whispers.length;
  const whisperCount = whispers.filter(w => w.speechType === "whisper").length;
  const whisperPercentage = totalCount > 0 ? Math.round((whisperCount / totalCount) * 100) : 0;

  return (
    <div className="admin-overlay">
      {/* Header Bar */}
      <header className="admin-header">
        <button
          onClick={onClose}
          className="btn-premium"
          style={{ padding: "8px 16px", fontSize: "0.75rem" }}
        >
          <ArrowLeft size={14} />
          <span>Terug naar Cloud</span>
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <span style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: "600", fontSize: "1.2rem" }}>Fluisterwolk Admin</span>
          {isMockMode ? (
            <span style={{ fontSize: "9px", backgroundColor: "rgba(245, 158, 11, 0.1)", border: "1px solid rgba(245, 158, 11, 0.2)", color: "#f59e0b", padding: "2px 8px", borderRadius: "12px", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: "600" }}>
              Mock Mode (Lokaal)
            </span>
          ) : dbError ? (
            <span style={{ fontSize: "9px", backgroundColor: "rgba(239, 68, 68, 0.1)", border: "1px solid rgba(239, 68, 68, 0.2)", color: "#ef4444", padding: "2px 8px", borderRadius: "12px", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: "600" }}>
              Firebase Fout (Offline)
            </span>
          ) : (
            <span style={{ fontSize: "9px", backgroundColor: "rgba(16, 185, 129, 0.1)", border: "1px solid rgba(16, 185, 129, 0.2)", color: "#10b981", padding: "2px 8px", borderRadius: "12px", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: "600" }}>
              Firebase Live
            </span>
          )}
        </div>

        {user && (
          <button
            onClick={handleLogout}
            className="btn-premium"
            style={{ padding: "8px 16px", fontSize: "0.75rem", borderColor: "rgba(239, 68, 68, 0.3)", color: "#ef4444" }}
          >
            <LogOut size={12} />
            <span>Uitloggen</span>
          </button>
        )}
      </header>

      {/* Auth Screen */}
      {!user ? (
        <main style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }}>
          <form 
            onSubmit={handleLogin}
            className="glass-panel"
            style={{ width: "100%", maxWidth: "380px", padding: "32px", display: "flex", flexDirection: "column", gap: "20px" }}
          >
            <div style={{ textAlign: "center" }}>
              <div style={{ width: "48px", height: "48px", backgroundColor: "rgba(255, 255, 255, 0.05)", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 12px" }}>
                <Lock size={20} style={{ color: "#ffffff" }} />
              </div>
              <h2 style={{ fontFamily: "var(--font-serif)", fontSize: "1.5rem", marginBottom: "4px" }}>Toegang Beveiligd</h2>
              <p style={{ fontSize: "0.75rem", color: "#888888" }}>Log in om de art-installatie te beheren.</p>
            </div>

            {loginError && (
              <div style={{ padding: "12px", backgroundColor: "rgba(239, 68, 68, 0.1)", border: "1px solid rgba(239, 68, 68, 0.2)", color: "#ef4444", fontSize: "0.75rem", borderRadius: "8px", display: "flex", alignItems: "center", gap: "8px" }}>
                <AlertTriangle size={14} />
                <span>{loginError}</span>
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px", textAlign: "left" }}>
                <label style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "#888888", fontWeight: "500" }}>E-mailadres</label>
                <div style={{ position: "relative" }}>
                  <Mail size={14} style={{ position: "absolute", left: "12px", top: "50%", transform: "translateY(-50%)", color: "#888888" }} />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="admin@fluisterwolk.nl"
                    className="admin-login-input"
                  />
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "6px", textAlign: "left" }}>
                <label style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "#888888", fontWeight: "500" }}>Wachtwoord</label>
                <div style={{ position: "relative" }}>
                  <Lock size={14} style={{ position: "absolute", left: "12px", top: "50%", transform: "translateY(-50%)", color: "#888888" }} />
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="admin-login-input"
                  />
                </div>
              </div>
            </div>

            <button type="submit" className="btn-premium" style={{ width: "100%", justifyContent: "center", marginTop: "8px" }}>
              <span>Inloggen</span>
            </button>

            {isMockMode && (
              <div style={{ fontSize: "10px", color: "#888888", textAlign: "center", fontStyle: "italic", borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: "12px" }}>
                Gebruik voor Mock login:<br />
                <strong>admin@fluisterwolk.nl</strong> / <strong>fluisteradmin</strong>
              </div>
            )}
          </form>
        </main>
      ) : (
        /* Admin Dashboard layout with Sidebar Tabs */
        <main className="admin-dashboard-layout" style={{ display: "flex", flex: 1, minHeight: 0 }}>
          {/* Admin Sidebar Navigation */}
          <aside className="admin-sidebar" style={{ width: "240px", backgroundColor: "#121212", borderRight: "1px solid rgba(255,255,255,0.06)", display: "flex", flexDirection: "column", padding: "20px 0" }}>
            <button className={`sidebar-tab ${activeTab === "whispers" ? "active" : ""}`} onClick={() => setActiveTab("whispers")}>
              <Play size={16} />
              <span>Fluisteringen</span>
            </button>
            <button className={`sidebar-tab ${activeTab === "trash" ? "active" : ""}`} onClick={() => setActiveTab("trash")}>
              <Trash2 size={16} />
              <span>Prullenbak</span>
            </button>
            <button className={`sidebar-tab ${activeTab === "calibration" ? "active" : ""}`} onClick={() => setActiveTab("calibration")}>
              <Sliders size={16} />
              <span>Microfoon Kalibratie</span>
            </button>
            <button className={`sidebar-tab ${activeTab === "texts" ? "active" : ""}`} onClick={() => setActiveTab("texts")}>
              <Type size={16} />
              <span>Scherm Teksten</span>
            </button>
            <button className={`sidebar-tab ${activeTab === "firebase" ? "active" : ""}`} onClick={() => setActiveTab("firebase")}>
              <Database size={16} />
              <span>Firebase Koppeling</span>
            </button>
          </aside>

          {/* Active Tab View Area */}
          <section style={{ flex: 1, padding: "40px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "24px" }}>
            {actionMessage && (
              <div style={{ padding: "10px 20px", backgroundColor: "#1e1e1e", border: "1px solid rgba(255,255,255,0.1)", color: "#ffffff", fontSize: "0.75rem", borderRadius: "8px", display: "flex", alignItems: "center", gap: "8px", alignSelf: "flex-start" }}>
                <CheckCircle size={14} style={{ color: "#10b981" }} />
                <span>{actionMessage}</span>
              </div>
            )}

            {!isMockMode && dbError && (
              <div 
                className="glass-panel"
                style={{ 
                  padding: "16px 24px", 
                  backgroundColor: "rgba(239, 68, 68, 0.08)", 
                  border: "1px solid rgba(239, 68, 68, 0.25)", 
                  borderRadius: "12px", 
                  display: "flex", 
                  flexDirection: "column", 
                  gap: "10px",
                  color: "#ffffff"
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "10px", color: "#ef4444", fontWeight: "600", fontSize: "0.95rem" }}>
                  <AlertTriangle size={18} />
                  <span>Verbindingsfout met Firebase gedetecteerd</span>
                </div>
                <div style={{ fontSize: "0.8rem", color: "rgba(255, 255, 255, 0.7)", lineHeight: "1.5" }}>
                  De verbinding met Google Firestore is geblokkeerd of mislukt. 
                  <strong style={{ color: "#ef4444" }}> Foutmelding: {dbError}</strong>
                  <br /><br />
                  <strong style={{ color: "#ffffff" }}>Mogelijke oorzaken & oplossingen:</strong>
                  <ul style={{ margin: "6px 0 0 20px", padding: 0, display: "flex", flexDirection: "column", gap: "4px" }}>
                    <li><strong>Brave Shields / Adblocker actief?</strong> Veel adblockers blokkeren Firestore API requests (`firestore.googleapis.com`). Schakel je adblocker of Brave Shields uit voor deze website.</li>
                    <li><strong>Geen Firestore Database?</strong> Zorg ervoor dat Firestore Database daadwerkelijk is geïnitialiseerd in de Firebase Console.</li>
                    <li><strong>Firestore Beveiligingsregels verlopen?</strong> Als de database in testmodus is aangemaakt, verlopen de lees/schrijf-rechten na 30 dagen. Pas de regels aan in de Firebase Console zodat deze publiek toegankelijk zijn: <code style={{ backgroundColor: "rgba(0,0,0,0.3)", padding: "2px 6px", borderRadius: "4px", fontSize: "0.75rem", color: "#ef4444" }}>allow read, write: if true;</code></li>
                  </ul>
                  <br />
                  <em>Het systeem is nu automatisch overgeschakeld op de lokale noodopslag (LocalStorage). Whispers worden lokaal op dit apparaat opgeslagen en afgespeeld, maar synchroniseren niet met andere apparaten totdat de Firebase verbinding is hersteld.</em>
                </div>
              </div>
            )}

            {/* TAB 1: WHISPERS DATABASE LIST */}
            {activeTab === "whispers" && (
              <>
                <section className="kpi-row">
                  <div className="kpi-card">
                    <span className="kpi-title">Totaal Actieve Whispers</span>
                    <h3 className="kpi-value">{totalCount}</h3>
                  </div>
                  <div className="kpi-card">
                    <span className="kpi-title">Fluisterpercentage</span>
                    <h3 className="kpi-value" style={{ color: "#10b981" }}>{whisperPercentage}%</h3>
                  </div>
                  <div className="kpi-card" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                    <span className="kpi-title">Database Beheer</span>
                    <div style={{ marginTop: "12px" }}>
                      <button onClick={handleExportJSON} disabled={whispers.length === 0} className="btn-premium" style={{ padding: "8px 16px", fontSize: "0.75rem" }}>
                        <Download size={12} />
                        <span>Exporteer Database</span>
                      </button>
                    </div>
                  </div>
                </section>

                <section className="kpi-row" style={{ marginTop: "16px" }}>
                  {/* Globale Volume Slider */}
                  <div className="kpi-card" style={{ flex: 1 }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                      <label style={{ fontSize: "0.75rem", color: "#888888", fontWeight: "600" }}>GLOBALE VOLUME (%)</label>
                      <div style={{ position: "relative", width: "100%" }}>
                        <input 
                          type="range" 
                          min="0.0" 
                          max="2.0" 
                          step="0.05"
                          value={settings.calibration?.global_volume ?? 1.0}
                          onChange={(e) => setSettings(prev => ({
                            ...prev,
                            calibration: {
                              ...prev.calibration,
                              global_volume: parseFloat(e.target.value)
                            }
                          }))}
                          onPointerUp={() => settingsService.saveSettings(settings)}
                          style={{ cursor: "pointer", width: "100%", margin: 0 }}
                        />
                      </div>
                      <span style={{ fontSize: "0.7rem", color: "#888888", display: "flex", justifyContent: "space-between" }}>
                        <span>Algemene volume multiplier.</span>
                        <span>{Math.round((settings.calibration?.global_volume ?? 1.0) * 100)}%</span>
                      </span>
                    </div>
                  </div>

                  {/* Globale Normalisatie Slider */}
                  <div className="kpi-card" style={{ flex: 1 }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                      <label style={{ fontSize: "0.75rem", color: "#888888", fontWeight: "600" }}>GLOBALE NORMALISATIE (%)</label>
                      <div style={{ position: "relative", width: "100%" }}>
                        <input 
                          type="range" 
                          min="0.0" 
                          max="1.0" 
                          step="0.05"
                          value={settings.calibration?.global_normalization ?? 0.0}
                          onChange={(e) => setSettings(prev => ({
                            ...prev,
                            calibration: {
                              ...prev.calibration,
                              global_normalization: parseFloat(e.target.value)
                            }
                          }))}
                          onPointerUp={() => settingsService.saveSettings(settings)}
                          style={{ cursor: "pointer", width: "100%", margin: 0 }}
                        />
                      </div>
                      <span style={{ fontSize: "0.7rem", color: "#888888", display: "flex", justifyContent: "space-between" }}>
                        <span>Zachte en harde opnames gelijk trekken.</span>
                        <span>{Math.round((settings.calibration?.global_normalization ?? 0.0) * 100)}%</span>
                      </span>
                    </div>
                  </div>
                </section>

                <section className="whispers-table-container">
                  <div className="whispers-table-header">
                    <h4 style={{ fontFamily: "var(--font-serif)", fontSize: "1.2rem", fontWeight: "600" }}>Geregistreerde Fluisteringen</h4>
                    <button onClick={loadData} style={{ background: "none", border: "none", fontSize: "0.75rem", color: "var(--accent-color)", cursor: "pointer", fontWeight: "500", display: "flex", alignItems: "center", gap: "6px" }}>
                      <RefreshCw size={12} />
                      <span>Vernieuw</span>
                    </button>
                  </div>

                  {isLoading ? (
                    <div style={{ padding: "40px", textAlign: "center", color: "#888888" }}>Laden...</div>
                  ) : whispers.length === 0 ? (
                    <div style={{ padding: "40px", textAlign: "center", color: "#888888", fontStyle: "italic" }}>Nog geen actieve fluisteringen in de database.</div>
                  ) : (
                    <div style={{ overflowX: "auto" }}>
                      <table className="whispers-table">
                        <thead>
                          <tr>
                            <th style={{ textAlign: "center", width: "50px" }}>Veilig</th>
                            <th>Tijdstip</th>
                            <th>Naam / Tekst</th>
                            <th>Type</th>
                            <th>Volume</th>
                            <th style={{ textAlign: "center" }}>Beluisteren</th>
                            <th style={{ textAlign: "right" }}>Verplaatsen</th>
                          </tr>
                        </thead>
                        <tbody>
                          {whispers.map((whisper) => {
                            let rowBg = "transparent";
                            if (whisper.isSafe) {
                              rowBg = "rgba(16, 185, 129, 0.15)"; // Green if manually marked safe
                            } else {
                              const classLevel = checkBadLanguage(whisper.transcription);
                              if (classLevel === "red") rowBg = "rgba(239, 68, 68, 0.25)"; // Red for highly likely
                              else if (classLevel === "orange") rowBg = "rgba(245, 158, 11, 0.25)"; // Orange for potential
                            }

                            return (
                            <tr key={whisper.id} style={{ backgroundColor: rowBg, transition: "background-color 0.3s" }}>
                              <td style={{ textAlign: "center" }}>
                                <input 
                                  type="checkbox" 
                                  checked={!!whisper.isSafe} 
                                  onChange={(e) => {
                                    const safe = e.target.checked;
                                    setWhispers(prev => prev.map(w => w.id === whisper.id ? { ...w, isSafe: safe } : w));
                                    dbService.updateWhisperSafeStatus(whisper.id, safe);
                                  }}
                                  style={{ cursor: "pointer", width: "16px", height: "16px", accentColor: "#10b981" }}
                                />
                              </td>
                              <td style={{ fontSize: "0.75rem", color: "#888888", whiteSpace: "nowrap" }}>{whisper.timestamp}</td>
                              <td style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: "1.05rem", fontWeight: "500" }}>{whisper.transcription}</td>
                              <td>
                                <span style={{
                                  display: "inline-block", padding: "2px 8px", borderRadius: "12px", fontSize: "10px", fontWeight: "600", border: "1px solid",
                                  backgroundColor: whisper.speechType === "whisper" ? "rgba(16, 185, 129, 0.1)" : "rgba(245, 158, 11, 0.1)",
                                  borderColor: whisper.speechType === "whisper" ? "rgba(16, 185, 129, 0.2)" : "rgba(245, 158, 11, 0.2)",
                                  color: whisper.speechType === "whisper" ? "#10b981" : "#f59e0b"
                                }}>
                                  {whisper.speechType === "whisper" ? "Fluister" : "Spreken"}
                                </span>
                              </td>
                              <td style={{ display: "flex", alignItems: "center", gap: "8px", paddingTop: "12px" }}>
                                <input
                                  type="range"
                                  min="0"
                                  max="2"
                                  step="0.05"
                                  value={whisper.volumeMultiplier ?? 1.0}
                                  onChange={(e) => {
                                    const val = parseFloat(e.target.value);
                                    setWhispers(prev => prev.map(w => w.id === whisper.id ? { ...w, volumeMultiplier: val } : w));
                                  }}
                                  onPointerUp={(e) => {
                                    dbService.updateWhisperVolume(whisper.id, parseFloat(e.target.value));
                                  }}
                                  style={{ width: "80px", cursor: "pointer", margin: 0 }}
                                />
                                <span style={{ fontSize: "10px", color: "#888888" }}>{Math.round((whisper.volumeMultiplier ?? 1.0) * 100)}%</span>
                              </td>
                              <td style={{ textAlign: "center" }}>
                                <button
                                  onClick={() => playAudio(whisper)}
                                  style={{
                                    padding: "8px", borderRadius: "50%", border: "1px solid rgba(255,255,255,0.15)",
                                    backgroundColor: playingId === whisper.id ? "#ffffff" : "transparent",
                                    color: playingId === whisper.id ? "#000000" : "#ffffff", cursor: "pointer", transition: "all 0.2s"
                                  }}
                                >
                                  <Play size={12} />
                                </button>
                              </td>
                              <td style={{ textAlign: "right" }}>
                                <button onClick={() => handleDelete(whisper)} style={{ background: "none", border: "none", padding: "6px", color: "rgba(239, 68, 68, 0.8)", cursor: "pointer" }}>
                                  <Trash2 size={14} />
                                </button>
                              </td>
                            </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              </>
            )}

            {/* TAB 2: TRASH BIN / DELETESOON */}
            {activeTab === "trash" && (
              <section className="whispers-table-container">
                <div className="whispers-table-header">
                  <h4 style={{ fontFamily: "var(--font-serif)", fontSize: "1.2rem", fontWeight: "600" }}>Prullenbak (Trash Bin)</h4>
                  <button onClick={loadData} style={{ background: "none", border: "none", fontSize: "0.75rem", color: "var(--accent-color)", cursor: "pointer", fontWeight: "500", display: "flex", alignItems: "center", gap: "6px" }}>
                    <RefreshCw size={12} />
                    <span>Vernieuw</span>
                  </button>
                </div>

                {isLoading ? (
                  <div style={{ padding: "40px", textAlign: "center", color: "#888888" }}>Laden...</div>
                ) : deletedWhispers.length === 0 ? (
                  <div style={{ padding: "40px", textAlign: "center", color: "#888888", fontStyle: "italic" }}>Prullenbak is leeg.</div>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table className="whispers-table">
                      <thead>
                        <tr>
                          <th>Verwijderd op</th>
                          <th>Naam / Tekst</th>
                          <th style={{ textAlign: "center" }}>Play</th>
                          <th style={{ textAlign: "center" }}>Herstellen</th>
                          <th style={{ textAlign: "right" }}>Vernietigen</th>
                        </tr>
                      </thead>
                      <tbody>
                        {deletedWhispers.map((whisper) => (
                          <tr key={whisper.id}>
                            <td style={{ fontSize: "0.75rem", color: "#888888" }}>{new Date(whisper.deletedAt || whisper.timestamp).toLocaleString()}</td>
                            <td style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: "1.05rem", color: "#888888" }}>{whisper.transcription}</td>
                            <td style={{ textAlign: "center" }}>
                              <button onClick={() => playAudio(whisper)} style={{ padding: "8px", borderRadius: "50%", border: "1px solid rgba(255,255,255,0.15)", backgroundColor: playingId === whisper.id ? "#ffffff" : "transparent", color: playingId === whisper.id ? "#000000" : "#ffffff", cursor: "pointer" }}>
                                <Play size={12} />
                              </button>
                            </td>
                            <td style={{ textAlign: "center" }}>
                              <button onClick={() => handleRestore(whisper)} style={{ background: "none", border: "none", color: "#10b981", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                                <Undo2 size={14} />
                                <span style={{ fontSize: "0.75rem" }}>Undo</span>
                              </button>
                            </td>
                            <td style={{ textAlign: "right" }}>
                              <button onClick={() => handlePurge(whisper)} style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer" }} title="Permanent wissen">
                                <Trash2 size={14} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            )}

            {/* TAB 3: MICROPHONE CALIBRATION */}
            {activeTab === "calibration" && (
              <form onSubmit={handleSaveCalibration} className="glass-panel" style={{ padding: "32px", display: "flex", flexDirection: "column", gap: "24px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid rgba(255,255,255,0.06)", paddingBottom: "16px" }}>
                  <h3 style={{ fontFamily: "var(--font-serif)", fontSize: "1.5rem", margin: 0 }}>Microfoon & Volume Kalibratie</h3>
                </div>

                {/* Calibration Sandbox Section */}
                <div style={{
                  padding: "24px",
                  backgroundColor: "rgba(255, 255, 255, 0.01)",
                  border: "1px solid rgba(255, 255, 255, 0.05)",
                  borderRadius: "16px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "20px"
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div>
                      <h4 style={{ margin: 0, fontSize: "1.05rem", fontWeight: "600", color: "#6366f1" }}>Multi-Clip Sandbox (Kalibratie Testomgeving)</h4>
                      <p style={{ margin: 0, fontSize: "0.75rem", color: "#aaaaaa" }}>Neem meerdere clips op en test direct hoe goed de classificatie reageert op de drempels.</p>
                    </div>
                    <button
                      type="button"
                      disabled={calibStatus.active && calibStatus.countdown > 0}
                      onClick={() => runManualCalib("test_clip")}
                      style={{
                        padding: "8px 16px",
                        borderRadius: "8px",
                        backgroundColor: "rgba(139, 92, 246, 0.1)",
                        border: "1px solid rgba(139, 92, 246, 0.25)",
                        color: "#c084fc",
                        fontWeight: "600",
                        fontSize: "0.85rem",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        transition: "all 0.2s"
                      }}
                    >
                      <span style={{ fontSize: "1.2rem" }}>🧪</span>
                      <span>Test Opname (Console Log)</span>
                    </button>
                  </div>

                  {/* Calibration Status HUD */}
                  {calibStatus.active && (
                    <div style={{
                      padding: "12px 16px",
                      backgroundColor: "rgba(255, 255, 255, 0.04)",
                      border: "1px solid rgba(255, 255, 255, 0.08)",
                      borderRadius: "8px",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center"
                    }}>
                      <span style={{ fontSize: "0.85rem", fontWeight: "600", color: "#a5e7fd" }}>
                        {calibStatus.text}
                      </span>
                      {calibStatus.countdown > 0 ? (
                        <span style={{ fontSize: "1.2rem", fontWeight: "800", color: "#f43f5e", animation: "pulse 1s infinite" }}>
                          {calibStatus.countdown}s
                        </span>
                      ) : (
                        <button 
                          type="button" 
                          onClick={() => setCalibStatus({ active: false, type: "", countdown: 0, text: "" })}
                          style={{
                            padding: "4px 10px",
                            fontSize: "0.75rem",
                            backgroundColor: "#10b981",
                            border: "none",
                            borderRadius: "4px",
                            color: "#fff",
                            cursor: "pointer",
                            fontWeight: "bold"
                          }}
                        >
                          Sluiten
                        </button>
                      )}
                    </div>
                  )}

                  {recordingCategory !== "" && (
                    <div style={{
                      padding: "16px",
                      backgroundColor: "rgba(239, 68, 68, 0.1)",
                      border: "1px solid rgba(239, 68, 68, 0.3)",
                      borderRadius: "8px",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center"
                    }}>
                      <span style={{ fontWeight: "bold", color: "#f87171" }}>
                        OPNEMEN ONDER CATEGORIE: {recordingCategory === "silence" ? "🤫 STILTE" : recordingCategory === "whisper" ? "💨 FLUISTERING" : "🗣️ GEWONE STEM"}
                      </span>
                      <span style={{ fontSize: "1.5rem", fontWeight: "900", color: "#f43f5e", animation: "pulse 1s infinite" }}>
                        {recordingCountdown}s
                      </span>
                    </div>
                  )}

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "16px" }}>
                    
                    {/* Category 1: Silence */}
                    <div style={{ display: "flex", flexDirection: "column", gap: "10px", backgroundColor: "rgba(0,0,0,0.15)", padding: "12px", borderRadius: "10px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ fontSize: "0.8rem", fontWeight: "bold", color: "#94a3b8" }}>🤫 Stilte Clips</span>
                        <button
                          type="button"
                          disabled={recordingCategory !== ""}
                          onClick={() => handleRecordSandboxClip("silence")}
                          style={{
                            padding: "4px 8px",
                            fontSize: "0.75rem",
                            backgroundColor: "rgba(148, 163, 184, 0.15)",
                            color: "#fff",
                            border: "none",
                            borderRadius: "4px",
                            cursor: "pointer"
                          }}
                        >
                          + Record
                        </button>
                      </div>
                      
                      <div style={{ display: "flex", flexDirection: "column", gap: "6px", maxHeight: "150px", overflowY: "auto" }}>
                        {sandboxClips.filter(c => c.category === "silence").map((clip, idx) => {
                          const cls = getClipClassification(clip);
                          const isCorrect = cls === "silence";
                          return (
                            <div key={clip.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", backgroundColor: "rgba(255,255,255,0.02)", padding: "6px 10px", borderRadius: "6px", border: "1px solid rgba(255,255,255,0.04)" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                <button type="button" onClick={() => handlePlaySandboxClip(clip)} style={{ background: "none", border: "none", color: "#38bdf8", cursor: "pointer", display: "flex", padding: 0 }}>
                                  <Play size={12} />
                                </button>
                                <span style={{ fontSize: "0.7rem", color: "#888" }}>Clip #{idx+1}</span>
                              </div>
                              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                <span style={{
                                  fontSize: "0.6rem",
                                  padding: "2px 6px",
                                  borderRadius: "10px",
                                  backgroundColor: isCorrect ? "rgba(16, 185, 129, 0.12)" : "rgba(239, 68, 68, 0.12)",
                                  color: isCorrect ? "#10b981" : "#ef4444",
                                  fontWeight: "bold"
                                }}>
                                  {isCorrect ? "Correct" : `Fout: ${cls}`}
                                </span>
                                <button type="button" onClick={() => handleDeleteSandboxClip(clip.id)} style={{ background: "none", border: "none", color: "#666", cursor: "pointer", display: "flex", padding: 0 }}>
                                  <Trash2 size={12} />
                                </button>
                              </div>
                            </div>
                          );
                        })}
                        {sandboxClips.filter(c => c.category === "silence").length === 0 && (
                          <span style={{ fontSize: "0.7rem", color: "#555", fontStyle: "italic", textAlign: "center", padding: "10px 0" }}>Geen clips</span>
                        )}
                      </div>
                    </div>

                    {/* Category 2: Whisper */}
                    <div style={{ display: "flex", flexDirection: "column", gap: "10px", backgroundColor: "rgba(0,0,0,0.15)", padding: "12px", borderRadius: "10px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ fontSize: "0.8rem", fontWeight: "bold", color: "#34d399" }}>💨 Fluister Clips</span>
                        <button
                          type="button"
                          disabled={recordingCategory !== ""}
                          onClick={() => handleRecordSandboxClip("whisper")}
                          style={{
                            padding: "4px 8px",
                            fontSize: "0.75rem",
                            backgroundColor: "rgba(16, 185, 129, 0.15)",
                            color: "#fff",
                            border: "none",
                            borderRadius: "4px",
                            cursor: "pointer"
                          }}
                        >
                          + Record
                        </button>
                      </div>
                      
                      <div style={{ display: "flex", flexDirection: "column", gap: "6px", maxHeight: "150px", overflowY: "auto" }}>
                        {sandboxClips.filter(c => c.category === "whisper").map((clip, idx) => {
                          const cls = getClipClassification(clip);
                          const isCorrect = cls === "whisper";
                          return (
                            <div key={clip.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", backgroundColor: "rgba(255,255,255,0.02)", padding: "6px 10px", borderRadius: "6px", border: "1px solid rgba(255,255,255,0.04)" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                <button type="button" onClick={() => handlePlaySandboxClip(clip)} style={{ background: "none", border: "none", color: "#38bdf8", cursor: "pointer", display: "flex", padding: 0 }}>
                                  <Play size={12} />
                                </button>
                                <span style={{ fontSize: "0.7rem", color: "#888" }}>Clip #{idx+1}</span>
                              </div>
                              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                <span style={{
                                  fontSize: "0.6rem",
                                  padding: "2px 6px",
                                  borderRadius: "10px",
                                  backgroundColor: isCorrect ? "rgba(16, 185, 129, 0.12)" : "rgba(239, 68, 68, 0.12)",
                                  color: isCorrect ? "#10b981" : "#ef4444",
                                  fontWeight: "bold"
                                }}>
                                  {isCorrect ? "Correct" : `Fout: ${cls}`}
                                </span>
                                <button type="button" onClick={() => handleDeleteSandboxClip(clip.id)} style={{ background: "none", border: "none", color: "#666", cursor: "pointer", display: "flex", padding: 0 }}>
                                  <Trash2 size={12} />
                                </button>
                              </div>
                            </div>
                          );
                        })}
                        {sandboxClips.filter(c => c.category === "whisper").length === 0 && (
                          <span style={{ fontSize: "0.7rem", color: "#555", fontStyle: "italic", textAlign: "center", padding: "10px 0" }}>Geen clips</span>
                        )}
                      </div>
                    </div>

                    {/* Category 3: Normal Talk */}
                    <div style={{ display: "flex", flexDirection: "column", gap: "10px", backgroundColor: "rgba(0,0,0,0.15)", padding: "12px", borderRadius: "10px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ fontSize: "0.8rem", fontWeight: "bold", color: "#f87171" }}>🗣️ Stem Clips</span>
                        <button
                          type="button"
                          disabled={recordingCategory !== ""}
                          onClick={() => handleRecordSandboxClip("voice")}
                          style={{
                            padding: "4px 8px",
                            fontSize: "0.75rem",
                            backgroundColor: "rgba(239, 68, 68, 0.15)",
                            color: "#fff",
                            border: "none",
                            borderRadius: "4px",
                            cursor: "pointer"
                          }}
                        >
                          + Record
                        </button>
                      </div>
                      
                      <div style={{ display: "flex", flexDirection: "column", gap: "6px", maxHeight: "150px", overflowY: "auto" }}>
                        {sandboxClips.filter(c => c.category === "voice").map((clip, idx) => {
                          const cls = getClipClassification(clip);
                          const isCorrect = cls === "talk";
                          return (
                            <div key={clip.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", backgroundColor: "rgba(255,255,255,0.02)", padding: "6px 10px", borderRadius: "6px", border: "1px solid rgba(255,255,255,0.04)" }}>
                              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                <button type="button" onClick={() => handlePlaySandboxClip(clip)} style={{ background: "none", border: "none", color: "#38bdf8", cursor: "pointer", display: "flex", padding: 0 }}>
                                  <Play size={12} />
                                </button>
                                <span style={{ fontSize: "0.7rem", color: "#888" }}>Clip #{idx+1}</span>
                              </div>
                              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                <span style={{
                                  fontSize: "0.6rem",
                                  padding: "2px 6px",
                                  borderRadius: "10px",
                                  backgroundColor: isCorrect ? "rgba(16, 185, 129, 0.12)" : "rgba(239, 68, 68, 0.12)",
                                  color: isCorrect ? "#10b981" : "#ef4444",
                                  fontWeight: "bold"
                                }}>
                                  {isCorrect ? "Correct" : `Fout: ${cls}`}
                                </span>
                                <button type="button" onClick={() => handleDeleteSandboxClip(clip.id)} style={{ background: "none", border: "none", color: "#666", cursor: "pointer", display: "flex", padding: 0 }}>
                                  <Trash2 size={12} />
                                </button>
                              </div>
                            </div>
                          );
                        })}
                        {sandboxClips.filter(c => c.category === "voice").length === 0 && (
                          <span style={{ fontSize: "0.7rem", color: "#555", fontStyle: "italic", textAlign: "center", padding: "10px 0" }}>Geen clips</span>
                        )}
                      </div>
                    </div>

                  </div>

                  {sandboxClips.length > 0 && (
                    <div style={{
                      padding: "16px",
                      borderRadius: "8px",
                      backgroundColor: sandboxClips.every(c => {
                        const cls = getClipClassification(c);
                        return cls === (c.category === "voice" ? "talk" : c.category);
                      }) ? "rgba(16, 185, 129, 0.08)" : "rgba(245, 158, 11, 0.08)",
                      border: "1px solid " + (sandboxClips.every(c => {
                        const cls = getClipClassification(c);
                        return cls === (c.category === "voice" ? "talk" : c.category);
                      }) ? "rgba(16, 185, 129, 0.2)" : "rgba(245, 158, 11, 0.2)"),
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center"
                    }}>
                      <span style={{ fontSize: "0.8rem", color: "#e2e8f0" }}>
                        {sandboxClips.every(c => {
                          const cls = getClipClassification(c);
                          return cls === (c.category === "voice" ? "talk" : c.category);
                        }) ? (
                          <span>🎉 <strong>Alle {sandboxClips.length} clips</strong> worden correct geclassificeerd!</span>
                        ) : (
                          <span>⚠️ Sommige clips falen onder de huidige drempelwaardes. Klik op <strong>Auto-Tweak</strong> om ze te optimaliseren.</span>
                        )}
                      </span>
                      <button
                        type="button"
                        onClick={() => optimizeThresholds(sandboxClips)}
                        style={{
                          padding: "6px 14px",
                          backgroundColor: "#6366f1",
                          color: "#fff",
                          border: "none",
                          borderRadius: "6px",
                          fontWeight: "bold",
                          fontSize: "0.75rem",
                          cursor: "pointer"
                        }}
                      >
                        Auto-Tweak Drempels
                      </button>
                    </div>
                  )}
                </div>

                {/* Status Badge */}
                <div style={{ 
                  display: "flex", 
                  alignItems: "center", 
                  justifyContent: "space-between", 
                  backgroundColor: "rgba(255,255,255,0.02)", 
                  padding: "20px", 
                  borderRadius: "16px", 
                  border: "1px solid rgba(255,255,255,0.08)",
                  boxShadow: "inset 0 0 20px rgba(255,255,255,0.01)"
                }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                    <span style={{ fontSize: "0.85rem", color: "#ffffff", fontWeight: "600" }}>Live Classificatie Status</span>
                    <span style={{ fontSize: "0.72rem", color: "#888888" }}>Wat de microfoon momenteel hoort:</span>
                  </div>
                  {(() => {
                    if (liveStatus === "silence") {
                      return (
                        <div style={{
                          display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px"
                        }}>
                          <div style={{
                            display: "flex", alignItems: "center", gap: "8px", padding: "8px 20px", borderRadius: "24px", fontSize: "0.85rem", fontWeight: "700",
                            backgroundColor: "rgba(100, 116, 139, 0.08)", border: "1px solid rgba(100, 116, 139, 0.2)", color: "#94a3b8",
                            boxShadow: "0 0 10px rgba(100, 116, 139, 0.05)"
                          }}>
                            <span style={{ width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#94a3b8", animation: "pulse 2s infinite" }} />
                            <span>STILTE / SILENCE</span>
                          </div>
                          <span style={{ fontSize: "0.68rem", color: "#64748b", fontStyle: "italic" }}>Geluidsniveau onder drempelwaarde</span>
                        </div>
                      );
                    }
                    if (liveStatus === "normal") {
                      return (
                        <div style={{
                          display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px"
                        }}>
                          <div style={{
                            display: "flex", alignItems: "center", gap: "8px", padding: "8px 20px", borderRadius: "24px", fontSize: "0.85rem", fontWeight: "700",
                            backgroundColor: "rgba(239, 68, 68, 0.1)", border: "1px solid rgba(239, 68, 68, 0.4)", color: "#ef4444",
                            boxShadow: "0 0 15px rgba(239, 68, 68, 0.15)"
                          }}>
                            <span style={{ width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#ef4444" }} />
                            <span>GEWONE STEM / NORMAL VOICE</span>
                          </div>
                          <span style={{ fontSize: "0.68rem", color: "#f87171", fontWeight: "500" }}>Te luid! Klinker-periodiciteit / stembandtrilling gedetecteerd</span>
                        </div>
                      );
                    }
                    if (liveStatus === "whisper") {
                      return (
                        <div style={{
                          display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px"
                        }}>
                          <div style={{
                            display: "flex", alignItems: "center", gap: "8px", padding: "8px 20px", borderRadius: "24px", fontSize: "0.85rem", fontWeight: "700",
                            backgroundColor: "rgba(16, 185, 129, 0.12)", border: "1px solid rgba(16, 185, 129, 0.45)", color: "#10b981",
                            boxShadow: "0 0 20px rgba(16, 185, 129, 0.3)"
                          }}>
                            <span style={{ width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#10b981" }} />
                            <span>GELDIGE FLUISTER / VALID WHISPER</span>
                          </div>
                          <span style={{ fontSize: "0.68rem", color: "#34d399", fontWeight: "500" }}>Perfect! Hoge wrijvingsklank zonder stembandtrilling</span>
                        </div>
                      );
                    }
                    return (
                      <div style={{
                        display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px"
                      }}>
                        <div style={{
                          display: "flex", alignItems: "center", gap: "8px", padding: "8px 20px", borderRadius: "24px", fontSize: "0.85rem", fontWeight: "700",
                          backgroundColor: "rgba(245, 158, 11, 0.1)", border: "1px solid rgba(245, 158, 11, 0.35)", color: "#f59e0b",
                          boxShadow: "0 0 12px rgba(245, 158, 11, 0.15)"
                        }}>
                          <span style={{ width: "8px", height: "8px", borderRadius: "50%", backgroundColor: "#f59e0b" }} />
                          <span>RUIS OF ANDER GELUID / OTHER NOISE</span>
                        </div>
                        <span style={{ fontSize: "0.68rem", color: "#fbbf24", fontStyle: "italic" }}>Omgevingsgeluid, blazen of onduidelijke frequenties</span>
                      </div>
                    );
                  })()}
                </div>

                {/* Canvas visualizer */}
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  <label style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "#aaaaaa", fontWeight: "600" }}>
                    Frequentie Spectrogram Zoom (0Hz - 6000Hz)
                  </label>
                  <div style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: "12px", overflow: "hidden", backgroundColor: "#121212" }}>
                    <canvas 
                      ref={canvasRef} 
                      width={600} 
                      height={160} 
                      style={{ display: "block", width: "100%", height: "160px" }}
                    />
                  </div>
                </div>

                {/* Live Diagnostic Telemetry Math Panel */}
                <div className="glass-panel" style={{
                  padding: "20px",
                  backgroundColor: "rgba(255, 255, 255, 0.01)",
                  border: "1px solid rgba(255, 255, 255, 0.05)",
                  borderRadius: "12px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "12px"
                }}>
                  <span style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "#38bdf8", fontWeight: "bold" }}>
                    Smarter Whisper Logic - Real-time Telemetrie (Formule Diagnostiek)
                  </span>
                  
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr", gap: "16px", fontSize: "0.8rem" }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: "8px", borderRight: "1px solid rgba(255,255,255,0.06)", paddingRight: "16px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <span style={{ color: "#888888" }}>Hoge Band Gem. (600-4000Hz):</span>
                        <span style={{ fontWeight: "bold", color: "#10b981" }}>{liveHighAvgState.toFixed(1)}</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <span style={{ color: "#888888" }}>Achtergrondruis (Hoge Band):</span>
                        <span style={{ color: "#64748b" }}>-{liveHighNoiseState.toFixed(1)}</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px dashed rgba(255,255,255,0.08)", paddingTop: "4px" }}>
                        <span style={{ color: "#aaa" }}>Hoge Actieve Signaal:</span>
                        <span style={{ fontWeight: "bold", color: "#10b981" }}>{(Math.max(0.01, liveHighAvgState - liveHighNoiseState)).toFixed(1)}</span>
                      </div>
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <span style={{ color: "#888888" }}>Lage Band Gem. (80-400Hz):</span>
                        <span style={{ fontWeight: "bold", color: "#ef4444" }}>{liveLowAvgState.toFixed(1)}</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <span style={{ color: "#888888" }}>Achtergrondruis (Lage Band):</span>
                        <span style={{ color: "#64748b" }}>-{liveLowNoiseState.toFixed(1)}</span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px dashed rgba(255,255,255,0.08)", paddingTop: "4px" }}>
                        <span style={{ color: "#aaa" }}>Lage Actieve Signaal:</span>
                        <span style={{ fontWeight: "bold", color: "#ef4444" }}>{(Math.max(0.01, liveLowAvgState - liveLowNoiseState)).toFixed(1)}</span>
                      </div>
                    </div>
                  </div>

                  <div style={{
                    borderTop: "1px solid rgba(255,255,255,0.06)",
                    paddingTop: "10px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    fontSize: "0.85rem",
                    color: "#e2e8f0"
                  }}>
                    <span>Actieve Spectrale Ratio Berekening:</span>
                    <span style={{ fontFamily: "monospace", padding: "4px 10px", backgroundColor: "rgba(0,0,0,0.2)", borderRadius: "4px", border: "1px solid rgba(255,255,255,0.06)" }}>
                      {(Math.max(0.01, liveHighAvgState - liveHighNoiseState)).toFixed(1)} / {(Math.max(0.01, liveLowAvgState - liveLowNoiseState)).toFixed(1)} = <strong style={{ color: liveRatio >= (settings.calibration?.whisper_ratio_threshold || 1.80) ? "#10b981" : "#ef4444", fontSize: "0.95rem" }}>{liveRatio.toFixed(2)}</strong>
                    </span>
                  </div>
                </div>

                {/* Numerical Level Bars Grid */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "20px" }}>
                  
                  {/* 1. Live Volume (RMS) */}
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    <label style={{ fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.03em", color: "#888888" }}>
                      Live Volume (RMS)
                    </label>
                    <div style={{ height: "12px", width: "100%", backgroundColor: "#1e1e1e", borderRadius: "6px", overflow: "hidden", position: "relative", border: "1px solid rgba(255,255,255,0.08)" }}>
                      <div style={{
                        height: "100%",
                        width: `${Math.min(100, liveVolume * 800)}%`, // Scale 0 to 0.125 to 100%
                        backgroundColor: liveVolume >= (settings.calibration?.silence_threshold || 0.005) ? "#10b981" : "#888888",
                        transition: "width 0.05s ease-out"
                      }} />
                      {/* Visual Threshold line */}
                      <div style={{
                        position: "absolute",
                        left: `${Math.min(99, (settings.calibration?.silence_threshold || 0.005) * 800)}%`,
                        top: 0,
                        bottom: 0,
                        width: "2px",
                        backgroundColor: "#ffffff",
                        boxShadow: "0 0 4px #fff",
                        zIndex: 10
                      }} />
                    </div>
                    <span style={{ fontSize: "10px", color: "#666666", display: "flex", justifyContent: "space-between" }}>
                      <span>Val: {liveVolume.toFixed(4)}</span>
                      <span>Drempel: {(parseFloat(settings.calibration?.silence_threshold) || 0.005).toFixed(4)}</span>
                    </span>
                  </div>

                  {/* 2. Live Whisper Ratio */}
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    <label style={{ fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.03em", color: "#888888" }}>
                      Smarter Whisper Ratio (Actief)
                    </label>
                    <div style={{ height: "12px", width: "100%", backgroundColor: "#1e1e1e", borderRadius: "6px", overflow: "hidden", position: "relative", border: "1px solid rgba(255,255,255,0.08)" }}>
                      <div style={{
                        height: "100%",
                        width: `${Math.min(100, (liveRatio / 5.0) * 100)}%`, // Scale 0 to 5.0 to 100%
                        backgroundColor: liveVolume < (settings.calibration?.silence_threshold || 0.005) ? "#333333" : 
                          liveRatio >= (settings.calibration?.whisper_ratio_threshold || 1.80) ? "#10b981" : "#ef4444",
                        transition: "width 0.05s ease-out"
                      }} />
                      {/* Visual Threshold line */}
                      <div style={{
                        position: "absolute",
                        left: `${Math.min(99, ((settings.calibration?.whisper_ratio_threshold || 1.80) / 5.0) * 100)}%`,
                        top: 0,
                        bottom: 0,
                        width: "2px",
                        backgroundColor: "#ffffff",
                        boxShadow: "0 0 4px #fff",
                        zIndex: 10
                      }} />
                    </div>
                    <span style={{ fontSize: "10px", color: "#666666", display: "flex", justifyContent: "space-between" }}>
                      <span>Ratio: {liveRatio.toFixed(2)}</span>
                      <span>Drempel: {(parseFloat(settings.calibration?.whisper_ratio_threshold) || 1.80).toFixed(2)}</span>
                    </span>
                  </div>

                  {/* 3. Live Voicing Periodicity */}
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    <label style={{ fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.03em", color: "#888888" }}>
                      Stem Periodiciteit (Pitch)
                    </label>
                    <div style={{ height: "12px", width: "100%", backgroundColor: "#1e1e1e", borderRadius: "6px", overflow: "hidden", position: "relative", border: "1px solid rgba(255,255,255,0.08)" }}>
                      <div style={{
                        height: "100%",
                        width: `${Math.min(100, liveVoicing * 100)}%`, // Scale 0 to 1.0 to 100%
                        backgroundColor: liveVolume < (settings.calibration?.silence_threshold || 0.005) ? "#333333" : 
                          liveVoicing >= (settings.calibration?.voicing_threshold !== undefined ? settings.calibration.voicing_threshold : 0.30) ? "#ef4444" : "#10b981",
                        transition: "width 0.05s ease-out"
                      }} />
                      {/* Visual Threshold line */}
                      <div style={{
                        position: "absolute",
                        left: `${Math.min(99, (settings.calibration?.voicing_threshold !== undefined ? settings.calibration.voicing_threshold : 0.30) * 100)}%`,
                        top: 0,
                        bottom: 0,
                        width: "2px",
                        backgroundColor: "#ffffff",
                        boxShadow: "0 0 4px #fff",
                        zIndex: 10
                      }} />
                    </div>
                    <span style={{ fontSize: "10px", color: "#666666", display: "flex", justifyContent: "space-between" }}>
                      <span>Pitch: {liveVoicing.toFixed(3)}</span>
                      <span>Drempel: {(settings.calibration?.voicing_threshold !== undefined ? settings.calibration.voicing_threshold : 0.30).toFixed(2)}</span>
                    </span>
                  </div>

                </div>

                {/* Sliders Grid Section */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px", marginTop: "12px" }}>
                  
                  {/* Whisper Ratio Threshold Slider with Live Track Marker */}
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    <label style={{ fontSize: "0.75rem", color: "#888888", fontWeight: "600" }}>FLUISTER GRENS THRESHOLD (WHISPER SPECTRAL RATIO)</label>
                    <div style={{ position: "relative", width: "100%" }}>
                      <input 
                        type="range" 
                        min="0.50" 
                        max="6.00" 
                        step="0.05"
                        value={settings.calibration?.whisper_ratio_threshold || 1.80}
                        onChange={(e) => setSettings(prev => ({
                          ...prev,
                          calibration: {
                            ...prev.calibration,
                            whisper_ratio_threshold: parseFloat(e.target.value)
                          }
                        }))}
                        onPointerUp={() => settingsService.saveSettings(settings)}
                        style={{ cursor: "pointer", width: "100%", margin: 0 }}
                      />
                      {/* Real-time Indicator Line */}
                      <div style={{ height: "4px", width: "100%", backgroundColor: "rgba(255,255,255,0.04)", borderRadius: "2px", position: "relative", marginTop: "4px" }}>
                        <div style={{
                          position: "absolute",
                          left: `${Math.min(99, Math.max(0, ((liveRatio - 0.50) / 5.50) * 100))}%`,
                          width: "8px",
                          height: "8px",
                          borderRadius: "50%",
                          backgroundColor: "#34d399",
                          boxShadow: "0 0 8px #34d399",
                          transform: "translate(-50%, -2px)",
                          transition: "left 0.05s ease-out"
                        }} />
                      </div>
                    </div>
                    <span style={{ fontSize: "0.7rem", color: "#888888" }}>
                      Verhouding van hoge/lage frequentie. Whispers hebben weinig lage tonen en dus een hogere ratio. Pas handmatig aan of gebruik de auto-wizard.
                    </span>
                  </div>

                  {/* Voicing Periodicity Threshold Slider with Live Track Marker */}
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    <label style={{ fontSize: "0.75rem", color: "#888888", fontWeight: "600" }}>STEM PERIODICITEITSDREMPEL (VOICING THRESHOLD)</label>
                    <div style={{ position: "relative", width: "100%" }}>
                      <input 
                        type="range" 
                        min="0.05" 
                        max="0.80" 
                        step="0.01"
                        value={settings.calibration?.voicing_threshold !== undefined ? settings.calibration.voicing_threshold : 0.28}
                        onChange={(e) => setSettings(prev => ({
                          ...prev,
                          calibration: {
                            ...prev.calibration,
                            voicing_threshold: parseFloat(e.target.value)
                          }
                        }))}
                        onPointerUp={() => settingsService.saveSettings(settings)}
                        style={{ cursor: "pointer", width: "100%", margin: 0 }}
                      />
                      {/* Real-time Indicator Line */}
                      <div style={{ height: "4px", width: "100%", backgroundColor: "rgba(255,255,255,0.04)", borderRadius: "2px", position: "relative", marginTop: "4px" }}>
                        <div style={{
                          position: "absolute",
                          left: `${Math.min(99, Math.max(0, ((liveVoicing - 0.05) / 0.75) * 100))}%`,
                          width: "8px",
                          height: "8px",
                          borderRadius: "50%",
                          backgroundColor: "#f87171",
                          boxShadow: "0 0 8px #f87171",
                          transform: "translate(-50%, -2px)",
                          transition: "left 0.05s ease-out"
                        }} />
                      </div>
                    </div>
                    <span style={{ fontSize: "0.7rem", color: "#888888" }}>
                      Drempelwaarde voor periodiciteit (stemhebbendheid). Normaal praten zit meestal boven 0.30, fluisteren en ruis eronder. Drag om periodiciteit af te keuren.
                    </span>
                  </div>

                  {/* Minimum Record Duration Input */}
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    <label style={{ fontSize: "0.75rem", color: "#888888", fontWeight: "600" }}>MINIMALE GELUID DUUR (SECONDEN)</label>
                    <input 
                      type="number"
                      min="0.2"
                      max="3.0"
                      step="0.1"
                      value={settings.calibration?.min_record_duration !== undefined ? settings.calibration.min_record_duration : 0.6}
                      onChange={(e) => setSettings(prev => ({
                        ...prev,
                        calibration: {
                          ...prev.calibration,
                          min_record_duration: parseFloat(e.target.value)
                        }
                      }))}
                      style={{ padding: "8px", backgroundColor: "#1e1e1e", border: "1px solid rgba(255,255,255,0.1)", color: "#fff", borderRadius: "6px" }}
                    />
                    <span style={{ fontSize: "0.7rem", color: "#888888" }}>
                      Opnames korter dan dit worden direct genegeerd (stille kliks/tikken) en keren automatisch terug naar het welkomstscherm.
                    </span>
                  </div>

                  {/* Silence Threshold Slider with Live Track Marker */}
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    <label style={{ fontSize: "0.75rem", color: "#888888", fontWeight: "600" }}>STILTE GRENS THRESHOLD (MINIMUM VOLUME)</label>
                    <div style={{ position: "relative", width: "100%" }}>
                      <input 
                        type="range" 
                        min="0.001" 
                        max="0.050" 
                        step="0.001"
                        value={settings.calibration?.silence_threshold || 0.005}
                        onChange={(e) => setSettings(prev => ({
                          ...prev,
                          calibration: {
                            ...prev.calibration,
                            silence_threshold: parseFloat(e.target.value)
                          }
                        }))}
                        onPointerUp={() => settingsService.saveSettings(settings)}
                        style={{ cursor: "pointer", width: "100%", margin: 0 }}
                      />
                      {/* Real-time Indicator Line */}
                      <div style={{ height: "4px", width: "100%", backgroundColor: "rgba(255,255,255,0.04)", borderRadius: "2px", position: "relative", marginTop: "4px" }}>
                        <div style={{
                          position: "absolute",
                          left: `${Math.min(99, Math.max(0, ((liveVolume - 0.001) / 0.029) * 100))}%`,
                          width: "8px",
                          height: "8px",
                          borderRadius: "50%",
                          backgroundColor: "#38bdf8",
                          boxShadow: "0 0 8px #38bdf8",
                          transform: "translate(-50%, -2px)",
                          transition: "left 0.05s ease-out"
                        }} />
                      </div>
                    </div>
                    <span style={{ fontSize: "0.7rem", color: "#888888" }}>
                      Minimum volume (RMS) dat nodig is om geluid te registreren. Alles hieronder wordt genegeerd als stilte.
                    </span>
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    <label style={{ fontSize: "0.75rem", color: "#888888", fontWeight: "600" }}>MAX OPNAME LENGTE (SECONDEN)</label>
                    <input 
                      type="number"
                      min="1.0"
                      max="10.0"
                      step="0.5"
                      value={settings.calibration?.max_record_duration || 3.0}
                      onChange={(e) => setSettings(prev => ({
                        ...prev,
                        calibration: {
                          ...prev.calibration,
                          max_record_duration: parseFloat(e.target.value)
                        }
                      }))}
                      style={{ padding: "8px", backgroundColor: "#1e1e1e", border: "1px solid rgba(255,255,255,0.1)", color: "#fff", borderRadius: "6px" }}
                    />
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    <label style={{ fontSize: "0.75rem", color: "#888888", fontWeight: "600" }}>TE LUID AFWIJZING TIMEOUT (SECONDEN)</label>
                    <input 
                      type="number"
                      min="1.0"
                      max="10.0"
                      step="0.5"
                      value={settings.calibration?.no_whisper_timeout || 3.0}
                      onChange={(e) => setSettings(prev => ({
                        ...prev,
                        calibration: {
                          ...prev.calibration,
                          no_whisper_timeout: parseFloat(e.target.value)
                        }
                      }))}
                      style={{ padding: "8px", backgroundColor: "#1e1e1e", border: "1px solid rgba(255,255,255,0.1)", color: "#fff", borderRadius: "6px" }}
                    />
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    <label style={{ fontSize: "0.75rem", color: "#888888", fontWeight: "600" }}>SUCCES SCHERM DUUR (SECONDEN)</label>
                    <input 
                      type="number"
                      min="0.5"
                      max="10.0"
                      step="0.5"
                      value={settings.calibration?.success_screen_duration || 2.0}
                      onChange={(e) => setSettings(prev => ({
                        ...prev,
                        calibration: {
                          ...prev.calibration,
                          success_screen_duration: parseFloat(e.target.value)
                        }
                      }))}
                      style={{ padding: "8px", backgroundColor: "#1e1e1e", border: "1px solid rgba(255,255,255,0.1)", color: "#fff", borderRadius: "6px" }}
                    />
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    <label style={{ fontSize: "0.75rem", color: "#888888", fontWeight: "600" }}>ACHTERGROND FLUISTER MIN WACHTTIJD (SEC)</label>
                    <input 
                      type="number"
                      min="0.1"
                      max="10.0"
                      step="0.1"
                      value={settings.calibration?.bg_whisper_min_wait || 0.5}
                      onChange={(e) => setSettings(prev => ({
                        ...prev,
                        calibration: {
                          ...prev.calibration,
                          bg_whisper_min_wait: parseFloat(e.target.value)
                        }
                      }))}
                      style={{ padding: "8px", backgroundColor: "#1e1e1e", border: "1px solid rgba(255,255,255,0.1)", color: "#fff", borderRadius: "6px" }}
                    />
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    <label style={{ fontSize: "0.75rem", color: "#888888", fontWeight: "600" }}>ACHTERGROND FLUISTER MAX WACHTTIJD (SEC)</label>
                    <input 
                      type="number"
                      min="0.5"
                      max="20.0"
                      step="0.5"
                      value={settings.calibration?.bg_whisper_max_wait || 3.0}
                      onChange={(e) => setSettings(prev => ({
                        ...prev,
                        calibration: {
                          ...prev.calibration,
                          bg_whisper_max_wait: parseFloat(e.target.value)
                        }
                      }))}
                      style={{ padding: "8px", backgroundColor: "#1e1e1e", border: "1px solid rgba(255,255,255,0.1)", color: "#fff", borderRadius: "6px" }}
                    />
                  </div>
                </div>

                <button type="submit" className="btn-premium" style={{ alignSelf: "flex-end" }}>
                  <span>Opslaan</span>
                </button>
              </form>
            )}

            {/* TAB 4: STATE SCREEN TEXTS & COLORS */}
            {activeTab === "texts" && (
              <form onSubmit={handleSaveTexts} className="glass-panel" style={{ padding: "32px", display: "flex", flexDirection: "column", gap: "24px" }}>
                <h3 style={{ fontFamily: "var(--font-serif)", fontSize: "1.5rem" }}>Scherm Prompts & Kleuren Aanpassen</h3>

                <div style={{ display: "flex", gap: "12px", borderBottom: "1px solid rgba(255,255,255,0.06)", paddingBottom: "16px" }}>
                  <select 
                    value={selectedTextState} 
                    onChange={(e) => setSelectedTextState(e.target.value)}
                    style={{ padding: "10px", backgroundColor: "#1c1c1c", color: "#fff", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "6px", fontSize: "0.85rem", width: "100%", maxWidth: "320px", cursor: "pointer" }}
                  >
                    <option value="initial_message">Idle / Welkomstscherm</option>
                    <option value="whisper_prompt">Opname Bezig Prompt</option>
                    <option value="checking_audio">Audio Controleren</option>
                    <option value="whisper_thank_you">Keuzescherm (1 klik opslaan / 2 klik verwijderen)</option>
                    <option value="whisper_sent">Succesbericht (Opgeslagen)</option>
                    <option value="retry_prompt">Dubbelklik Afgewezen Scherm</option>
                    <option value="no_whisper">Volume Te Luid Afgewezen Scherm</option>
                  </select>
                </div>

                {/* Edit Form for selected state */}
                {(() => {
                  let textKey = `${selectedTextState}_text`;
                  let colorKey = `${selectedTextState}_color`;
                  if (selectedTextState === "no_whisper") {
                    textKey = "no_whisper_detected_text";
                    colorKey = "no_whisper_color";
                  }

                  const promptVal = settings.texts?.[textKey] || "";
                  const rgbArr = settings.texts?.[colorKey] || [255, 255, 255];
                  const hexVal = rgbToHex(rgbArr);

                  return (
                    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
                      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                        <label style={{ fontSize: "0.75rem", color: "#888888", fontWeight: "600" }}>SCHERM TEKST (GEBRUIK ENTER VOOR NIEUWE REGELS)</label>
                        <textarea 
                          rows={6}
                          value={promptVal}
                          onChange={(e) => handleUpdateTextValue(textKey, e.target.value)}
                          style={{ width: "100%", padding: "12px", backgroundColor: "#181818", border: "1px solid rgba(255,255,255,0.1)", color: "#fff", borderRadius: "8px", fontSize: "0.95rem", lineHeight: "1.4", resize: "vertical" }}
                        />
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                          <label style={{ fontSize: "0.75rem", color: "#888888", fontWeight: "600" }}>NEON TEKSTKLEUR</label>
                          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                            <input 
                              type="color" 
                              value={hexVal}
                              onChange={(e) => {
                                const newRgb = hexToRgb(e.target.value);
                                handleUpdateTextValue(colorKey, newRgb);
                              }}
                              style={{ width: "42px", height: "42px", border: "none", borderRadius: "50%", cursor: "pointer", backgroundColor: "transparent" }}
                            />
                            <span style={{ fontFamily: "monospace", fontSize: "0.85rem", color: "#ccc" }}>
                              RGB: [{rgbArr.join(", ")}]
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })()}

                <button type="submit" className="btn-premium" style={{ alignSelf: "flex-end" }}>
                  <span>Opslaan</span>
                </button>
              </form>
            )}

            {/* TAB 5: FIREBASE SETUP CONNECTION OVERRIDE */}
            {activeTab === "firebase" && (
              <div className="glass-panel" style={{ padding: "32px", display: "flex", flexDirection: "column", gap: "24px" }}>
                <div>
                  <h3 style={{ fontFamily: "var(--font-serif)", fontSize: "1.5rem", marginBottom: "6px" }}>Firebase Database Koppeling</h3>
                  <p style={{ fontSize: "0.75rem", color: "#888888" }}>
                    Sluit deze installatie gratis aan op Firestore & Cloud Storage om opgenomen whispers op te slaan en op meerdere computers af te spelen.
                  </p>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  <label style={{ fontSize: "0.75rem", color: "#888888", fontWeight: "600" }}>PLAK HIER FIREBASE WEB APP SDK CONFIG OBJECT (JSON)</label>
                  <textarea
                    rows={8}
                    value={rawConfigInput}
                    onChange={(e) => setRawConfigInput(e.target.value)}
                    placeholder={`{\n  "apiKey": "AIzaSy...",\n  "authDomain": "...",\n  "projectId": "...",\n  "storageBucket": "...",\n  "appId": "..."\n}`}
                    style={{ width: "100%", padding: "12px", backgroundColor: "#181818", border: "1px solid rgba(255,255,255,0.1)", color: "#fff", borderRadius: "8px", fontFamily: "monospace", fontSize: "0.8rem" }}
                  />
                  <span style={{ fontSize: "11px", color: "#888888", lineHeight: "1.4" }}>
                    * Plak de JSON rechtstreeks uit de Firebase console (Settings → Project Settings → Web Apps → SDK setup and configuration).<br />
                    * Als u dit leegmaakt en toepast, draait de site direct terug in <strong>Mock Modus</strong> (LocalStorage).
                  </span>
                </div>

                <div style={{ display: "flex", gap: "12px" }}>
                  <button type="button" onClick={handleApplyFirebaseJSON} className="btn-premium">
                    <span>Configuratie Toepassen</span>
                  </button>
                  {rawConfigInput && (
                    <button type="button" onClick={() => window.location.reload()} className="btn-premium" style={{ borderColor: "rgba(16, 185, 129, 0.4)", color: "#10b981" }}>
                      <RefreshCw size={12} />
                      <span>Herlaad Pagina</span>
                    </button>
                  )}
                </div>
              </div>
            )}
          </section>
        </main>
      )}
    </div>
  );
};

export default AdminPanel;
