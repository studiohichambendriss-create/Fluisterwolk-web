import React, { useState, useEffect, useRef } from "react";
import { authService, dbService, storageService, settingsService, DEFAULT_SETTINGS, isMockMode } from "../firebase";
import { Lock, Mail, Play, Trash2, ArrowLeft, Download, LogOut, CheckCircle, AlertTriangle, ShieldCheck, Sliders, Type, Database, RefreshCw, Undo2 } from "lucide-react";

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
  const [rawConfigInput, setRawConfigInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [playingId, setPlayingId] = useState(null);
  const [actionMessage, setActionMessage] = useState("");

  // Live Mic Monitor
  const [liveVolume, setLiveVolume] = useState(0);
  const liveAudioCtxRef = useRef(null);
  const liveAnalyserRef = useRef(null);
  const liveStreamRef = useRef(null);
  const liveAnimFrameRef = useRef(null);

  // Active state texts editing state
  const [selectedTextState, setSelectedTextState] = useState("initial_message");

  useEffect(() => {
    const unsubscribe = authService.onAuthChange((currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        loadData();
      }
    });
    return () => unsubscribe && unsubscribe();
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

  const loadData = async () => {
    setIsLoading(true);
    try {
      const activeData = await dbService.getWhispers();
      const activeSorted = [...activeData].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      setWhispers(activeSorted);

      const trashData = await dbService.getDeletedWhispers();
      const trashSorted = [...trashData].sort((a, b) => new Date(b.deletedAt || b.timestamp) - new Date(a.deletedAt || a.timestamp));
      setDeletedWhispers(trashSorted);

      const currentSettings = await settingsService.getSettings();
      setSettings(currentSettings);

      // Load cached raw config if any
      const savedConfig = localStorage.getItem("fluisterwolk_firebase_config");
      if (savedConfig) {
        setRawConfigInput(JSON.stringify(JSON.parse(savedConfig), null, 2));
      }
    } catch (e) {
      console.error("Failed to load admin data:", e);
    }
    setIsLoading(false);
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginError("");
    try {
      await authService.loginAdmin(email, password);
    } catch (err) {
      setLoginError(err.message || "Fout bij inloggen.");
    }
  };

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
    audio.volume = 1.0;
    setPlayingId(whisper.id);
    
    audio.play().catch(e => {
      console.error("Audio blocked:", e);
      setPlayingId(null);
    });
    
    audio.onended = () => {
      setPlayingId(null);
    };
  };

  const startLiveMonitor = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      liveStreamRef.current = stream;

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx();
      liveAudioCtxRef.current = ctx;

      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      liveAnalyserRef.current = analyser;

      const update = () => {
        if (!liveAnalyserRef.current) return;
        const array = new Uint8Array(liveAnalyserRef.current.fftSize);
        liveAnalyserRef.current.getByteTimeDomainData(array);
        let sum = 0;
        for (let i = 0; i < array.length; i++) {
          const val = (array[i] - 128) / 128;
          sum += val * val;
        }
        const rms = Math.sqrt(sum / array.length);
        setLiveVolume(rms);
        liveAnimFrameRef.current = requestAnimationFrame(update);
      };
      update();
    } catch (e) {
      console.warn("Live monitoring mic blocked:", e);
    }
  };

  const stopLiveMonitor = () => {
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
                            <th>Tijdstip</th>
                            <th>Naam / Tekst</th>
                            <th>Type</th>
                            <th style={{ textAlign: "center" }}>Beluisteren</th>
                            <th style={{ textAlign: "right" }}>Verplaatsen</th>
                          </tr>
                        </thead>
                        <tbody>
                          {whispers.map((whisper) => (
                            <tr key={whisper.id}>
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
                          ))}
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
                <h3 style={{ fontFamily: "var(--font-serif)", fontSize: "1.5rem" }}>Microfoon & Volume Kalibratie</h3>
                
                {/* Live visual mic level */}
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  <label style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", color: "#888888" }}>Live Microfoon Niveau</label>
                  <div style={{ height: "18px", width: "100%", backgroundColor: "#1e1e1e", borderRadius: "9px", overflow: "hidden", position: "relative", border: "1px solid rgba(255,255,255,0.1)" }}>
                    <div style={{
                      height: "100%",
                      width: `${Math.min(100, liveVolume * 400)}%`,
                      backgroundColor: liveVolume > (settings.calibration?.whisper_threshold_value || 0.038) ? "#ef4444" : "#10b981",
                      transition: "width 0.08s ease-out"
                    }} />
                    {/* Visual Threshold line */}
                    <div style={{
                      position: "absolute",
                      left: `${(settings.calibration?.whisper_threshold_value || 0.038) * 400}%`,
                      top: 0,
                      bottom: 0,
                      width: "2px",
                      backgroundColor: "#ffffff",
                      boxShadow: "0 0 4px #fff",
                      zIndex: 10
                    }} />
                  </div>
                  <span style={{ fontSize: "11px", color: "#888888", display: "flex", justifyContent: "space-between" }}>
                    <span>RMS Volume: {liveVolume.toFixed(4)}</span>
                    <span>Huidige Drempelwaarde (Witte lijn): {(parseFloat(settings.calibration?.whisper_threshold_value) || 0.038).toFixed(4)}</span>
                  </span>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    <label style={{ fontSize: "0.75rem", color: "#888888", fontWeight: "600" }}>FLUISTER DREMPEL (RMS THRESHOLD)</label>
                    <input 
                      type="range" 
                      min="0.001" 
                      max="0.150" 
                      step="0.001"
                      value={settings.calibration?.whisper_threshold_value || 0.038}
                      onChange={(e) => setSettings(prev => ({
                        ...prev,
                        calibration: {
                          ...prev.calibration,
                          whisper_threshold_value: parseFloat(e.target.value)
                        }
                      }))}
                      style={{ cursor: "pointer", width: "100%" }}
                    />
                    <span style={{ fontSize: "0.7rem", color: "#888888" }}>
                      Volume onder deze waarde wordt herkend als fluisteren. Volume erboven wordt gemarkeerd als te luid spreken (rejection).
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
