import React, { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Camera, Image, Plus, X, Sparkles, RefreshCw, Upload, Loader2, Focus } from "lucide-react";

interface PhotoManagerProps {
  onCardGenerated: (topic: string, content: string, subject?: string) => void;
  statusSetter: (msg: string) => void;
}

export default function PhotoManager({ onCardGenerated, statusSetter }: PhotoManagerProps) {
  const [isOpenMenu, setIsOpenMenu] = useState(false);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [isReviewing, setIsReviewing] = useState(false);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Stop camera tracks when component unmounts or state changes
  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, []);

  const startCamera = async () => {
    try {
      setAnalysisError(null);
      setIsOpenMenu(false);
      setIsCameraActive(true);
      setIsReviewing(false);
      setCapturedImage(null);

      // Access the user's rear camera if possible, otherwise front/default
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    } catch (err: any) {
      console.error("Failed to start camera feed:", err);
      // Fallback to any video device
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      } catch (innerErr) {
        setAnalysisError("Nepodařilo se spustit kameru. Ověřte oprávnění přístupu ke kameře.");
        statusSetter("Chyba přístupu ke kameře");
      }
    }
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setIsCameraActive(false);
  };

  const takeSnapshot = () => {
    if (videoRef.current) {
      const video = videoRef.current;
      const canvas = document.createElement("canvas");
      // Match high quality native photo resolution if possible
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;

      const ctx = canvas.getContext("2d");
      if (ctx) {
        // Draw the current video frame
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
        setCapturedImage(dataUrl);
        setIsReviewing(true);
        stopCamera();
      }
    }
  };

  const handleGallerySelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsOpenMenu(false);
    setAnalysisError(null);

    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      setCapturedImage(result);
      setIsReviewing(true);
    };
    reader.readAsDataURL(file);
  };

  const analyzeSelectedImage = async () => {
    if (!capturedImage) return;

    try {
      setIsAnalyzing(true);
      setAnalysisError(null);
      statusSetter("Analyzuji obrázek...");

      const response = await fetch("/api/analyze-image", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          image: capturedImage,
          mimeType: "image/jpeg",
        }),
      });

      if (!response.ok) {
        throw new Error("Odpověď serveru nebyla úspěšná.");
      }

      const data = await response.json();
      if (data.topic && data.content) {
        onCardGenerated(data.topic, data.content, data.subject);
        statusSetter("Materiál úspěšně vygenerován z fotky");
        closeAll();
      } else {
        throw new Error("Neplatná struktura odpovědi.");
      }
    } catch (err: any) {
      console.error("Analysis failed:", err);
      setAnalysisError("Bohužel se nepodařilo z fotky vytvořit studijní kartu. Zkuste to prosím znovu.");
      statusSetter("Chyba analýzy fotky");
    } finally {
      setIsAnalyzing(false);
    }
  };

  const triggerGalleryUpload = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const closeAll = () => {
    stopCamera();
    setIsOpenMenu(false);
    setIsCameraActive(false);
    setIsReviewing(false);
    setCapturedImage(null);
    setIsAnalyzing(false);
    setAnalysisError(null);
  };

  return (
    <>
      {/* Hidden file input for gallery upload */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleGallerySelect}
        accept="image/*"
        className="hidden"
      />

      {/* Main trigger circular Plus button in the footer control row */}
      <button
        onClick={() => setIsOpenMenu(true)}
        className="w-13 h-13 bg-cyan-955/20 hover:bg-cyan-950/45 border border-cyan-500/15 hover:border-cyan-400 active:scale-95 text-cyan-350 hover:text-cyan-400 rounded-2xl flex items-center justify-center transition-all duration-200 cursor-pointer shadow-[0_0_15px_rgba(6,182,212,0.05)] hover:shadow-[0_0_20px_rgba(6,182,212,0.15)] backdrop-blur-md flex-shrink-0"
        title="Přidat fotku / materiál"
      >
        <Plus className="w-5 h-5 text-cyan-455/80" />
      </button>

      {/* Select Mode Slide-up Menu / Modal */}
      <AnimatePresence>
        {isOpenMenu && (
          <>
            {/* Dark backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={closeAll}
              className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 pointer-events-auto"
            />

            {/* Selector Card centered built cleanly */}
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ type: "spring", damping: 25, stiffness: 220 }}
              className="fixed inset-x-4 bottom-10 md:bottom-auto md:top-1/2 md:-translate-y-1/2 md:left-1/2 md:-translate-x-1/2 max-w-sm mx-auto bg-[#070914]/95 border border-cyan-500/25 rounded-[28px] p-6 shadow-[0_24px_80px_rgba(6,182,212,0.18)] z-55 pointer-events-auto relative overflow-hidden backdrop-blur-xl"
            >
              {/* Futuristic light accent bar */}
              <div className="absolute top-0 inset-x-0 h-[1.5px] bg-gradient-to-r from-transparent via-cyan-400/50 to-transparent pointer-events-none" />
              
              <div className="flex items-center justify-between pb-3.5 border-b border-cyan-950 mb-4">
                <h4 className="text-sm font-bold text-cyan-100 tracking-wide select-none">Přidat studijní materiál</h4>
                <button
                  onClick={closeAll}
                  className="p-1 text-zinc-400 hover:text-cyan-400 hover:bg-cyan-950/30 rounded-md transition-all cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <p className="text-xs text-zinc-350 mb-5 leading-relaxed select-none">
                Vyfoťte kamerou nebo nahrajte z galerie učebnici, příklad či poznámky. Shate z nich ihned sestaví přehledný digitální tahák.
              </p>

              <div className="space-y-3">
                <button
                  onClick={startCamera}
                  className="w-full py-3 px-4 bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-400 hover:to-blue-400 text-slate-950 rounded-xl font-bold text-sm flex items-center justify-center gap-2.5 transition-all cursor-pointer shadow-[0_4px_15px_rgba(6,182,212,0.25)] hover:shadow-[0_4px_20px_rgba(6,182,212,0.35)] active:scale-[98%]"
                >
                  <Camera className="w-4 h-4" />
                  <span>Vyfotit kamerou</span>
                </button>

                <button
                  onClick={triggerGalleryUpload}
                  className="w-full py-3 px-4 bg-zinc-955 hover:bg-zinc-900 border border-cyan-500/10 hover:border-cyan-500/30 text-zinc-200 hover:text-cyan-300 rounded-xl font-semibold text-sm flex items-center justify-center gap-2.5 transition-all cursor-pointer"
                >
                  <Image className="w-4 h-4 text-cyan-500/70" />
                  <span>Nahrát z galerie</span>
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Embedded Camera Viewfinder (BeReal styled) */}
      <AnimatePresence>
        {isCameraActive && (
          <>
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/90 backdrop-blur-md z-50 pointer-events-auto"
            />

            {/* Viewfinder modal centered elegantly */}
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="fixed inset-0 flex flex-col items-center justify-center p-4 z-55 pointer-events-none"
            >
              <div className="w-full max-w-sm bg-[#050710] border border-cyan-500/20 rounded-[32px] p-4 shadow-[0_32px_96px_rgba(6,182,212,0.15)] flex flex-col pointer-events-auto select-none overflow-hidden relative">
                <div className="absolute top-0 inset-x-0 h-[1.5px] bg-gradient-to-r from-transparent via-cyan-400/40 to-transparent pointer-events-none" />
                
                {/* Header info */}
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-1.5">
                    <Focus className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />
                    <span className="text-[10px] font-mono tracking-wider text-cyan-300">Hledáček fotoaparátu</span>
                  </div>
                  <button
                    onClick={closeAll}
                    className="p-1 px-2 pb-1.5 text-zinc-400 hover:text-white hover:bg-cyan-955/20 rounded-xl transition-all cursor-pointer border border-cyan-500/20 text-xs font-semibold"
                  >
                    <span>Zrušit</span>
                  </button>
                </div>

                {/* BeReal Square Aspect-Ratio Live Camera Box */}
                <div className="relative aspect-square w-full rounded-[24px] bg-zinc-950 overflow-hidden border border-cyan-500/10">
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    className="w-full h-full object-cover"
                  />
                  {/* Futuristic Grid overlay */}
                  <div className="absolute inset-0 bg-[linear-gradient(to_bottom,rgba(6,182,212,0.02)_1px,transparent_1px),linear-gradient(to_right,rgba(6,182,212,0.02)_1px,transparent_1px)] bg-[size:30px_30px] pointer-events-none mix-blend-overlay" />
                  
                  {/* Tech camera focus corners */}
                  <div className="absolute top-4 left-4 w-3 h-3 border-t-2 border-l-2 border-cyan-455/65 pointer-events-none" />
                  <div className="absolute top-4 right-4 w-3 h-3 border-t-2 border-r-2 border-cyan-455/65 pointer-events-none" />
                  <div className="absolute bottom-4 left-4 w-3 h-3 border-b-2 border-l-2 border-cyan-455/65 pointer-events-none" />
                  <div className="absolute bottom-4 right-4 w-3 h-3 border-b-2 border-r-2 border-cyan-455/65 pointer-events-none" />
                </div>

                {/* Shutter Circle Trigger Control bar */}
                <div className="flex items-center justify-center py-5 mt-2">
                  <button
                    onClick={takeSnapshot}
                    className="w-16 h-16 rounded-full bg-cyan-400 hover:bg-cyan-300 flex items-center justify-center active:scale-90 transition-all cursor-pointer p-1 ring-4 ring-cyan-500/20 select-none shadow-[0_0_20px_#22d3ee] shadow-cyan-500/20"
                    title="Vyfotit"
                  >
                    <div className="w-full h-full rounded-full border border-slate-950 bg-transparent" />
                  </button>
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Review & Analysis Screen */}
      <AnimatePresence>
        {isReviewing && capturedImage && (
          <>
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/95 backdrop-blur-md z-50 pointer-events-auto"
            />

            {/* Modal */}
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="fixed inset-0 flex flex-col items-center justify-center p-4 z-55 pointer-events-none"
            >
              <div className="w-full max-w-sm bg-[#04060f] border border-cyan-500/25 rounded-[32px] p-5 shadow-[0_32px_96px_rgba(6,182,212,0.18)] flex flex-col pointer-events-auto overflow-hidden relative">
                <div className="absolute top-0 inset-x-0 h-[1.5px] bg-gradient-to-r from-transparent via-cyan-455/40 to-transparent pointer-events-none" />
                
                {/* Header info */}
                <div className="flex items-center justify-between mb-4">
                  <span className="text-xs font-semibold text-cyan-200 uppercase tracking-widest font-mono select-none">Nafocený materiál</span>
                  {!isAnalyzing && (
                    <button
                      onClick={closeAll}
                      className="p-1 px-2 pb-1 text-zinc-400 hover:text-cyan-400 hover:bg-cyan-950/20 rounded-md transition-all cursor-pointer text-xs font-semibold"
                    >
                      <span>Zavřít</span>
                    </button>
                  )}
                </div>

                {/* Captured Snapshot Display Container */}
                <div className="relative aspect-square w-full rounded-[24px] bg-zinc-955 overflow-hidden border border-cyan-500/10 mb-5">
                  <img
                    src={capturedImage}
                    alt="Captured"
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                  />

                  {/* High Tech Loader screen while analyzing */}
                  <AnimatePresence>
                    {isAnalyzing && (
                      <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="absolute inset-0 bg-black/85 backdrop-blur-sm flex flex-col items-center justify-center p-4 text-center space-y-4 select-none"
                      >
                        <div className="relative">
                          {/* Pulsing ring */}
                          <div className="absolute inset-x-0 -top-1 -bottom-1 rounded-full border border-cyan-400/30 animate-ping" />
                          <div className="w-12 h-12 rounded-full bg-cyan-950 border border-cyan-400/50 flex items-center justify-center shadow-[0_0_15px_rgba(6,182,212,0.4)]">
                            <Loader2 className="w-5 h-5 text-cyan-400 animate-spin" />
                          </div>
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-white tracking-wide">Shate analyzuje fotku...</p>
                          <p className="text-[10px] text-cyan-400 mt-1 font-mono tracking-wider uppercase">Sestavuji studijní tahák...</p>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {/* Error Banner */}
                {analysisError && (
                  <div className="mb-4 p-3 bg-red-955/20 border border-red-900/40 rounded-xl text-center">
                    <p className="text-xs text-red-400 font-medium leading-relaxed">{analysisError}</p>
                  </div>
                )}

                {/* Action Buttons row */}
                <div className="grid grid-cols-2 gap-3">
                  <button
                    disabled={isAnalyzing}
                    onClick={startCamera}
                    className="w-full py-3 bg-zinc-900/60 hover:bg-zinc-850 text-zinc-300 border border-zinc-800 hover:border-cyan-500/30 disabled:opacity-50 rounded-xl font-semibold text-xs flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Zkusit znovu</span>
                  </button>

                  <button
                    disabled={isAnalyzing}
                    onClick={analyzeSelectedImage}
                    className="w-full py-3 bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-400 hover:to-blue-400 text-slate-950 disabled:opacity-50 rounded-xl font-bold text-xs flex items-center justify-center gap-1.5 transition-all cursor-pointer shadow-[0_4px_12px_rgba(6,182,212,0.25)]"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>Analyzovat</span>
                  </button>
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
