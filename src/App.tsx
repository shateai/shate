import { useEffect, useRef, useState, FormEvent, TouchEvent } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Smartphone, Mic, PhoneOff, Sparkles, X, History, ChevronLeft, ChevronRight, Calendar, ArrowLeft, LogIn, Clock, Settings, LogOut, Sliders, Zap } from "lucide-react";
import { pcmToBase64, base64ToFloat32 } from "./lib/audio-utils";
import { collection, addDoc, query, where, orderBy, onSnapshot, deleteDoc, doc, serverTimestamp, updateDoc } from "firebase/firestore";
import { db, auth } from "./lib/firebase";
import { onAuthStateChanged, signInWithPopup, signInAnonymously, GoogleAuthProvider, signOut, User } from "firebase/auth";
import PhotoManager from "./components/PhotoManager";
import MarkdownRenderer from "./components/MarkdownRenderer";

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

interface StudyCardDoc {
  id: string;
  topic: string;
  content: string;
  subject?: string;
  osnova?: string;
  lessonPlan?: string[] | null;
  lessonIndex?: number | null;
  createdAt: any;
  userId: string;
}

export default function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [assistantTranscriptReal, setAssistantTranscriptActive] = useState<string>("");
  const [userTranscriptReal, setUserTranscriptActive] = useState<string>("");
  const assistantTranscriptRef = useRef("");
  const userTranscriptRef = useRef("");

  const setAssistantTranscript = (val: string | ((prev: string) => string)) => {
    if (typeof val === "function") {
      setAssistantTranscriptActive(prev => {
        const next = val(prev);
        assistantTranscriptRef.current = next;
        return next;
      });
    } else {
      setAssistantTranscriptActive(val);
      assistantTranscriptRef.current = val;
    }
  };

  const setUserTranscript = (val: string | ((prev: string) => string)) => {
    if (typeof val === "function") {
      setUserTranscriptActive(prev => {
        const next = val(prev);
        userTranscriptRef.current = next;
        return next;
      });
    } else {
      setUserTranscriptActive(val);
      userTranscriptRef.current = val;
    }
  };

  // Keep references
  const assistantTranscript = assistantTranscriptReal;
  const userTranscript = userTranscriptReal;

  const [status, setStatus] = useState<string>("Připraveno");
  const [isAiSpeaking, setIsAiSpeaking] = useState(false);
  const [voiceSpeed, setVoiceSpeed] = useState<number>(1.4); // Rychlejší řeč o ~40% ve výchozím nastavení

  // Authentication State
  const [user, setUser] = useState<User | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // History state management
  const [showSettings, setShowSettings] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [savedCards, setSavedCards] = useState<StudyCardDoc[]>([]);
  const [activePanelType, setActivePanelType] = useState<'general' | 'morning' | 'evening'>('general');
  const DEFAULT_MORNING_ROUTINE = "";
  const DEFAULT_EVENING_ROUTINE = "";
  const [showHistory, setShowHistory] = useState(false);
  const [carouselIndex, setCarouselIndex] = useState(0);
  const [userId, setUserId] = useState<string>("");
  const [selectedSubject, setSelectedSubject] = useState<string | null>(null);
  const [selectedOsnova, setSelectedOsnova] = useState<string | null>(null);

  // Research states
  const [researchTopic, setResearchTopic] = useState<string>("");
  const [researchStatus, setResearchStatus] = useState<"idle" | "searching" | "ready">("idle");
  const [researchResult, setResearchResult] = useState<string>("");
  const [researchSources, setResearchSources] = useState<Array<{ title: string; url: string }>>([]);
  const [researchSubject, setResearchSubject] = useState<string>("Denní plán");

  // Custom helper card state
  const [customCard, setCustomCard] = useState<{ topic: string; content: string; subject?: string } | null>(null);
  const [activeCardId, setActiveCardId] = useState<string | null>(null);
  const prevSavedCardsLengthRef = useRef<number>(0);

  // Text message chat states
  const [textMessage, setTextMessage] = useState("");
  const [isSubmittingText, setIsSubmittingText] = useState(false);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [touchStart, setTouchStart] = useState<{ x: number; y: number } | null>(null);

  // Unified chat history for current session
  const [chatHistory, setChatHistory] = useState<Array<{ id: string; userText?: string; assistantText?: string; timestamp: Date }>>([]);

  const isNewTurnRef = useRef<boolean>(true);
  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);

  // Configuration
  const SAMPLE_RATE = 16000;

  // Monitor standard Firebase Auth state
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        setUserId(currentUser.uid);
      } else {
        setUserId("");
      }
    });
    return () => unsubscribe();
  }, []);

  const loginWithGoogle = async () => {
    setIsLoggingIn(true);
    setAuthError(null);
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
      setStatus("Přihlášení úspěšné");
    } catch (err: any) {
      console.error("Google Auth Error:", err);
      setAuthError("Nepodařilo se přihlásit přes Google. Zkuste přihlášení jako host.");
    } finally {
      setIsLoggingIn(false);
    }
  };

  const loginAsGuest = async () => {
    setIsLoggingIn(true);
    setAuthError(null);
    try {
      await signInAnonymously(auth);
      setStatus("Přihlášen jako host");
    } catch (err: any) {
      console.error("Guest Auth Error:", err);
      const virtualId = "guest_" + Math.random().toString(36).substring(2, 10);
      setUserId(virtualId);
      setUser({
        uid: virtualId,
        displayName: "Testovací Host",
        email: "host@shate.ai",
        isAnonymous: true,
      } as any);
      setStatus("Přihlášen jako host (offline)");
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut(auth);
      setUser(null);
      setUserId("");
      setSelectedSubject(null);
      setActiveCardId(null);
      setCustomCard(null);
      setStatus("Odhlášeno");
    } catch (err) {
      console.error("Signout Error:", err);
    }
  };

  // Listen for saved study cards in real-time
  useEffect(() => {
    if (!userId) return;

    const q = query(
      collection(db, "study-cards"),
      where("userId", "==", userId),
      orderBy("createdAt", "desc")
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const list: StudyCardDoc[] = [];
      snapshot.forEach((snap) => {
        const data = snap.data();
        list.push({
          id: snap.id,
          topic: data.topic || "Denní plán",
          content: data.content || "",
          subject: data.subject || "Denní plán",
          osnova: data.osnova || "",
          lessonPlan: data.lessonPlan || null,
          lessonIndex: data.lessonIndex || null,
          createdAt: data.createdAt,
          userId: data.userId,
          targetDateStr: data.targetDateStr || null
        } as any);
      });
      setSavedCards(list);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, "study-cards");
    });

    return () => unsubscribe();
  }, [userId]);

  const getCardDayLabel = (card: any) => {
    if (!card) return "Plán";
    const topicLower = (card.topic || "").toLowerCase();
    if (topicLower.includes("dnes") || topicLower === "dnes") return "Dnes";
    if (topicLower.includes("včera") || topicLower === "včera") return "Včera";
    if (topicLower.includes("zítra") || topicLower === "zítra") return "Zítra";

    if (card.createdAt?.seconds) {
      const cardDate = new Date(card.createdAt.seconds * 1000);
      const today = new Date();
      
      const isSameDay = (d1: Date, d2: Date) => 
        d1.getDate() === d2.getDate() &&
        d1.getMonth() === d2.getMonth() &&
        d1.getFullYear() === d2.getFullYear();

      if (isSameDay(cardDate, today)) return "Dnes";

      const yesterday = new Date(today);
      yesterday.setDate(today.getDate() - 1);
      if (isSameDay(cardDate, yesterday)) return "Včera";

      const tomorrow = new Date(today);
      tomorrow.setDate(today.getDate() + 1);
      if (isSameDay(cardDate, tomorrow)) return "Zítra";

      return cardDate.toLocaleDateString("cs-CZ", {
        weekday: "long",
        day: "numeric",
        month: "numeric"
      }).replace(/^\w/, (c) => c.toUpperCase());
    }

    return card.topic || "Plán";
  };

  const openHistoryCarousel = () => {
    const routineCards = [...savedCards].sort((a, b) => {
      const dateA = a.createdAt?.seconds ? a.createdAt.seconds * 1000 : Date.now();
      const dateB = b.createdAt?.seconds ? b.createdAt.seconds * 1000 : Date.now();
      return dateA - dateB;
    });

    const todayIndex = routineCards.findIndex(card => {
      const lbl = getCardDayLabel(card);
      return lbl === "Dnes";
    });

    if (todayIndex !== -1) {
      setCarouselIndex(todayIndex);
    } else if (routineCards.length > 0) {
      setCarouselIndex(routineCards.length - 1);
    } else {
      setCarouselIndex(0);
    }
    setShowHistory(true);
  };

  const sendAppStateSync = (wsOverride?: WebSocket) => {
    const ws = wsOverride || wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const uniqueSubjects = Array.from(new Set(savedCards.map(c => c.subject || "Denní plán")));
    const existingCardsInfo = savedCards
      .map(c => ({
        topic: c.topic,
        targetDateStr: (c as any).targetDateStr || "",
        content: c.content,
        subject: c.subject || "Denní plán"
      }));

    const payload = {
      subjects: uniqueSubjects,
      currentSubject: "Denní plán",
      totalCards: savedCards.length,
      currentDateStr: formatDateKey(new Date()),
      selectedDateStr: formatDateKey(selectedDate),
      existingCards: existingCardsInfo,
      activePanelType: activePanelType
    };

    try {
      ws.send(JSON.stringify({
        type: "sync_app_state",
        payload: payload
      }));
    } catch (e) {
      console.error("Error sending app state sync:", e);
    }
  };

  const handleTouchStart = (e: TouchEvent) => {
    setTouchStart({
      x: e.touches[0].clientX,
      y: e.touches[0].clientY
    });
  };

  const handleTouchEnd = (e: TouchEvent) => {
    if (!touchStart) return;
    const diffX = touchStart.x - e.changedTouches[0].clientX;
    const diffY = touchStart.y - e.changedTouches[0].clientY;
    const minDistance = 50; // trigger distance in pixels

    if (Math.abs(diffX) > Math.abs(diffY) && Math.abs(diffX) > minDistance) {
      if (diffX > 0) {
        // Swipe left -> Next panel
        if (activePanelType === 'general') {
          setActivePanelType('morning');
        } else if (activePanelType === 'morning') {
          setActivePanelType('evening');
        }
      } else {
        // Swipe right -> Previous panel
        if (activePanelType === 'evening') {
          setActivePanelType('morning');
        } else if (activePanelType === 'morning') {
          setActivePanelType('general');
        }
      }
    }
    setTouchStart(null);
  };

  useEffect(() => {
    if (isConnected && wsRef.current) {
      sendAppStateSync();
    }
  }, [savedCards, isConnected, selectedDate]);

  const formatDateKey = (date: Date) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };

  const getCardForDateAndType = (date: Date, type: 'general' | 'morning' | 'evening') => {
    const key = formatDateKey(date);
    const subjectMap = {
      general: "Denní plán",
      morning: "Ranní rutina",
      evening: "Večerní rutina"
    };

    // 1. Try to find a card explicitly matching targetDateStr AND subject of that type
    let match = savedCards.find(c => 
      (c as any).targetDateStr === key && 
      (c.subject === subjectMap[type] || (!c.subject && type === 'general'))
    );
    if (match) return match;

    // For general cards, fallback to older style models without explicit subject or matching current date
    if (type === 'general') {
      match = savedCards.find(c => (c as any).targetDateStr === key);
      if (match) return match;

      match = savedCards.find(card => {
        if (!card.createdAt?.seconds) return false;
        const cardDate = new Date(card.createdAt.seconds * 1000);
        return (
          cardDate.getDate() === date.getDate() &&
          cardDate.getMonth() === date.getMonth() &&
          cardDate.getFullYear() === date.getFullYear()
        );
      });
      if (match) return match;

      const dateDayNameStr = date.toLocaleDateString("cs-CZ", { weekday: "long" }).toLowerCase();
      match = savedCards.find(card => {
        const lblLower = (card.topic || "").toLowerCase();
        return lblLower.includes(dateDayNameStr);
      });
      if (match) return match;
    }

    return null;
  };

  const getCardContentAndId = (date: Date, type: 'general' | 'morning' | 'evening') => {
    const card = getCardForDateAndType(date, type);
    if (card) {
      return { id: card.id, content: card.content, topic: card.topic, isDefault: false };
    } else {
      const key = formatDateKey(date);
      if (type === 'morning') {
        return { id: `virtual-morning-${key}`, content: DEFAULT_MORNING_ROUTINE, topic: "Ranní rutina", isDefault: true };
      } else if (type === 'evening') {
        return { id: `virtual-evening-${key}`, content: DEFAULT_EVENING_ROUTINE, topic: "Večerní rutina", isDefault: true };
      } else {
        return { id: null, content: "", topic: "Dodatečné úkoly", isDefault: true };
      }
    }
  };

  const getCardForDate = (date: Date) => {
    return getCardForDateAndType(date, 'general');
  };

  // Track selected date card matching
  useEffect(() => {
    const match = getCardForDateAndType(selectedDate, activePanelType);
    if (match) {
      setActiveCardId(match.id);
    } else {
      setActiveCardId(null);
    }
  }, [selectedDate, savedCards, activePanelType]);

  const handleNewCardGenerated = (
    topic: string,
    content: string,
    subject?: string,
    osnova?: string,
    lessonPlan?: string[] | null,
    lessonIndex?: number | null,
    targetDateStr?: string | null
  ) => {
    saveCardToDb(topic, content, subject || "Denní plán", osnova, lessonPlan, lessonIndex, targetDateStr);
  };

  const saveCardToDb = async (
    topic: string,
    content: string,
    subjectName?: string,
    osnova?: string,
    lessonPlan?: string[] | null,
    lessonIndex?: number | null,
    targetDateStr?: string | null
  ) => {
    if (!userId || !topic) return;
    
    const resolvedDateStr = targetDateStr || formatDateKey(selectedDate);
    const targetSubject = subjectName || "Denní plán";

    // Find card that belongs to this specific date AND has the same subject,
    // OR matches exactly by topic name (for general non-date topic cards).
    const existingCard = savedCards.find(
      card => {
        const cardDate = (card as any).targetDateStr;
        if (cardDate && cardDate === resolvedDateStr) {
          const cardSubject = card.subject || "Denní plán";
          return cardSubject === targetSubject;
        }
        if (!cardDate) {
          return card.topic.toLowerCase().trim() === topic.toLowerCase().trim();
        }
        return false;
      }
    );

    if (existingCard) {
      try {
        await updateDoc(doc(db, "study-cards", existingCard.id), {
          content: content,
          topic: topic,
          createdAt: serverTimestamp()
        });
        setActiveCardId(existingCard.id);
      } catch (error) {
        handleFirestoreError(error, OperationType.UPDATE, `study-cards/${existingCard.id}`);
      }
      return;
    }

    try {
      const docRef = await addDoc(collection(db, "study-cards"), {
        topic: topic,
        content: content,
        subject: targetSubject,
        osnova: osnova || "",
        lessonPlan: lessonPlan || null,
        lessonIndex: lessonIndex || null,
        createdAt: serverTimestamp(),
        targetDateStr: resolvedDateStr,
        userId: userId
      });
      setActiveCardId(docRef.id);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, "study-cards");
    }
  };

  const deleteCardFromDb = async (cardId: string) => {
    try {
      if (activeCardId === cardId) {
        setActiveCardId(null);
      }
      await deleteDoc(doc(db, "study-cards", cardId));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `study-cards/${cardId}`);
    }
  };

  const handleToggleTask = async (type: 'general' | 'morning' | 'evening', date: Date, lineIndex: number) => {
    const cardInfo = getCardContentAndId(date, type);
    const content = cardInfo.content;
    if (!content) return;

    const lines = content.split("\n");
    if (lineIndex < 0 || lineIndex >= lines.length) return;

    const targetLine = lines[lineIndex];
    const isBullet = targetLine.trim().startsWith("- ") || targetLine.trim().startsWith("* ");
    if (!isBullet) return;

    const match = targetLine.match(/^(\s*[-*]\s*)(.*)$/);
    if (!match) return;

    const prefix = match[1];
    const suffix = match[2].trim();

    let newSuffix = "";
    let isNowCompleted = false;

    if (suffix.startsWith("[x]") || suffix.startsWith("[X]")) {
      newSuffix = suffix.substring(3).trim();
      isNowCompleted = false;
    } else if (suffix.startsWith("[ ]")) {
      newSuffix = "[x] " + suffix.substring(3).trim();
      isNowCompleted = true;
    } else {
      newSuffix = "[x] " + suffix;
      isNowCompleted = true;
    }

    lines[lineIndex] = `${prefix.trimEnd()} ${newSuffix}`;

    if (isNowCompleted) {
      const movedLine = lines.splice(lineIndex, 1)[0];
      let lastBulletIndex = -1;
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i].trim();
        if (ln.startsWith("- ") || ln.startsWith("* ")) {
          lastBulletIndex = i;
        }
      }
      if (lastBulletIndex !== -1) {
        lines.splice(lastBulletIndex + 1, 0, movedLine);
      } else {
        lines.push(movedLine);
      }
    } else {
      const movedLine = lines.splice(lineIndex, 1)[0];
      let firstCompletedIndex = -1;
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i].trim();
        if ((ln.startsWith("- ") || ln.startsWith("* ")) && (ln.includes("[x]") || ln.includes("[X]"))) {
          firstCompletedIndex = i;
          break;
        }
      }
      if (firstCompletedIndex !== -1) {
        lines.splice(firstCompletedIndex, 0, movedLine);
      } else {
        let lastUnfinishedIndex = -1;
        for (let i = 0; i < lines.length; i++) {
          const ln = lines[i].trim();
          if ((ln.startsWith("- ") || ln.startsWith("* ")) && !ln.includes("[x]") && !ln.includes("[X]")) {
            lastUnfinishedIndex = i;
          }
        }
        if (lastUnfinishedIndex !== -1) {
          lines.splice(lastUnfinishedIndex + 1, 0, movedLine);
        } else {
          lines.push(movedLine);
        }
      }
    }

    const updatedContent = lines.join("\n");

    if (!cardInfo.isDefault && cardInfo.id && !cardInfo.id.startsWith("virtual-")) {
      try {
        await updateDoc(doc(db, "study-cards", cardInfo.id), {
          content: updatedContent,
          createdAt: serverTimestamp()
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.UPDATE, `study-cards/${cardInfo.id}`);
      }
    } else {
      const subjectName = type === 'morning' ? "Ranní rutina" : type === 'evening' ? "Večerní rutina" : "Denní plán";
      const topicName = type === 'morning' ? "Ranní rutina" : type === 'evening' ? "Večerní rutina" : "Dodatečné úkoly";
      const resolvedDateStr = formatDateKey(date);

      try {
        await addDoc(collection(db, "study-cards"), {
          topic: topicName,
          content: updatedContent,
          subject: subjectName,
          osnova: "Rutina",
          lessonPlan: null,
          lessonIndex: null,
          createdAt: serverTimestamp(),
          targetDateStr: resolvedDateStr,
          userId: userId
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.CREATE, "study-cards");
      }
    }
  };

  const handleSendTextMessage = async (e?: FormEvent) => {
    if (e) e.preventDefault();
    if (!textMessage.trim() || isSubmittingText) return;

    const userMsg = textMessage.trim();
    setTextMessage("");
    setIsSubmittingText(true);
    setStatus("Odesílám plán...");

    try {
      stopAudioPlayback();

      const existingCardsInfo = savedCards
        .filter(c => c.subject === "Denní plán" || !c.subject)
        .map(c => ({
          topic: c.topic,
          targetDateStr: (c as any).targetDateStr || "",
          content: c.content
        }));

      const response = await fetch("/api/chat-message", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ 
          message: userMsg, 
          userId,
          selectedDateStr: formatDateKey(selectedDate),
          currentDateStr: formatDateKey(new Date()),
          existingCards: existingCardsInfo
        }),
      });

      if (!response.ok) {
        throw new Error("Nepodařilo se odeslat zprávu.");
      }

      const data = await response.json();
      
      setUserTranscript("");
      setAssistantTranscript("");
      setChatHistory(prev => [
        ...prev,
        {
          id: Math.random().toString(36).substring(7),
          userText: userMsg,
          assistantText: data.reply,
          timestamp: new Date()
        }
      ]);
      setStatus("Zapsáno");

      if (data.card) {
        const cardSubject = data.card.subject || "Denní plán";
        setCustomCard({
          topic: data.card.topic,
          content: data.card.content,
          subject: cardSubject
        });
        setResearchStatus("idle");

        handleNewCardGenerated(
          data.card.topic,
          data.card.content,
          cardSubject,
          undefined,
          undefined,
          undefined,
          data.card.targetDateStr
        );

        // Auto-navigate to targeted card date if returned asynchronously
        if (data.card.targetDateStr) {
          const parts = data.card.targetDateStr.split('-');
          if (parts.length === 3) {
            const tgtDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
            setSelectedDate(tgtDate);
          }
        }
      }
    } catch (error) {
      console.error("Text message error:", error);
      setStatus("Chyba odeslání");
    } finally {
      setIsSubmittingText(false);
    }
  };

  const startSession = async () => {
    try {
      setStatus("Připojování...");
      isNewTurnRef.current = true;
      setUserTranscript("");
      setAssistantTranscript("");
      setResearchStatus("idle");
      setResearchTopic("");
      setResearchResult("");
      setResearchSources([]);
      setCustomCard(null);
      
      audioCtxRef.current = new AudioContext({ sampleRate: SAMPLE_RATE });
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws-live`);
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus("Připojování k Shate...");
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        
        if (msg.type === "session_ready") {
          setIsConnected(true);
          setStatus("Hlas aktivní");
          startAudioProcessing();
          sendAppStateSync(ws);
          return;
        }

        if (msg.type === "voice_speed_changed") {
          const newSpeed = Number(msg.speed) || 1.4;
          setVoiceSpeed(newSpeed);
          setStatus(`Rychlost: ${newSpeed}x`);
          return;
        }

        if (msg.type === "research_started") {
          setResearchStatus("searching");
          setResearchTopic(msg.topic);
          setResearchResult("");
          setResearchSources([]);
          setStatus(`Průzkum na pozadí: "${msg.topic}"`);
          return;
        }

        if (msg.type === "research_ready") {
          setResearchStatus("ready");
          setResearchTopic(msg.topic);
          setResearchResult(msg.result || "");
          setStatus(`Hotovo: "${msg.topic}"`);
          handleNewCardGenerated(msg.topic, msg.result || "", "Denní plán");
          return;
        }

        if (msg.type === "research_error") {
          setResearchStatus("idle");
          setStatus("Chyba vyhledávání");
          return;
        }

        if (msg.type === "display_study_card") {
          const resolvedSubject = msg.subject || "Denní plán";
          setCustomCard({
            topic: msg.topic,
            content: msg.content,
            subject: resolvedSubject
          });
          setResearchStatus("idle");
          setStatus(`Zobrazen plán: ${msg.topic}`);
          handleNewCardGenerated(
            msg.topic, 
            msg.content, 
            resolvedSubject, 
            undefined, 
            undefined, 
            undefined, 
            msg.targetDateStr
          );

          if (msg.targetDateStr) {
            const parts = msg.targetDateStr.split('-');
            if (parts.length === 3) {
              const tgtDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
              setSelectedDate(tgtDate);
            }
          }
          return;
        }

        if (msg.type === "hide_card") {
          setCustomCard(null);
          setResearchStatus("idle");
          setStatus("Karta skryta");
          return;
        }

        if (msg.type === "switch_view_day") {
          if (msg.targetDateStr) {
            let targetDate = new Date();
            const lowerStr = msg.targetDateStr.toLowerCase();
            if (lowerStr === "today" || lowerStr === "dnes") {
              targetDate = new Date();
            } else if (lowerStr === "tomorrow" || lowerStr === "zítra" || lowerStr === "zitra") {
              const d = new Date();
              d.setDate(d.getDate() + 1);
              targetDate = d;
            } else if (lowerStr === "yesterday" || lowerStr === "včera" || lowerStr === "vcera") {
              const d = new Date();
              d.setDate(d.getDate() - 1);
              targetDate = d;
            } else {
              const parts = msg.targetDateStr.split('-');
              if (parts.length === 3) {
                targetDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
              }
            }
            setSelectedDate(targetDate);
            setStatus(`Přepnuto na datum: ${targetDate.toLocaleDateString("cs-CZ")}`);
          }
          return;
        }

        if (msg.type === "delete_plan_for_day") {
          if (msg.targetDateStr) {
            const tgtSubject = msg.subject;
            if (tgtSubject) {
              const cardToDelete = savedCards.find(card => 
                (card as any).targetDateStr === msg.targetDateStr && 
                card.subject === tgtSubject
              );
              if (cardToDelete) {
                deleteCardFromDb(cardToDelete.id);
                setStatus(`Karta '${tgtSubject}' pro den ${msg.targetDateStr} byla vymazána.`);
              } else {
                setStatus(`Nenalezena karta '${tgtSubject}' pro den ${msg.targetDateStr}.`);
              }
            } else {
              const cardsToDelete = savedCards.filter(card => (card as any).targetDateStr === msg.targetDateStr);
              if (cardsToDelete.length > 0) {
                cardsToDelete.forEach(card => deleteCardFromDb(card.id));
                setStatus(`Všechny panely pro den ${msg.targetDateStr} byly vymazány.`);
              } else {
                setStatus(`Nebyly nalezeny žádné karty k vymazání pro ${msg.targetDateStr}.`);
              }
            }
          }
          return;
        }

        if (msg.type === "open_settings_view") {
          setShowSettings(true);
          setStatus("Nastavení otevřeno");
          return;
        }

        if (msg.serverContent?.modelTurn?.parts) {
          msg.serverContent.modelTurn.parts.forEach((part: any) => {
            if (part.inlineData?.data) {
              playAudioChunk(part.inlineData.data);
              setIsAiSpeaking(true);
            }
          });
        }

        if (msg.serverContent?.interrupted) {
          stopAudioPlayback();
          setIsAiSpeaking(false);
          isNewTurnRef.current = true;
        }

        if (msg.serverContent?.turnComplete) {
          isNewTurnRef.current = true;
        }

        if (msg.inputTranscription?.text) {
          setUserTranscript(prev => prev + msg.inputTranscription.text);
        }

        if (msg.outputTranscription?.text) {
          if (isNewTurnRef.current) {
            setAssistantTranscript("");
            isNewTurnRef.current = false;
          }
          setAssistantTranscript(prev => prev + msg.outputTranscription.text);
        }

        if (msg.serverContent?.modelTurn) {
          if (isNewTurnRef.current) {
            setAssistantTranscript("");
            isNewTurnRef.current = false;
          }
          msg.serverContent.modelTurn.parts.forEach((part: any) => {
            if (part.text) {
              setAssistantTranscript(prev => prev + part.text);
            }
            if (part.audioTranscription?.text) {
              setAssistantTranscript(prev => prev + part.audioTranscription.text);
            }
          });
        }

        if (msg.serverContent?.userTurn) {
          stopAudioPlayback();
          const ut = userTranscriptRef.current;
          const at = assistantTranscriptRef.current;
          if (ut.trim() || at.trim()) {
            setChatHistory(prev => [
              ...prev,
              {
                id: Math.random().toString(36).substring(7),
                userText: ut,
                assistantText: at,
                timestamp: new Date()
              }
            ]);
          }
          setUserTranscript("");
          setAssistantTranscript("");
          isNewTurnRef.current = false;
        }
      };

      ws.onclose = () => stopSession();
      ws.onerror = () => setStatus("Chyba spojení");

    } catch (err) {
      console.error("Session start crash:", err);
      setStatus("Chyba při startu");
    }
  };

  const stopSession = () => {
    setIsConnected(false);
    setStatus("Hovor vypnut");
    setIsAiSpeaking(false);
    isNewTurnRef.current = true;
    
    stopAudioPlayback();

    const ut = userTranscriptRef.current;
    const at = assistantTranscriptRef.current;
    if (ut.trim() || at.trim()) {
      setChatHistory(prev => [
        ...prev,
        {
          id: Math.random().toString(36).substring(7),
          userText: ut,
          assistantText: at,
          timestamp: new Date()
        }
      ]);
    }

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    
    setAssistantTranscript("");
    setUserTranscript("");
  };

  const startAudioProcessing = () => {
    if (!audioCtxRef.current || !streamRef.current || !wsRef.current) return;
    const source = audioCtxRef.current.createMediaStreamSource(streamRef.current);
    const processor = audioCtxRef.current.createScriptProcessor(4096, 1, 1);
    processorRef.current = processor;

    source.connect(processor);
    processor.connect(audioCtxRef.current.destination);

    processor.onaudioprocess = (e) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      const inputData = e.inputBuffer.getChannelData(0);
      const base64 = pcmToBase64(inputData);
      wsRef.current.send(JSON.stringify({ audio: base64 }));
    };
  };

  const playAudioChunk = (base64: string) => {
    if (!audioCtxRef.current) return;
    const data = base64ToFloat32(base64);
    const buffer = audioCtxRef.current.createBuffer(1, data.length, SAMPLE_RATE);
    buffer.getChannelData(0).set(data);

    const source = audioCtxRef.current.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = voiceSpeed;
    source.connect(audioCtxRef.current.destination);

    activeSourcesRef.current.push(source);

    source.onended = () => {
      activeSourcesRef.current = activeSourcesRef.current.filter(s => s !== source);
      const now = audioCtxRef.current?.currentTime || 0;
      if (nextStartTimeRef.current <= now) {
        setIsAiSpeaking(false);
      }
    };

    const now = audioCtxRef.current.currentTime;
    if (nextStartTimeRef.current < now) {
      nextStartTimeRef.current = now + 0.05;
    }

    source.start(nextStartTimeRef.current);
    nextStartTimeRef.current += (buffer.duration / voiceSpeed);
  };

  const stopAudioPlayback = () => {
    activeSourcesRef.current.forEach(source => {
      try { source.stop(); } catch {}
    });
    activeSourcesRef.current = [];
    nextStartTimeRef.current = audioCtxRef.current?.currentTime || 0;
    setIsAiSpeaking(false);
  };

  let activeCard: { id?: string; topic: string; content: string; subject?: string; } | null = null;
  if (activeCardId) {
    activeCard = savedCards.find(c => c.id === activeCardId) || null;
  }
  if (!activeCard && customCard) {
    activeCard = customCard;
  }
  if (!activeCard && researchStatus === "ready") {
    activeCard = { topic: researchTopic, content: researchResult, subject: researchSubject };
  }

  const isSearching = researchStatus === "searching";

  if (!user) {
    return (
      <div className="min-h-screen bg-[#060813] text-zinc-100 font-sans selection:bg-indigo-900/40 overflow-hidden relative flex flex-col items-center justify-center p-4">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[350px] h-[350px] bg-[#4f5ff7]/5 blur-[120px] rounded-full pointer-events-none" />
        <motion.div
          initial={{ opacity: 0, scale: 0.98, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="relative max-w-sm w-full bg-[#111322] border border-white/[5%] rounded-[24px] p-8 shadow-[0_20px_50px_rgba(0,0,0,0.6)] flex flex-col items-center text-center z-10"
        >
          <div className="relative mb-5 flex items-center justify-center select-none">
            <div className="w-12 h-12 bg-indigo-900/20 border border-[#4f5ff7]/25 rounded-2xl flex items-center justify-center shadow-lg">
              <Sparkles className="w-5 h-5 text-[#4f5ff7]" />
            </div>
          </div>

          <h1 className="text-lg font-black tracking-widest text-zinc-100 mb-1">
            Shate AI
          </h1>
          <p className="text-[10px] font-mono tracking-widest text-[#4f5ff7] uppercase mb-6 font-bold">
            Day & Routine Planner
          </p>

          <p className="text-zinc-400 text-xs min-h-[40px] leading-relaxed mb-6 max-w-[280px]">
            Tvůj asistent na plánování rutiny a celého dne.
          </p>

          <div className="w-full space-y-3">
            <button
              onClick={loginWithGoogle}
              disabled={isLoggingIn}
              className="w-full h-11 px-4 bg-zinc-100 hover:bg-white text-zinc-950 font-bold text-xs tracking-wider rounded-xl cursor-pointer pointer-events-auto transition-all shadow-md active:scale-98 disabled:scale-100 disabled:opacity-50 flex items-center justify-center gap-2 uppercase"
            >
              {isLoggingIn ? (
                <div className="w-4 h-4 border-2 border-zinc-950 border-t-transparent rounded-full animate-spin" />
              ) : (
                <>
                  <span>Přihlásit se přes Google</span>
                </>
              )}
            </button>

            <button
              onClick={loginAsGuest}
              disabled={isLoggingIn}
              className="w-full h-11 px-4 bg-[#131523] border border-white/[5%] hover:border-white/[12%] text-zinc-300 hover:text-white font-semibold text-xs tracking-wider rounded-xl cursor-pointer pointer-events-auto transition-all active:scale-98 disabled:scale-100 disabled:opacity-50 flex items-center justify-center gap-2 uppercase"
            >
              <span>Pokračovat jako host</span>
            </button>
          </div>

          {authError && (
            <p className="text-zinc-500 text-[10px] leading-relaxed mt-4 font-medium px-2 bg-rose-950/10 border border-rose-500/25 py-2 rounded-lg w-full">
              {authError}
            </p>
          )}
        </motion.div>
      </div>
    );
  }

  const createPlanForDate = async (date: Date) => {
    const dayName = date.toLocaleDateString("cs-CZ", { weekday: "long" });
    const dayFormatted = `${dayName.charAt(0).toUpperCase() + dayName.slice(1)} ${date.getDate()}.${date.getMonth() + 1}.`;
    
    const defaultContent = `### 📋 Plán na ${dayFormatted}\n\n- [ ] **08:00** Ranní rutina  \n- [ ] **12:00** Oběd  \n- [ ] **18:00** Večeře  \n- [ ] **22:00** Spánek  \n\n_Řekni Shate, co jiného plánuješ!_`;
    
    await saveCardToDb(dayFormatted, defaultContent, "Denní plán");
  };

  const getWeekDays = () => {
    const today = new Date();
    const days = [];
    // Spans 7 days: yesterday, today, and 5 upcoming days
    for (let i = -1; i <= 5; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      days.push(d);
    }
    return days;
  };

  return (
    <div className="h-screen w-screen bg-[#070913] text-zinc-100 font-sans selection:bg-indigo-900/40 overflow-hidden relative flex flex-col items-center justify-center">
      {/* Outer ambient glow */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[350px] h-[350px] bg-indigo-500/5 blur-[120px] rounded-full pointer-events-none" />

      {/* Main Centered Mobile Workspace Container */}
      <div className="w-full max-w-md h-full flex flex-col justify-between relative bg-[#070913]/90 md:border md:border-white/[4%] md:shadow-2xl md:rounded-2xl overflow-hidden p-4 md:p-5">
        {/* Header bar */}
        <header className="flex items-center justify-between pb-3 border-b border-white/[4%] shrink-0 select-none">
          <div className="flex flex-col text-left">
            <h1 className="text-sm font-black text-zinc-100 flex items-center gap-1.5 mt-0.5" id="app-title">
              <Zap className="w-4 h-4 text-[#4f5ff7] fill-[#4f5ff7]/20 drop-shadow-[0_0_8px_rgba(79,95,247,0.6)]" />
              <span>Shate</span>
            </h1>
          </div>
          
          <div className="flex items-center gap-2">
            <button 
              onClick={() => setShowSettings(true)} 
              id="settings-btn"
              className="p-1 px-2 border border-white/[5%] bg-white/[0.03] hover:bg-white/[0.08] text-zinc-400 hover:text-white rounded-lg text-[9px] font-bold uppercase transition-all tracking-wider cursor-pointer flex items-center gap-1.5"
            >
              <Settings className="w-3 h-3 text-[#4f5ff7]" />
              <span>Nastavení</span>
            </button>
          </div>
        </header>

        {/* Horizontal Weekday Tracker Scroller */}
        <div className="py-2.5 px-1 shrink-0 select-none overflow-x-auto custom-scrollbar flex items-center gap-2 border-b border-white/[3%]" id="weekday-scroller">
          {getWeekDays().map((date, idx) => {
            const isSelected = 
              date.getDate() === selectedDate.getDate() &&
              date.getMonth() === selectedDate.getMonth() &&
              date.getFullYear() === selectedDate.getFullYear();
            
            const isToday = (() => {
              const now = new Date();
              return (
                date.getDate() === now.getDate() &&
                date.getMonth() === now.getMonth() &&
                date.getFullYear() === now.getFullYear()
              );
            })();

            const dayNum = date.getDate();
            const weekdayName = date.toLocaleDateString("cs-CZ", { weekday: "short" }).replace(".", "");
            const weekdayCapitalized = weekdayName.charAt(0).toUpperCase() + weekdayName.slice(1);

            const hasCard = savedCards.some(card => {
              if ((card as any).targetDateStr) {
                return (card as any).targetDateStr === formatDateKey(date);
              }
              if (!card.createdAt?.seconds) return false;
              const cardDate = new Date(card.createdAt.seconds * 1000);
              return (
                cardDate.getDate() === date.getDate() &&
                cardDate.getMonth() === date.getMonth() &&
                cardDate.getFullYear() === date.getFullYear()
              );
            });

            return (
              <button
                key={idx}
                onClick={() => setSelectedDate(date)}
                className={`flex flex-col items-center justify-center p-1.5 rounded-xl transition-all cursor-pointer select-none shrink-0 min-w-[42px] h-[46px] relative border ${
                  isSelected 
                    ? "bg-indigo-600/10 border-[#4f5ff7]/40 text-white shadow-[0_0_12px_rgba(79,95,247,0.15)]"
                    : "bg-white/[0.02] border-white/[4%] text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04]"
                }`}
              >
                <span className={`text-[8px] font-mono uppercase tracking-wider ${isToday && !isSelected ? "text-[#4f5ff7] font-bold" : ""}`}>
                  {isToday ? "Dnes" : weekdayCapitalized}
                </span>
                <span className="text-[10px] font-extrabold mt-0.5 leading-none">
                  {dayNum}
                </span>
                
                {hasCard && (
                  <span className={`absolute bottom-1 w-1 h-1 rounded-full ${isSelected ? "bg-[#4f5ff7]" : "bg-indigo-500/50"}`} />
                )}
              </button>
            );
          })}
        </div>

        {/* Central Card container with swipe gesture support */}
        <main 
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
          className="flex-1 min-h-0 py-2.5 flex flex-col justify-between"
        >
          {/* Card Body (Active Plan or Empty State) */}
          <div className="flex-1 min-h-0 flex flex-col justify-center">
            {(() => {
              const activeCard = getCardContentAndId(selectedDate, activePanelType);
              const isCardEmpty = !activeCard.content;

              const panelThemes = {
                general: {
                  title: "Doplňující úkoly",
                  icon: "📋",
                  gradient: "from-[#121528]/95 to-[#0d0f1b]/95 border-indigo-500/10",
                  textAccent: "text-indigo-400"
                },
                morning: {
                  title: "Ranní rutina",
                  icon: "☀️",
                  gradient: "from-[#0e172a]/95 to-[#0b0c16]/95 border-blue-500/10",
                  textAccent: "text-blue-400"
                },
                evening: {
                  title: "Večerní rutina",
                  icon: "🌙",
                  gradient: "from-[#1d1612]/95 to-[#0f0e13]/95 border-amber-500/10",
                  textAccent: "text-amber-400"
                }
              };

              const currentTheme = panelThemes[activePanelType];

              return (
                <div className="flex-1 min-h-0 flex flex-col justify-between h-full">

                  {/* Active Panel container */}
                  <div className={`flex-1 min-h-0 bg-gradient-to-br ${currentTheme.gradient} border rounded-xl p-4 shadow-[0_12px_36px_rgba(0,0,0,0.5)] text-left flex flex-col overflow-hidden text-zinc-300 relative h-full`} id="active-card-container">

                    {/* Scrollable Checklist */}
                    <div className="flex-1 overflow-y-auto custom-scrollbar bg-[#060811]/40 border border-white/[4%] rounded-xl p-3.5 select-text h-full min-h-0 shadow-inner" id="markdown-scroller">
                      {isSearching ? (
                        <div className="h-full flex flex-col items-center justify-center space-y-3">
                          <div className="w-8 h-8 rounded-full bg-indigo-950/20 flex items-center justify-center border border-indigo-500/35 shadow-[0_0_15px_rgba(79,95,247,0.2)] animate-spin">
                            <Sparkles className="w-4 h-4 text-indigo-400" />
                          </div>
                          <p className="text-[9px] font-mono tracking-widest text-[#4f5ff7] uppercase animate-pulse">Sestavuji plán Shate...</p>
                        </div>
                      ) : isCardEmpty ? null : (
                        <div className="space-y-1">
                          <MarkdownRenderer 
                            text={activeCard.content} 
                            onToggleTask={(lineIdx) => handleToggleTask(activePanelType, selectedDate, lineIdx)}
                          />
                        </div>
                      )}
                    </div>

                    {/* Carousel indicator dots */}
                    <div className="flex justify-center gap-1.5 mt-2.5 shrink-0" id="panel-dots-bar">
                      <button onClick={() => setActivePanelType('general')} className="w-1.5 h-1.5 rounded-full transition-all cursor-pointer bg-white" style={{ opacity: activePanelType === 'general' ? 1 : 0.2, width: activePanelType === 'general' ? '12px' : '6px' }} />
                      <button onClick={() => setActivePanelType('morning')} className="w-1.5 h-1.5 rounded-full transition-all cursor-pointer bg-white" style={{ opacity: activePanelType === 'morning' ? 1 : 0.2, width: activePanelType === 'morning' ? '12px' : '6px' }} />
                      <button onClick={() => setActivePanelType('evening')} className="w-1.5 h-1.5 rounded-full transition-all cursor-pointer bg-white" style={{ opacity: activePanelType === 'evening' ? 1 : 0.2, width: activePanelType === 'evening' ? '12px' : '6px' }} />
                    </div>

                  </div>
                </div>
              );
            })()}
          </div>

          {/* Day Navigation Carousel Controls (ALWAYS visible) */}
          <div className="flex items-center justify-between bg-[#111322]/50 border border-white/[4%] p-2 rounded-2xl mt-3 shrink-0 select-none" id="carousel-controls">
            <button
              onClick={() => {
                const prev = new Date(selectedDate);
                prev.setDate(selectedDate.getDate() - 1);
                setSelectedDate(prev);
              }}
              id="prev-btn"
              className="py-1 px-3 bg-white/[0.02] hover:bg-white/[0.06] border border-white/[5%] rounded-xl transition-all cursor-pointer flex items-center gap-1.5 text-[9.5px] text-zinc-300 font-bold active:scale-95 shrink-0"
            >
              <ChevronLeft className="w-3.5 h-3.5 text-[#4f5ff7]" />
              <span>Předchozí den</span>
            </button>
            
            <div className="flex flex-col items-center mx-1 overflow-hidden shrink min-w-0">
              <span className="text-[9.5px] font-mono text-[#cbd5e1] uppercase font-bold text-center truncate w-full tracking-wider">
                {selectedDate.toLocaleDateString("cs-CZ", { weekday: "short", day: "numeric", month: "numeric" })}
              </span>
            </div>
            
            <button
              onClick={() => {
                const next = new Date(selectedDate);
                next.setDate(selectedDate.getDate() + 1);
                setSelectedDate(next);
              }}
              id="next-btn"
              className="py-1 px-3 bg-white/[0.02] hover:bg-white/[0.06] border border-white/[5%] rounded-xl transition-all cursor-pointer flex items-center gap-1.5 text-[9.5px] text-zinc-300 font-bold active:scale-95 shrink-0"
            >
              <span>Následující den</span>
              <ChevronRight className="w-3.5 h-3.5 text-[#4f5ff7]" />
            </button>
          </div>
        </main>

        {/* Lower interactive region with Chat and Voice */}
        <footer className="shrink-0 flex flex-col bg-transparent pt-1 select-none" id="footer-actions">
          {/* Subtitle helper bubble */}
          {(() => {
            const latestReply = chatHistory[chatHistory.length - 1]?.assistantText || "";
            const isSpeakingText = isConnected && assistantTranscript;
            const shownText = isSpeakingText ? assistantTranscript : latestReply;
            if (!shownText) return null;

            return (
              <motion.div
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                className="px-3 py-1.5 bg-indigo-950/50 border border-[#4f5ff7]/30 text-indigo-300 rounded-xl text-[10.5px] leading-relaxed max-w-sm mx-auto shadow-md backdrop-blur-md mb-2 text-center"
                id="subtitle-bubble"
              >
                <span className="font-bold text-white">Shate: </span>
                <span>{shownText}</span>
              </motion.div>
            );
          })()}

          {/* Controls row */}
          <div className="flex items-center gap-2">
            {/* Camera / Photo scanner slot */}
            <div className="shrink-0" id="photo-manager-trigger">
              <PhotoManager 
                onCardGenerated={(topic, content) => {
                  setCustomCard({ topic, content });
                  setResearchStatus("idle");
                  handleNewCardGenerated(topic, content, "Denní plán");
                }} 
                statusSetter={setStatus} 
              />
            </div>

            {/* Unified Text input */}
            <form
              onSubmit={handleSendTextMessage}
              id="chat-input-form"
              className={`relative flex items-center bg-[#131523] border gap-2 rounded-xl transition-all duration-300 h-11 grow min-w-0 ${
                isInputFocused ? "border-[#4f5ff7]/60 ring-1 ring-indigo-505/20" : "border-white/[4%]"
              }`}
            >
              <input
                type="text"
                placeholder=""
                value={textMessage}
                onChange={(e) => setTextMessage(e.target.value)}
                onFocus={() => setIsInputFocused(true)}
                onBlur={() => setIsInputFocused(false)}
                disabled={isSubmittingText}
                className="w-full bg-[#131523] bg-transparent text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none pl-3 pr-9 py-2 rounded-xl leading-none"
                id="message-input"
              />
              <button
                type="submit"
                disabled={!textMessage.trim() || isSubmittingText}
                id="send-msg-btn"
                className="absolute right-2 p-1.5 rounded-lg bg-indigo-600/10 text-indigo-400 active:scale-95 transition-all cursor-pointer h-7 w-7 flex items-center justify-center disabled:opacity-30"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </form>

            {/* Voice microphone with pulse */}
            <button
              onClick={isConnected ? stopSession : startSession}
              id="voice-toggle-btn"
              className={`w-11 h-11 flex items-center justify-center rounded-xl transition-all duration-250 cursor-pointer relative shrink-0 ${
                isConnected 
                  ? "bg-rose-500/20 border border-rose-500/50 text-rose-300 shadow-[0_0_8px_rgba(239,68,68,0.25)] animate-pulse" 
                  : "bg-white/[0.03] border border-white/[5%] text-zinc-300 hover:text-white"
              }`}
            >
              {isConnected ? (
                <PhoneOff className="w-4.5 h-4.5 text-rose-400" />
              ) : (
                <Smartphone className="w-4.5 h-4.5" />
              )}
            </button>
          </div>
        </footer>
      </div>

      {/* Settings Modal */}
      <AnimatePresence>
        {showSettings && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/80 backdrop-blur-md z-50 flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ scale: 0.95, y: 15 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 15 }}
              className="bg-[#111322] border border-white/[10%] rounded-[24px] w-full max-w-sm p-6 shadow-2xl relative"
            >
              <div className="flex justify-between items-center pb-3 border-b border-white/[5%] mb-5">
                <h3 className="text-xs font-black tracking-wider text-zinc-200 uppercase flex items-center gap-2">
                  <Settings className="w-4 h-4 text-[#4f5ff7]" />
                  <span>Nastavení Shate</span>
                </h3>
                <button
                  onClick={() => setShowSettings(false)}
                  className="p-1 text-zinc-400 hover:text-white rounded-lg bg-white/[0.03] hover:bg-white/[0.08] transition-all cursor-pointer border border-white/[5%]"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-6 text-left">
                {/* Voice speed setting */}
                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] font-mono tracking-wider text-zinc-400 uppercase font-bold flex items-center gap-1.5">
                      <Sliders className="w-3.5 h-3.5 text-indigo-400" />
                      Rychlost hlasu (TTS)
                    </span>
                    <span className="text-[10px] font-mono text-[#4f5ff7] font-bold">
                      {voiceSpeed.toFixed(1)}x
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0.8"
                    max="2.0"
                    step="0.1"
                    value={voiceSpeed}
                    onChange={(e) => {
                      const speed = parseFloat(e.target.value);
                      setVoiceSpeed(speed);
                      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                        wsRef.current.send(JSON.stringify({
                          type: "voice_speed_changed",
                          speed: speed
                        }));
                      }
                    }}
                    className="w-full accent-[#4f5ff7] bg-white/[0.05] h-1.5 rounded-lg cursor-pointer"
                  />
                  <p className="text-[9px] text-zinc-500 leading-normal">
                    Vyšší rychlost odpovídá přirozenějšímu tónu Shate. Výchozí je 1.4x.
                  </p>
                </div>

                {/* Profile Settings info */}
                <div className="p-3 bg-white/[0.02] border border-white/[4%] rounded-xl">
                  <div className="text-[8px] font-mono tracking-wider text-zinc-500 uppercase font-bold mb-1">Přihlášený uživatel</div>
                  <div className="text-xs font-bold text-zinc-300 truncate">{user?.displayName || "Anonymní Host"}</div>
                  <div className="text-[9px] font-mono text-[#4f5ff7] truncate mt-0.5">{user?.email || "host@shate.ai"}</div>
                </div>



                {/* Actions */}
                <div className="pt-2">
                  <button
                    onClick={() => {
                      setShowSettings(false);
                      handleSignOut();
                    }}
                    className="w-full h-10 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/20 hover:border-rose-500/40 text-rose-400 text-xs font-bold uppercase rounded-xl transition-all cursor-pointer flex items-center justify-center gap-2"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    Odhlásit se
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes custom-wave-bounce {
          0%, 100% { transform: scaleY(0.4); }
          50% { transform: scaleY(1.0); }
        }
        .animate-wave-speed-1 {
          animation: custom-wave-bounce 0.8s infinite ease-in-out;
          transform-origin: bottom;
        }
        .animate-wave-speed-2 {
          animation: custom-wave-bounce 1.1s infinite cubic-bezier(0.25, 0.8, 0.25, 1);
          transform-origin: bottom;
          animation-delay: 150ms;
        }
        .animate-wave-speed-3 {
          animation: custom-wave-bounce 0.9s infinite ease-in-out;
          transform-origin: bottom;
          animation-delay: 300ms;
        }
        .animate-wave-speed-4 {
          animation: custom-wave-bounce 1.3s infinite cubic-bezier(0.25, 1, 0.5, 1);
          transform-origin: bottom;
          animation-delay: 50ms;
        }
        .animate-wave-speed-5 {
          animation: custom-wave-bounce 0.7s infinite ease-in-out;
          transform-origin: bottom;
          animation-delay: 200ms;
        }
        .custom-scrollbar::-webkit-scrollbar {
          width: 5px;
          height: 5px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.05);
          border-radius: 9px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.12);
        }
      `}} />
    </div>
  );
}

