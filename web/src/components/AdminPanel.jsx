import React, { useState, useEffect } from "react";
import { authService, dbService, storageService, isMockMode } from "../firebase";
import { Lock, Mail, Play, Trash2, ArrowLeft, Download, LogOut, CheckCircle, AlertTriangle, ShieldCheck } from "lucide-react";

const AdminPanel = ({ onClose }) => {
  const [user, setUser] = useState(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [whispers, setWhispers] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [playingId, setPlayingId] = useState(null);
  const [actionMessage, setActionMessage] = useState("");

  // Subscriptions to login state
  useEffect(() => {
    const unsubscribe = authService.onAuthChange((currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        loadWhisperData();
      }
    });
    return () => unsubscribe && unsubscribe();
  }, []);

  const loadWhisperData = async () => {
    setIsLoading(true);
    try {
      const data = await dbService.getWhispers();
      // Sort newest first
      const sorted = [...data].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      setWhispers(sorted);
    } catch (e) {
      console.error("Failed to load whispers:", e);
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
  };

  const handleDelete = async (whisper) => {
    if (!window.confirm(`Weet u zeker dat u "${whisper.transcription}" wilt verwijderen?`)) return;

    try {
      setActionMessage("Verwijderen...");
      
      // 1. Delete database entry
      await dbService.deleteWhisper(whisper.id);
      
      // 2. Delete storage audio file
      if (whisper.filename) {
        await storageService.deleteAudio(whisper.filename);
      }
      
      // 3. Refresh local view
      setWhispers(prev => prev.filter(item => item.id !== whisper.id));
      
      setActionMessage("Verwijderd.");
      setTimeout(() => setActionMessage(""), 2000);
    } catch (err) {
      console.error(err);
      setActionMessage("Fout bij verwijderen.");
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

  // Export whisperbook to JSON file
  const handleExportJSON = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(whispers, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `whisperbook_export_${Date.now()}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  // KPI calculations
  const totalCount = whispers.length;
  const whisperCount = whispers.filter(w => w.speechType === "whisper").length;
  const whisperPercentage = totalCount > 0 ? Math.round((whisperCount / totalCount) * 100) : 0;

  return (
    <div className="absolute inset-0 bg-[#fcfbfa] z-50 flex flex-col pointer-events-auto overflow-y-auto">
      {/* Header Bar */}
      <header className="px-6 md:px-12 py-5 border-b border-[rgba(45,43,42,0.06)] bg-white flex items-center justify-between sticky top-0 z-10">
        <button
          onClick={onClose}
          className="flex items-center gap-2 text-sm uppercase tracking-wider text-muted hover:text-color-primary transition-colors"
        >
          <ArrowLeft size={16} />
          <span>Terug naar Cloud</span>
        </button>

        <div className="flex items-center gap-3">
          <span className="font-serif italic font-semibold text-lg text-color-primary">Fluisterwolk Admin</span>
          {isMockMode && (
            <span className="text-[10px] bg-amber-500/10 border border-amber-500/20 text-amber-800 px-2 py-0.5 rounded-full uppercase tracking-wider font-semibold">
              Mock Mode
            </span>
          )}
        </div>

        {user && (
          <button
            onClick={handleLogout}
            className="flex items-center gap-2 text-xs uppercase tracking-wider text-red-700/80 hover:text-red-950 transition-colors"
          >
            <LogOut size={14} />
            <span className="hidden sm:inline">Uitloggen</span>
          </button>
        )}
      </header>

      {/* Auth Screen */}
      {!user ? (
        <main className="flex-1 flex items-center justify-center p-6 bg-gradient-to-b from-[#fdfdfd] to-[#f5f3ef]">
          <form 
            onSubmit={handleLogin}
            className="glass-panel w-full max-w-sm p-8 flex flex-col gap-6"
          >
            <div className="text-center">
              <div className="w-12 h-12 bg-accent-color/20 rounded-full flex items-center justify-center mx-auto mb-3">
                <Lock size={20} className="text-color-primary" />
              </div>
              <h2 className="title-serif text-2xl mb-1">Toegang Beveiligd</h2>
              <p className="text-xs text-muted">Log in om opgenomen fluisteringen te beheren.</p>
            </div>

            {loginError && (
              <div className="p-3 bg-red-500/10 border border-red-500/20 text-red-800 text-xs rounded-lg flex items-center gap-2">
                <AlertTriangle size={14} />
                <span>{loginError}</span>
              </div>
            )}

            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1 text-left">
                <label className="text-[11px] uppercase tracking-wider text-muted font-medium">E-mailadres</label>
                <div className="relative">
                  <Mail size={14} className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted" />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="admin@fluisterwolk.nl"
                    className="w-full pl-9 pr-4 py-3 bg-white border border-[rgba(45,43,42,0.15)] rounded-lg text-sm outline-none focus:border-color-primary transition-colors"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1 text-left">
                <label className="text-[11px] uppercase tracking-wider text-muted font-medium">Wachtwoord</label>
                <div className="relative">
                  <Lock size={14} className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted" />
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full pl-9 pr-4 py-3 bg-white border border-[rgba(45,43,42,0.15)] rounded-lg text-sm outline-none focus:border-color-primary transition-colors"
                  />
                </div>
              </div>
            </div>

            <button
              type="submit"
              className="btn-premium w-full py-3 justify-center bg-color-primary text-white border-none hover:bg-neutral-800"
            >
              <span>Inloggen</span>
            </button>

            {isMockMode && (
              <div className="text-[10px] text-muted text-center italic border-t border-[rgba(45,43,42,0.06)] pt-3">
                Gebruik voor Mock login:<br />
                <strong>admin@fluisterwolk.nl</strong> / <strong>fluisteradmin</strong>
              </div>
            )}
          </form>
        </main>
      ) : (
        /* Admin Dashboard */
        <main className="flex-1 p-6 md:p-12 max-w-6xl w-full mx-auto flex flex-col gap-8">
          
          {/* KPI Dashboard */}
          <section className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            <div className="bg-white p-6 rounded-2xl border border-[rgba(45,43,42,0.05)] shadow-sm">
              <span className="text-xs uppercase tracking-wider text-muted font-medium">Totaal Opnames</span>
              <h3 className="title-serif text-4xl text-color-primary mt-2">{totalCount}</h3>
            </div>
            
            <div className="bg-white p-6 rounded-2xl border border-[rgba(45,43,42,0.05)] shadow-sm">
              <span className="text-xs uppercase tracking-wider text-muted font-medium">Fluisterpercentage</span>
              <h3 className="title-serif text-4xl text-emerald-800 mt-2">{whisperPercentage}%</h3>
            </div>

            <div className="bg-white p-6 rounded-2xl border border-[rgba(45,43,42,0.05)] shadow-sm flex flex-col justify-between">
              <span className="text-xs uppercase tracking-wider text-muted font-medium">Beheer Acties</span>
              <div className="flex gap-2 mt-2">
                <button
                  onClick={handleExportJSON}
                  disabled={whispers.length === 0}
                  className="btn-premium py-2 px-4 text-xs font-normal border-[rgba(45,43,42,0.1)] hover:bg-gray-50 disabled:opacity-50"
                >
                  <Download size={12} />
                  <span>Exporteer Database</span>
                </button>
              </div>
            </div>
          </section>

          {/* Status Message Overlay banner */}
          {actionMessage && (
            <div className="bg-neutral-800 text-white text-xs px-4 py-2.5 rounded-lg flex items-center gap-2 self-start animate-pulse">
              <ShieldCheck size={14} className="text-emerald-400" />
              <span>{actionMessage}</span>
            </div>
          )}

          {/* Whispers Table listing */}
          <section className="bg-white rounded-2xl border border-[rgba(45,43,42,0.05)] shadow-sm overflow-hidden flex-1 flex flex-col">
            <div className="p-5 border-b border-[rgba(45,43,42,0.06)] flex items-center justify-between">
              <h4 className="title-serif text-xl font-semibold">Geregistreerde Fluisteringen</h4>
              <button 
                onClick={loadWhisperData} 
                className="text-xs text-accent-color hover:text-color-primary font-medium transition-colors"
              >
                Vernieuw Tabel
              </button>
            </div>

            {isLoading ? (
              <div className="flex-1 p-20 text-center text-muted">Laden...</div>
            ) : whispers.length === 0 ? (
              <div className="flex-1 p-20 text-center text-muted italic">Nog geen fluisteringen opgenomen.</div>
            ) : (
              <div className="overflow-x-auto flex-1">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-[rgba(45,43,42,0.02)] text-muted text-[10px] uppercase tracking-widest border-b border-[rgba(45,43,42,0.06)]">
                      <th className="py-4 px-6">Timestamp</th>
                      <th className="py-4 px-6">Naam / Tekst</th>
                      <th className="py-4 px-6">Loudness</th>
                      <th className="py-4 px-6">Whisper Conf</th>
                      <th className="py-4 px-6 text-center">Audio</th>
                      <th className="py-4 px-6 text-right">Acties</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[rgba(45,43,42,0.04)] text-sm">
                    {whispers.map((whisper) => (
                      <tr key={whisper.id} className="hover:bg-[rgba(45,43,42,0.01)] transition-colors">
                        <td className="py-4 px-6 text-xs text-muted whitespace-nowrap">
                          {whisper.timestamp}
                        </td>
                        <td className="py-4 px-6 font-serif italic text-base font-medium">
                          {whisper.transcription}
                        </td>
                        <td className="py-4 px-6 whitespace-nowrap">
                          <span className={`inline-block px-2.5 py-0.5 rounded-full text-[10px] font-semibold border ${
                            whisper.speechType === "whisper"
                              ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-800"
                              : "bg-amber-500/10 border-amber-500/20 text-amber-800"
                          }`}>
                            {whisper.speechType === "whisper" ? "Fluistering" : "Spreken"}
                          </span>
                        </td>
                        <td className="py-4 px-6 font-mono text-xs">
                          {whisper.confidence.toFixed(1)}%
                        </td>
                        <td className="py-4 px-6 text-center">
                          <button
                            onClick={() => playAudio(whisper)}
                            className={`p-2 rounded-full border transition-all ${
                              playingId === whisper.id
                                ? "bg-color-primary text-white border-color-primary scale-95"
                                : "bg-white text-muted hover:text-color-primary hover:border-color-primary"
                            }`}
                          >
                            <Play size={12} className={playingId === whisper.id ? "animate-pulse" : ""} />
                          </button>
                        </td>
                        <td className="py-4 px-6 text-right">
                          <button
                            onClick={() => handleDelete(whisper)}
                            className="p-2 text-red-700/80 hover:text-red-950 hover:bg-red-50 rounded-lg transition-all"
                            title="Verwijderen"
                          >
                            <Trash2 size={15} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </main>
      )}
    </div>
  );
};

export default AdminPanel;
