import React, { useEffect, useRef, useState } from "react";
import { Volume2, VolumeX, AlertCircle } from "lucide-react";

const WhisperCloud = ({ whispers, onSelectWhisper, isRecording }) => {
  const canvasRef = useRef(null);
  const audioContextRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [activeWhisper, setActiveWhisper] = useState(null);
  
  // Track node instances for canvas
  const nodesRef = useRef([]);
  const mouseRef = useRef({ x: -1000, y: -1000, hoverNode: null });

  // Load and play background whispers randomly
  useEffect(() => {
    if (whispers.length === 0 || isRecording || muted) return;

    let timer = null;

    const playRandomWhisper = () => {
      // Pick random whisper
      const randomIndex = Math.floor(Math.random() * whispers.length);
      const whisper = whispers[randomIndex];
      
      // Play audio
      const audio = new Audio(whisper.audioUrl);
      audio.volume = 0.6; // Whispering level
      
      // Visual indicator on canvas
      setActiveWhisper(whisper.id);
      setIsPlaying(true);
      
      audio.play().catch(e => console.log("Audio play blocked by browser:", e));
      
      audio.onended = () => {
        setIsPlaying(false);
        setActiveWhisper(null);
      };

      // Set random interval for next play (5s to 12s)
      const nextInterval = Math.random() * 7000 + 5000;
      timer = setTimeout(playRandomWhisper, nextInterval);
    };

    // First kick-off after 4 seconds
    timer = setTimeout(playRandomWhisper, 4000);

    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [whispers, isRecording, muted]);

  // Sync canvas nodes when whispers list change
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const width = window.innerWidth;
    const height = window.innerHeight;

    // Create custom nodes for each whisper if they don't exist
    const newNodes = whispers.map((w, idx) => {
      const existing = nodesRef.current.find(n => n.id === w.id);
      if (existing) return existing;

      // New node layout: Distributed cloud structure centered
      const angle = Math.random() * Math.PI * 2;
      // Normal distribution centered in middle of screen
      const radius = (Math.random() * 0.25 + 0.05) * Math.min(width, height);
      
      return {
        id: w.id,
        whisper: w,
        x: width / 2 + Math.cos(angle) * radius,
        y: height / 2 + Math.sin(angle) * radius,
        baseX: width / 2 + Math.cos(angle) * radius,
        baseY: height / 2 + Math.sin(angle) * radius,
        size: Math.random() * 8 + 6,
        pulseVal: Math.random() * Math.PI,
        speedX: (Math.random() - 0.5) * 0.2,
        speedY: (Math.random() - 0.5) * 0.2,
        amplitude: Math.random() * 15 + 10,
        freq: Math.random() * 0.001 + 0.0005,
        alpha: 0,
        rippleSize: 0,
        rippleAlpha: 0
      };
    });

    nodesRef.current = newNodes;
  }, [whispers]);

  // Main Canvas Rendering Loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    let animationId;

    const handleResize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    
    window.addEventListener("resize", handleResize);
    handleResize();

    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const mouse = mouseRef.current;
      let hoveredNode = null;

      // Draw elegant soft radial center glow
      const radialGlow = ctx.createRadialGradient(
        canvas.width / 2, canvas.height / 2, 50,
        canvas.width / 2, canvas.height / 2, Math.max(canvas.width, canvas.height) / 2
      );
      radialGlow.addColorStop(0, 'rgba(255, 255, 255, 0.4)');
      radialGlow.addColorStop(0.5, 'rgba(244, 242, 238, 0.15)');
      radialGlow.addColorStop(1, 'rgba(234, 231, 226, 0.05)');
      ctx.fillStyle = radialGlow;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      nodesRef.current.forEach(node => {
        // Slow float drifting math
        node.pulseVal += node.freq;
        const driftX = Math.sin(node.pulseVal * 1.5) * node.amplitude * 0.3;
        const driftY = Math.cos(node.pulseVal) * node.amplitude * 0.4;
        
        node.x = node.baseX + driftX;
        node.y = node.baseY + driftY;

        // Slow fade in
        if (node.alpha < 1) node.alpha += 0.01;

        // Check hover
        const dx = mouse.x - node.x;
        const dy = mouse.y - node.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const isHovered = dist < 45; // Hover zone

        if (isHovered) {
          hoveredNode = node;
        }

        // Active playing node visual indicator (Pulse Ripple)
        if (activeWhisper === node.id) {
          node.rippleSize += 1.2;
          node.rippleAlpha = Math.max(0, 1 - node.rippleSize / 60);
          if (node.rippleAlpha <= 0) {
            node.rippleSize = 0;
            node.rippleAlpha = 1;
          }

          // Draw ripple ring
          ctx.beginPath();
          ctx.arc(node.x, node.y, node.size + node.rippleSize, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(45, 43, 42, ${node.rippleAlpha * 0.3})`;
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        // Draw soft connect line from node to neighboring close nodes
        nodesRef.current.forEach(otherNode => {
          if (node.id === otherNode.id) return;
          const odx = node.x - otherNode.x;
          const ody = node.y - otherNode.y;
          const odist = Math.sqrt(odx * odx + ody * ody);
          if (odist < 140) {
            const lineAlpha = (1 - odist / 140) * 0.04;
            ctx.beginPath();
            ctx.moveTo(node.x, node.y);
            ctx.lineTo(otherNode.x, otherNode.y);
            ctx.strokeStyle = `rgba(45, 43, 42, ${lineAlpha})`;
            ctx.lineWidth = 0.5;
            ctx.stroke();
          }
        });

        // Circle node draw
        const drawGlow = isHovered || activeWhisper === node.id;
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.size + (drawGlow ? 3 : 0), 0, Math.PI * 2);
        ctx.fillStyle = drawGlow ? "rgba(45, 43, 42, 0.9)" : "rgba(45, 43, 42, 0.5)";
        ctx.fill();

        // Node Glow Ring
        if (drawGlow) {
          ctx.beginPath();
          ctx.arc(node.x, node.y, node.size + 12, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(45, 43, 42, 0.1)";
          ctx.fill();
        }

        // Elegant Text Render (Name / Transcription)
        ctx.font = `italic 400 ${drawGlow ? "20px" : "16px"} 'Outfit', sans-serif`;
        ctx.fillStyle = drawGlow ? "rgba(45, 43, 42, 1)" : "rgba(45, 43, 42, 0.8)";
        ctx.textAlign = "center";
        
        // Slightly below node
        ctx.fillText(node.whisper.transcription, node.x, node.y + node.size + 24);
      });

      // Update cursor hover tracking
      mouseRef.current.hoverNode = hoveredNode;
      if (hoveredNode) {
        canvas.style.cursor = "pointer";
      } else {
        canvas.style.cursor = "default";
      }

      animationId = requestAnimationFrame(render);
    };

    render();

    return () => {
      window.removeEventListener("resize", handleResize);
      cancelAnimationFrame(animationId);
    };
  }, [activeWhisper]);

  const handleMouseMove = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    mouseRef.current.x = e.clientX - rect.left;
    mouseRef.current.y = e.clientY - rect.top;
  };

  const handleMouseLeave = () => {
    mouseRef.current.x = -1000;
    mouseRef.current.y = -1000;
  };

  const handleCanvasClick = () => {
    const clickedNode = mouseRef.current.hoverNode;
    if (clickedNode) {
      // Trigger interactive playback on click
      const audio = new Audio(clickedNode.whisper.audioUrl);
      audio.volume = 0.8;
      
      setActiveWhisper(clickedNode.id);
      setIsPlaying(true);
      
      audio.play().catch(e => console.log("Blocked:", e));
      
      audio.onended = () => {
        setIsPlaying(false);
        setActiveWhisper(null);
      };

      if (onSelectWhisper) {
        onSelectWhisper(clickedNode.whisper);
      }
    }
  };

  return (
    <div className="absolute inset-0 w-full h-full pointer-events-auto">
      <canvas
        ref={canvasRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onClick={handleCanvasClick}
        className="w-full h-full block"
      />

      {/* Soothing Title overlay */}
      <div className="absolute top-12 left-1/2 transform -translate-x-1/2 text-center pointer-events-none z-10 select-none">
        <h1 className="title-serif text-3xl md:text-5xl text-[rgba(45,43,42,0.85)] tracking-wide mb-2 animate-breathe">
          Fluisterwolk
        </h1>
        <p className="font-sans font-light text-xs md:text-sm text-[rgba(45,43,42,0.5)] tracking-widest uppercase">
          Laat een naam achter in het zachte licht
        </p>
      </div>

      {/* Cloud Ambient Instruction / Audio controls */}
      <div className="absolute bottom-8 right-8 flex items-center gap-4 z-10">
        {whispers.length === 0 && (
          <div className="flex items-center gap-2 text-xs text-[rgba(45,43,42,0.4)] italic">
            <AlertCircle size={14} />
            <span>Geen fluisteringen. Wees de eerste.</span>
          </div>
        )}
        
        <button
          onClick={() => setMuted(!muted)}
          className="p-3 glass-panel border rounded-full hover:bg-[rgba(255,255,255,0.9)] hover:scale-105 transition-all text-[rgba(45,43,42,0.8)] shadow-sm"
          title={muted ? "Unmute achtergrond whispers" : "Mute achtergrond whispers"}
        >
          {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
        </button>
      </div>
    </div>
  );
};

export default WhisperCloud;
