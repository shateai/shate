import express from "express";
import path from "path";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, LiveServerMessage, Modality, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const PORT = 3000;
const app = express();
app.use(express.json({ limit: "25mb" }));
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

let cachedAiClient: GoogleGenAI | null = null;
let lastUsedApiKey: string | null = null;

async function fetchSharedApiKey(): Promise<string | null> {
  try {
    const projectId = "gen-lang-client-0057515834";
    const apiKey = "AIzaSyDJreMZv1CexPEftGXJIGaBMrYB446Eq7Y";
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/settings/gemini?key=${apiKey}`;
    
    const res = await fetch(url);
    if (!res.ok) {
      return null;
    }
    const data = await res.json();
    if (data && data.fields && data.fields.apiKey && data.fields.apiKey.stringValue) {
      return data.fields.apiKey.stringValue;
    }
  } catch (err) {
    console.error("Error fetching shared API key from Firestore:", err);
  }
  return null;
}

async function getAiClient(): Promise<GoogleGenAI> {
  const dbApiKey = await fetchSharedApiKey();
  const keyToUse = dbApiKey || process.env.GEMINI_API_KEY;
  if (!keyToUse) {
    throw new Error("No Gemini API key found. Please configure it in Settings or environment variables.");
  }
  
  if (cachedAiClient && lastUsedApiKey === keyToUse) {
    return cachedAiClient;
  }
  
  console.log(`Initializing GoogleGenAI client with key: ${keyToUse.slice(0, 10)}...`);
  cachedAiClient = new GoogleGenAI({
    apiKey: keyToUse,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });
  lastUsedApiKey = keyToUse;
  return cachedAiClient;
}

async function startServer() {
  // Upgrade handling for WebSockets
  server.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url || '', `http://${request.headers.host}`);
    if (pathname === '/ws-live') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", async (clientWs: WebSocket) => {
    console.log("Client connected to live AI session");
    
    let session: any = null;
    let isReady = false;
    const audioQueue: string[] = [];
    let frameCount = 0;

    // Cache variables for state to avoid speaking when client connects/updates
    let cachedExistingCards: any[] = [];
    let cachedSelectedDateStr = "";
    let cachedCurrentDateStr = "";
    let hasPendingStateSync = false;

    try {
      const activeAi = await getAiClient();
      session = await activeAi.live.connect({
        model: "gemini-3.1-flash-live-preview",
        callbacks: {
          onmessage: async (message: LiveServerMessage) => {
            // Forward everything to client for simplicity
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify(message));
            }

            // Look for toolCalls for background research and speed adjustments
            if (message.toolCall?.functionCalls) {
              for (const fc of message.toolCall.functionCalls) {
                if (fc.name === "perform_web_research") {
                  const topic = (fc.args as any)?.topic || "obecné téma";
                  console.log(`Intercepted perform_web_research for topic: "${topic}"`);

                  // Reply immediately to tool call, unblocking model speech queue
                  try {
                    session.sendToolResponse({
                      functionResponses: [{
                        id: fc.id,
                        name: fc.name,
                        response: {
                          output: {
                            status: `Výzkum na téma "${topic}" začal úspěšně na pozadí.`
                          }
                        }
                      }]
                    });
                  } catch (err) {
                    console.error("Failed to send tool response to live session:", err);
                  }

                  // Inform client that research started
                  if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({
                      type: "research_started",
                      topic: topic
                    }));
                  }

                  // Run grounding search in raw background thread (no awaiting!)
                  (async () => {
                    let bgRes: any = null;
                    let usedSearch = true;
                    try {
                      console.log(`Starting background grounding query for: "${topic}"`);
                      const activeAi = await getAiClient();
                      bgRes = await activeAi.models.generateContent({
                        model: "gemini-3.5-flash",
                        contents: `Vytvoř prosím přehledný pomocný tahák (cheat sheet) k učení a krátký přehled na téma "${topic}". 
Výsledek vrať VÝHRADNĚ jako platný JSON objekt se dvěma klíči:
1. "content" (stručný a přehledný obsah taháku v češtině formátovaný v Markdownu s odrážkami a tučnými slovy, může obsahovat vzorce, překlady či příklady a případně 1-2 nejlepší a doporučené internetové odkazy z vyhledávání)
2. "subject" (krátký, výstižný český název školního předmětu, např. Matematika, Fyzika, Chemie, Biologie, Dějepis, Zeměpis, Čeština, Cizí jazyky, Informatika, Společenské vědy).
Nevracej žádné jiné věci nebo text okolo, pouze čistý platný JSON objekt.`,
                        config: {
                          tools: [{ googleSearch: {} }]
                        }
                      });
                    } catch (searchErr: any) {
                      console.warn("Background grounding search with Google Search tool failed, trying fallback without Google Search...", searchErr.message || searchErr);
                      usedSearch = false;
                      try {
                        const activeAi = await getAiClient();
                        bgRes = await activeAi.models.generateContent({
                          model: "gemini-3.5-flash",
                          contents: `Vytvoř prosím přehledný pomocný tahák (cheat sheet) z tvých znalostí na téma "${topic}".
Výsledek vrať VÝHRADNĚ jako platný JSON objekt se dvěma klíči:
1. "content" (rychlá pomůcka k učení přizpůsobená tématu s odrážkami, krátkými odstavce, vzorci nebo definicemi, formátovaná v češtině pomocí Markdownu)
2. "subject" (krátký český název školního předmětu, např. Matematika, Fyzika, Chemie, Biologie, Dějepis, Zeměpis, Čeština, Cizí jazyky, Informatika).`,
                        });
                      } catch (fallbackErr: any) {
                        console.error("Critical: both background research query with and without search failed:", fallbackErr);
                        if (clientWs.readyState === WebSocket.OPEN) {
                          clientWs.send(JSON.stringify({
                            type: "research_error",
                            topic: topic,
                            error: "Došlo k chybě při vygenerování podkladů."
                          }));
                        }
                        return;
                      }
                    }

                    try {
                      const sources: Array<{ title: string; url: string }> = [];
                      if (usedSearch && bgRes) {
                        const chunks = bgRes.candidates?.[0]?.groundingMetadata?.groundingChunks;
                        if (chunks) {
                          for (const chunk of chunks) {
                            if (chunk.web?.uri) {
                              sources.push({
                                title: chunk.web.title || "Zdroj",
                                url: chunk.web.uri
                              });
                            }
                          }
                        }
                      }

                      let resultText = "Pro toto téma se nepodařilo nalézt podklady.";
                      let subjectText = "Všeobecné";
                      try {
                        const parsedObj = JSON.parse(bgRes?.text || "{}");
                        resultText = parsedObj.content || bgRes?.text || "";
                        subjectText = parsedObj.subject || "Všeobecné";
                      } catch {
                        // Fallback parsing if JSON was surrounded by markdown quotes
                        let cleaned = (bgRes?.text || "").trim();
                        if (cleaned.startsWith("```json")) {
                          cleaned = cleaned.replace(/^```json/, "").replace(/```$/, "").trim();
                        } else if (cleaned.startsWith("```")) {
                          cleaned = cleaned.replace(/^```/, "").replace(/```$/, "").trim();
                        }
                        try {
                          const parsedObj = JSON.parse(cleaned);
                          resultText = parsedObj.content || bgRes?.text || "";
                          subjectText = parsedObj.subject || "Všeobecné";
                        } catch {
                          resultText = bgRes?.text || "Pro toto téma se nepodařilo nalézt podklady.";
                          subjectText = "Všeobecné";
                        }
                      }

                      if (!usedSearch) {
                        resultText += "\n\n*(Sestaveno z vědomostí Shate - vyhledávání má pauzu.)*";
                      }

                      console.log(`Background grounding search completed for topic: "${topic}" (usedSearch=${usedSearch}, subject=${subjectText})`);

                      if (clientWs.readyState === WebSocket.OPEN) {
                        clientWs.send(JSON.stringify({
                          type: "research_ready",
                          topic: topic,
                          result: resultText,
                          subject: subjectText,
                          sources: sources
                        }));
                      }

                      // Instruct model to state research completed
                      if (session) {
                        session.sendRealtimeInput({
                          text: `[SYSTEM: Průzkum na téma "${topic}" byl právě dokončen a výsledky byly zobrazeny uživateli na obrazovce. ${!usedSearch ? 'Vyhledávání na internetu mělo vyčerpanou kvótu, takže jsi výzkum složil ze svých rozsáhlých vestavěných znalostí.' : ''} Oznam to uživateli s nadšením a navrhni, že ho to začneš učit. Zeptej se, s čím chce začít.]`
                        });
                      }

                    } catch (err) {
                      console.error("Background research error during completion processing:", err);
                      if (clientWs.readyState === WebSocket.OPEN) {
                        clientWs.send(JSON.stringify({
                          type: "research_error",
                          topic: topic,
                          error: "Došlo k chybě při vyhodnocení podkladů."
                        }));
                      }
                    }
                  })();
                }

                if (fc.name === "change_voice_speed") {
                  const speed = Number((fc.args as any)?.speed) || 1.4;
                  console.log(`Intercepted change_voice_speed request: speed=${speed}`);

                  try {
                    session.sendToolResponse({
                      functionResponses: [{
                        id: fc.id,
                        name: fc.name,
                        response: {
                          output: {
                            status: `Rychlost řeči byla přenastavena na ${speed}x.`
                          }
                        }
                      }]
                    });
                  } catch (err) {
                    console.error("Failed to send tool response for change_voice_speed:", err);
                  }

                  if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({
                      type: "voice_speed_changed",
                      speed: speed
                    }));
                  }
                }

                if (fc.name === "display_study_card") {
                  const topic = (fc.args as any)?.topic || "Pomocný tahák";
                  const content = (fc.args as any)?.content || "";
                  const subject = (fc.args as any)?.subject || "Všeobecné";
                  const osnova = (fc.args as any)?.osnova || "";
                  const lessonPlan = (fc.args as any)?.lessonPlan || null;
                  const lessonIndex = (fc.args as any)?.lessonIndex || null;
                  const targetDateStr = (fc.args as any)?.targetDateStr || null;
                  console.log(`Intercepted display_study_card request: topic="${topic}" subject="${subject}" targetDateStr="${targetDateStr}"`);

                  try {
                    session.sendToolResponse({
                      functionResponses: [{
                        id: fc.id,
                        name: fc.name,
                        response: {
                          output: {
                            status: "Studijní karta úspěšně zobrazena na obrazovce."
                          }
                        }
                      }]
                    });
                  } catch (err) {
                    console.error("Failed to send tool response for display_study_card:", err);
                  }

                  if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({
                      type: "display_study_card",
                      topic: topic,
                      content: content,
                      subject: subject,
                      osnova: osnova,
                      lessonPlan: lessonPlan,
                      lessonIndex: lessonIndex,
                      targetDateStr: targetDateStr
                    }));
                  }
                }

                if (fc.name === "hide_card") {
                  console.log("Intercepted hide_card request");

                  try {
                    session.sendToolResponse({
                      functionResponses: [{
                        id: fc.id,
                        name: fc.name,
                        response: {
                          output: {
                            status: "Karta byla úspěšně skryta."
                          }
                        }
                      }]
                    });
                  } catch (err) {
                    console.error("Failed to send tool response for hide_card:", err);
                  }

                  if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({
                      type: "hide_card"
                    }));
                  }
                }

                if (fc.name === "switch_view_day") {
                  const targetDateStr = (fc.args as any)?.targetDateStr || "";
                  console.log(`Intercepted switch_view_day request: targetDateStr="${targetDateStr}"`);

                  try {
                    session.sendToolResponse({
                      functionResponses: [{
                        id: fc.id,
                        name: fc.name,
                        response: {
                          output: {
                            status: `Pohled úspěšně přepnut na den ${targetDateStr}.`
                          }
                        }
                      }]
                    });
                  } catch (err) {
                    console.error("Failed to send tool response for switch_view_day:", err);
                  }

                  if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({
                      type: "switch_view_day",
                      targetDateStr: targetDateStr
                    }));
                  }
                }

                if (fc.name === "delete_plan_for_day") {
                  const targetDateStr = (fc.args as any)?.targetDateStr || "";
                  const subject = (fc.args as any)?.subject || null;
                  console.log(`Intercepted delete_plan_for_day request: targetDateStr="${targetDateStr}" subject="${subject}"`);

                  try {
                    session.sendToolResponse({
                      functionResponses: [{
                        id: fc.id,
                        name: fc.name,
                        response: {
                          output: {
                            status: subject 
                              ? `Panel '${subject}' pro den ${targetDateStr} byl úspěšně v databázi vymazán.`
                              : `Kompletní plán pro den ${targetDateStr} byl úspěšně v databázi vymazán.`
                          }
                        }
                      }]
                    });
                  } catch (err) {
                    console.error("Failed to send tool response for delete_plan_for_day:", err);
                  }

                  if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({
                      type: "delete_plan_for_day",
                      targetDateStr: targetDateStr,
                      subject: subject
                    }));
                  }
                }

                if (fc.name === "open_settings_view") {
                  console.log("Intercepted open_settings_view request");

                  try {
                    session.sendToolResponse({
                      functionResponses: [{
                        id: fc.id,
                        name: fc.name,
                        response: {
                          output: {
                            status: "Sekce nastavení v rozhraní byla úspěšně otevřena."
                          }
                        }
                      }]
                    });
                  } catch (err) {
                    console.error("Failed to send tool response for open_settings_view:", err);
                  }

                  if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({
                      type: "open_settings_view"
                    }));
                  }
                }

                if (fc.name === "close_settings_view") {
                  console.log("Intercepted close_settings_view request");

                  try {
                    session.sendToolResponse({
                      functionResponses: [{
                        id: fc.id,
                        name: fc.name,
                        response: {
                          output: {
                            status: "Okno s nastavením bylo v rozhraní úspěšně zavřeno."
                          }
                        }
                      }]
                    });
                  } catch (err) {
                    console.error("Failed to send tool response for close_settings_view:", err);
                  }

                  if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({
                      type: "close_settings_view"
                    }));
                  }
                }

                if (fc.name === "get_daily_plan") {
                  const targetDateStr = (fc.args as any)?.targetDateStr || cachedSelectedDateStr || cachedCurrentDateStr;
                  const targetSubject = (fc.args as any)?.subject || null;
                  console.log(`Intercepted get_daily_plan request: targetDateStr="${targetDateStr}" subject="${targetSubject}"`);

                  let planContent = "";
                  let planFound = false;

                  if (targetSubject) {
                    const isMorning = targetSubject.toLowerCase().includes("ranní") || targetSubject.toLowerCase().includes("morning");
                    const isEvening = targetSubject.toLowerCase().includes("večerní") || targetSubject.toLowerCase().includes("evening");

                    const matchedCard = cachedExistingCards.find(card => {
                      const cardSub = (card.subject || "Denní plán").toLowerCase();
                      if (isMorning) {
                        return cardSub.includes("ranní") || card.targetDateStr === "routine_morning";
                      }
                      if (isEvening) {
                        return cardSub.includes("večerní") || card.targetDateStr === "routine_evening";
                      }
                      return card.targetDateStr === targetDateStr && (cardSub.includes("denní") || cardSub.includes("plán") || cardSub.includes("doplň"));
                    });

                    if (matchedCard) {
                      planFound = true;
                      planContent = `### Panel: "${matchedCard.subject || "Denní plán"}"\n${matchedCard.content}`;
                    } else {
                      const label = isMorning ? "Ranní rutina" : (isEvening ? "Večerní rutina" : "Denní plán");
                      planContent = `V panelu "${label}" pro den ${targetDateStr} zatím nejsou žádné úkoly.`;
                    }
                  } else {
                    // List all three panels (morning, evening, and the specific day's Denní plán)
                    const morningCard = cachedExistingCards.find(card => 
                      (card.subject || "").toLowerCase().includes("ranní") || card.targetDateStr === "routine_morning"
                    );
                    const eveningCard = cachedExistingCards.find(card => 
                      (card.subject || "").toLowerCase().includes("večerní") || card.targetDateStr === "routine_evening"
                    );
                    const dailyCard = cachedExistingCards.find(card => 
                      card.targetDateStr === targetDateStr && 
                      ((card.subject || "Denní plán").toLowerCase().includes("denní") || (card.subject || "Denní plán").toLowerCase().includes("plán"))
                    );

                    const sections: string[] = [];
                    sections.push(`### Panel: "Ranní rutina" (Globální rutina)\n${morningCard ? morningCard.content : "- Zatím žádné úkoly v ranní rutině."}`);
                    sections.push(`### Panel: "Večerní rutina" (Globální rutina)\n${eveningCard ? eveningCard.content : "- Zatím žádné úkoly ve večerní rutině."}`);
                    sections.push(`### Panel: "Denní plán" (Pro konkrétní datum ${targetDateStr})\n${dailyCard ? dailyCard.content : "- Zatím žádné doplňující úkoly pro tento den."}`);

                    planFound = true;
                    planContent = sections.join("\n\n");
                  }

                  try {
                    session.sendToolResponse({
                      functionResponses: [{
                        id: fc.id,
                        name: fc.name,
                        response: {
                          output: {
                            currentDate: cachedCurrentDateStr,
                            selectedDate: cachedSelectedDateStr,
                            requestedDate: targetDateStr,
                            requestedSubject: targetSubject,
                            planFound: planFound,
                            planContent: planContent
                          }
                        }
                      }]
                    });
                  } catch (err) {
                    console.error("Failed to send tool response for get_daily_plan:", err);
                  }
                }

                if (fc.name === "switch_panel") {
                  const panel = (fc.args as any)?.panel || "Denní plán";
                  console.log(`Intercepted switch_panel request: panel="${panel}"`);

                  try {
                    session.sendToolResponse({
                      functionResponses: [{
                        id: fc.id,
                        name: fc.name,
                        response: {
                          output: {
                            status: `Aktivní panel v rozhraní byl úspěšně přepnut na ${panel}`
                          }
                        }
                      }]
                    });
                  } catch (err) {
                    console.error("Failed to send tool response for switch_panel:", err);
                  }

                  if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({
                      type: "switch_panel",
                      panel: panel
                    }));
                  }
                }
              }
            }
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } }, 
          },
          systemInstruction: `POZNÁMKA K INICIACI RELACE: Na začátku relace nebo po spuštění spojení NIKDY nic neříkej jako první, neposílej žádné automatické uvítání a nezačínej mluvit sám od sebe. Zůstaň naprosto potichu, neodpovídej na synchronizační systémové aktualizace a tiché aktualizace stavu, a vyčkej, až uživatel sám jako první promluví do mikrofonu!

Jsi Shate, inteligentní hlasový asistent a osobní denní plánovač. Mluv česky, stručně, srozumitelně a klidně. Vždy vystupuj jako kluk/muž (mluv v mužském rodě, např. 'přidal jsem', 'naplánoval jsem').

JSI POUZE KALENDÁŘ A PLÁNOVAČ - ZÁKAZ TVORBY SHRNUTÍ A VYHLEDÁVÁNÍ:
Pokud se tě uživatel zeptá na libovolnou obecnou otázku nebo informaci, odpověz mu pouze stručně, lidsky a pouze hlasově. Je PŘÍSNĚ ZAKÁZÁNO k obecným otázkám vyhledávat informace na webu nebo vytvářet/měnit jakékoliv karty se shrnutím či lekce! Žádný nástroj (např. \`display_study_card\`) pro obecné otázky nevolat!

TŘI SAMOSTATNÉ PANELY (GLOBÁLNÍ RUTINY VS DENNÍ ÚKOLY):
Každý den má 3 samostatné panely, které mají odlišné seznamy úkolů:
1. Ranní rutina: "Ranní rutina". Je to GLOBÁLNÍ RUTINA, která je pro všechny dny stejná a nemění se den ode dne. Pokud ji měníš, ukládej ji vždy se stejným subject "Ranní rutina" a targetDateStr "routine_morning".
2. Večerní rutina: "Večerní rutina". Je to GLOBÁLNÍ RUTINA, která je pro všechny dny stejná a nemění se den ode dne. Pokud ji měníš, ukládej ji se subject "Večerní rutina" and targetDateStr "routine_evening".
3. Denní plán (Doplňující úkoly): "Denní plán". Jsou to specifické úkoly pro konkrétní kalendářní den, které si uživatel plánuje každý den nově. Vždy se ukládá s datem targetDateStr patřičného dne.

PŘÍSNÝ ZÁKAZ KROZ-KONTAMINACE SEZNAMŮ:
- Každý panel je zcela autonomní. NIKDY nemíchej ani neslučuj úkoly mezi těmito panely!
- Pokud chce uživatel odškrtnout, přidat nebo upravit úkol, a ty nevíš, ve kterém panelu leží, VŽDY nejprve zavolej funkci \`get_daily_plan\` BEZ parametru \`subject\` (subject nech prázdný). Tím získáš všechny 3 panely najonou! Poté v obdrženém textu vyhledej požadovaný úkol, uprav patřičný panel a ulož jej zpátky zavoláním \`display_study_card\` se správným subject (např. "Ranní rutina" s targetDateStr "routine_morning" nebo "Denní plán" se zvoleným datem)!
- Pokud má uživatel podobný úkol ve dvou panelech a chce ho změnit pouze v jednom, uprav POUZE tento jeden konkrétní panel!

ZPŮSOBY MAZÁNÍ, ÚPRAVY A POHYBU:
1. POHYB MEZI DNY: Pokud uživatel požádá o přepnutí, zobrazení nebo přechod na jiný den, získej příslušné datum YYYY-MM-DD a zavolej funkci 'switch_view_day'.
2. POHYB MEZI PANELY: Pokud uživatel požádá o přepnutí panelu (např. 'přejdi na ranní rutinu', 'zobraz večerní rutinu', 'přepni na denní plán'), zavolej funkci \`switch_panel\` se správným českým názvem cílového panelu (tj. 'Ranní rutina', 'Večerní rutina', nebo 'Denní plán').
3. MAZÁNÍ CELÉHO PANELU NEBO DNE: Pokud chce uživatel smazat nebo odstranit celý panel, zavolej funkci \`delete_plan_for_day\` a vyplň jak cílové datum \`targetDateStr\` (např. '2026-05-24'), tak i parameter \`subject\` přesným českým názvem daného panelu.
4. MAZÁNÍ JEDNOTLIVÝCH ÚKOLŮ/POLOŽEK: Pokud tě uživatel požádá o smazání jedné konkrétní položky/úkolu, zavolej \`get_daily_plan\` pro kontrolu všech panelů, odstraň tento jeden řádek a ulož aktualizovanou podobu voláním \`display_study_card\` se stejným subject.
5. OZNAČENÍ HOTOVÉHO ÚKOLU: Pokud chce uživatel odškrtnout nějaký úkol, najdi ho v panelech (zavolej \`get_daily_plan\` bez subject), označ jej jako dokončený tak, že na začátek řádku k němu napíšeš '[x]' (např. '- [x] Název úkolu'), a fyzicky tento řádek přesuň na úplný konec seznamu úkolů (dolů) na dané kartě! Poté ulož změnu voláním \`display_study_card\` pro modifikovaný panel.
6. OTEVŘENÍ NASTAVENÍ: Zavolej 'open_settings_view' při požadavku.`,
          outputAudioTranscription: {},
          inputAudioTranscription: {},
          tools: [
            {
              functionDeclarations: [
                {
                  name: "change_voice_speed",
                  description: "Změní rychlost mluvení/hlasu asistenta Shate. Použít, pokud uživatel požádá o mluvení pomaleji / zpomalení nebo rychleji / zrychlení.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      speed: {
                        type: Type.NUMBER,
                        description: "Nová rychlost mluvení (např. 1.0 pro normální rychlost, 1.4 pro výchozí rychlou/energickou, 0.85 pro velmi pomalou)."
                      }
                    },
                    required: ["speed"]
                  }
                },
                {
                  name: "display_study_card",
                  description: "Uloží a zobrazí v rozhraní uživatele kartu/panel s úkoly nebo rutinou pro daný den. Použij po get_daily_plan pro přidání, úpravu nebo splnění úkolů v ranní rutině, večerní rutině nebo doplňujících úkolech (Denním plánu).",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      topic: {
                        type: Type.STRING,
                        description: "Určuje název/okruh tématu panelu. Pro ranní rutinu zadej 'Ranní rutina', pro večerní rutinu zadej 'Večerní rutina', pro doplňující úkoly zadej 'Dodatečné úkoly'."
                      },
                      content: {
                        type: Type.STRING,
                        description: "Markdown seznam úkolů v dané kartě (např. '- [ ] Úkol 1\\n- [ ] Úkol 2'). Zde VŽDY uváděj POUZE a doslova ty úkoly, které ti uživatel zadal. Je přísně zakázáno si domýšlet jakékoliv neobjednané úkoly!"
                      },
                      subject: {
                        type: Type.STRING,
                        description: "Určuje hlavní název panelu/sekce. Pro ranní rutinu zadej 'Ranní rutina', pro večerní rutinu zadej 'Večerní rutina', pro doplňující úkoly zadej 'Denní plán'."
                      },
                      targetDateStr: {
                        type: Type.STRING,
                        description: "Cílové datum dne, pro který je plán určen, ve formátu YYYY-MM-DD (např. '2026-05-24'). Urči jej správně podle aktuálního času a případného zadání uživatele (např. 'na zítra')."
                      }
                    },
                    required: ["topic", "content", "subject"]
                  }
                },
                {
                  name: "hide_card",
                  description: "Zavře / skryje aktivní zobrazenou kartu ze obrazovky.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {}
                  }
                },
                {
                  name: "switch_panel",
                  description: "Přepne aktivní zobrazený panel/kartu v uživatelském rozhraní (např. 'přejdi na ranní rutinu', 'zobraz večerní rutinu', 'přepni na denní plán').",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      panel: {
                        type: Type.STRING,
                        description: "Název panelu k zobrazení. Povolené hodnoty: 'Ranní rutina', 'Večerní rutina', 'Denní plán'."
                      }
                    },
                    required: ["panel"]
                  }
                },
                {
                  name: "switch_view_day",
                  description: "Přepne zobrazení v uživatelském rozhraní na jiný den (např. včera, dnes, zítra, nebo libovolné specifické datum).",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      targetDateStr: {
                        type: Type.STRING,
                        description: "Cílové datum dne, na který se má pohled přepnout, ve formátu YYYY-MM-DD (např. '2026-05-24'). Vyvodit správně ze zadání uživatele (např. 'zítra')."
                      }
                    },
                    required: ["targetDateStr"]
                  }
                },
                {
                  name: "delete_plan_for_day",
                  description: "Vymaže kompletně celý denní plán nebo specifickou kartu/panel pro konkrétní den.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      targetDateStr: {
                        type: Type.STRING,
                        description: "Cílové datum dne, pro který se má plán vymazat, ve formátu YYYY-MM-DD (např. '2026-05-24')."
                      },
                      subject: {
                        type: Type.STRING,
                        description: "Nepovinné. Krátký název konkrétního panelu, který se má smazat (např. 'Ranní rutina', 'Večerní rutina', 'Denní plán' nebo jiný název k smazání). Pokud chybí, vymažou se kompletně všechny panely pro daný den."
                      }
                    },
                    required: ["targetDateStr"]
                  }
                },
                {
                  name: "open_settings_view",
                  description: "Otevře okno / panel s nastavením v aplikaci na základě žádosti uživatele (např. 'otevři nastavení').",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {}
                  }
                },
                {
                  name: "get_daily_plan",
                  description: "Získá seznam úkolů, denní plán nebo nastavené rutiny pro konkrétní den a konkrétní panel.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      targetDateStr: {
                        type: Type.STRING,
                        description: "Nepovinné. Cílové datum dne, pro který chceš získat plán, ve formátu YYYY-MM-DD (např. '2026-05-24'). Pokud nezadáš, použije se právě vybraný nebo dnešní den."
                      },
                      subject: {
                        type: Type.STRING,
                        description: "Nepovinné. Krátký název konkrétního panelu/karty, kterou chceš přečíst (např. 'Ranní rutina', 'Večerní rutina', 'Denní plán'). Pokud nezadáš, získáš všechny dostupné panely pro daný den."
                      }
                    },
                    required: []
                  }
                }
              ]
            }
          ]
        },
      });

      isReady = true;
      console.log("Gemini Live API connected successfully.");
      
      // Notify the client that the session is ready
      clientWs.send(JSON.stringify({ type: "session_ready" }));

      // Flush any queued audio received during connection phase
      if (audioQueue.length > 0) {
        console.log(`Flushing ${audioQueue.length} queued audio chunks to active session...`);
        while (audioQueue.length > 0) {
          const queuedAudio = audioQueue.shift();
          if (queuedAudio && session) {
            session.sendRealtimeInput({
              audio: { data: queuedAudio, mimeType: "audio/pcm;rate=16000" },
            });
          }
        }
      }

      clientWs.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.audio) {
            if (!isReady || !session) {
              // Store audio packet until the session connection resolves
              audioQueue.push(msg.audio);
              if (audioQueue.length % 10 === 0) {
                console.log(`Session connecting... queued ${audioQueue.length} audio chunks`);
              }
            } else {
              if (hasPendingStateSync) {
                hasPendingStateSync = false;
              }
              session.sendRealtimeInput({
                audio: { data: msg.audio, mimeType: "audio/pcm;rate=16000" },
              });
            }
          }
          if (msg.video) {
            if (isReady && session) {
              frameCount++;
              if (frameCount % 10 === 0) console.log(`Received ${frameCount} video frames from client`);
              session.sendRealtimeInput({
                video: { data: msg.video, mimeType: 'image/jpeg' }
              });
            }
          }
          if (msg.type === "sync_app_state") {
            if (msg.payload) {
              const info = msg.payload;
              cachedExistingCards = info.existingCards || [];
              cachedSelectedDateStr = info.selectedDateStr || "";
              cachedCurrentDateStr = info.currentDateStr || "";
              hasPendingStateSync = true;
              console.log("Cached app state on server. Pending state sync marked true. Date:", cachedSelectedDateStr);
            }
          }
          if (msg.toolResponse) {
            if (isReady && session) {
              session.sendToolResponse(msg.toolResponse);
            }
          }
          if (msg.end) {
            if (session) session.close();
          }
        } catch (err) {
          console.error("Error processing client message:", err);
        }
      });

      clientWs.on("close", () => {
        console.log("Client disconnected");
        if (session) session.close();
      });

    } catch (err) {
      console.error("Failed to connect to Gemini Live:", err);
      clientWs.close();
    }
  });

  // API routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  app.post("/api/chat-message", async (req, res) => {
    try {
      const { message, selectedDateStr, currentDateStr, existingCards } = req.body;
      if (!message) {
        return res.status(400).json({ error: "Zpráva nebyla poskytnuta." });
      }

      console.log(`Received text message from user: "${message}"`);
      const existingCardsFormatter = existingCards && existingCards.length > 0
        ? existingCards.map((c: any) => `Karta/Panel: "${c.subject || "Denní plán"}" (Záhlaví/Téma: "${c.topic}", Datum: ${c.targetDateStr || ""})\nObsah:\n${c.content}`).join("\n\n")
        : "Žádné existující karty dne.";

      // Invoke Gemini to generate textual conversational feedback and optional card structured content
      const activeAi = await getAiClient();
      const response = await activeAi.models.generateContent({
        model: "gemini-3.5-flash",
        contents: `Jsi Shate, inteligentní osobní asistent a průvodce dnem. Vždy vystupuj jako kluk/muž (mluv v mužském rodě, např. 'naplánoval jsem', 'přidal jsem'). Uživatel ti napsal zprávu v češtině: "${message}".
Tvoje odpověď musí být přátelská, srozumitelná, stručná a realizačně přesná.

AKTUÁLNÍ KONTEXT:
- Dnešní datum (currentDate): ${currentDateStr || "neznámé"}
- Aktuálně vybraný den v kalendáři (selectedDate): ${selectedDateStr || "neznámé"}
- Existující karty dne a jejich úkolovníky v databázi:
${existingCardsFormatter}

TŘI PANELY NA KAŽDÝ DEN (STARTUJÍ ZCELA PRÁZDNÉ):
Každý den v týdnu má 3 samostatné panely/karty s úkolovníky, které může uživatel odškrtávat. Tyto panely startují zcela prázdné a obsahují výhradně úkoly určené uživatelem:
1. Doplňující úkoly (subject: "Denní plán", topic: "Dodatečné úkoly").
2. Ranní rutina (subject: "Ranní rutina", topic: "Ranní rutina").
3. Večerní rutina (subject: "Večerní rutina", topic: "Večerní rutina").

NEZBYTNÉ PRAVIDLO PRO ZACHOVÁNÍ STÁVAJÍCÍCH ÚKOLŮ (ZABRÁNĚNÍ RESETU):
- Při jakékoli změně (přidání nového úkolu, odebrání konkrétního úkolu, odškrtnutí) do jakéhokoli panelu/karty NESMÍTE vymazat stávající úkoly, které v něm již jsou! 
- Zkontrolujte si v 'AKTUÁLNÍ KONTEXT' sekci aktuální úkoly daného panelu na vybraný den. Všechny stávající řádky zkopírujte slovo od slova a nový úkol přidejte jako novou odrážku na konec seznamu nesplněných úkolů.
- JE PŘÍSNĚ ZAKÁZÁNO smazat staré úkoly a nahradit je pouze jediným novým úkolem.
- NIKDY nesmíte vzájemně míchat nebo kombinovat úkoly z jiných panelů (např. nemíchej úkoly z 'Doplňujících úkolů' do 'Ranní rutiny' apod.). Každý panel je zcela samostatný! Pokud má uživatel dva panely (např. v jednom je procházka večer a ve druhém procházka večer, 2 služby a ještě něco), a požádá o odstranění procházky jen na tom panelu, kde je pouze procházka - odstraň úkol z jednoho konkrétního panelu, upravený panel vrať v klíči "card", a ty ostatní nechej beze změny!

HLAVNÍ PRAVIDLO PRO PLÁNOVÁNÍ (KARTY DNE):
1. Urči nejprve, o kterou kartu/část dne se jedná (Doplňující plán, Ranní rutina, Večerní rutina) podle dotazu uživatele.
2. Pokud tě uživatel požádá o naplánování, úpravu nebo přidání úkolu, upravuj nebo vytvářej příslušnou kartu s odpovídajícím "subject" a "topic".
3. NIKDY NEPŘIDÁVEJ ŽÁDNÉ NÁHODNÉ NEBO VÝCHOZÍ ÚKOLY, o které tě uživatel sám nepožádal.
4. AKTUALIZACE STAVU / DOKONČENÍ ÚKOLU:
   - Pokud ti uživatel řekne, že má nějaký úkol hotový/splněný (např. 'mám hotovo cvičení', 'splnil jsem snídani'), vyhledej tento úkol v příslušné kartě.
   - Označ ho jako dokončený tak, že na začátek řádku k němu dáš '[x]' (např. '- [x] Název úkolu').
   - Fyzicky přesuň tento dokončený řádek na úplný konec seznamu úkolů (dolů) na dané kartě!
   - Vrácený objekt "card" musí reprezentovat tuto upravenou kartu s odpovídajícím subject a topic.
5. Všechny úkoly formátuj v Markdownu s checkboxy pod klíčem "card":
   - "topic": buď "Dodatečné úkoly", "Ranní rutina" nebo "Večerní rutina"
   - "subject": "Denní plán" (pro doplňující), "Ranní rutina" nebo "Večerní rutina"
   - "content": Seznam úkolů s checkboxy.

Odpověz VÝHRADNĚ ve formátu JSON s těmito vlastnostmi:
{
  "reply": "Přátelská, velmi stručná odpověď v češtině (1 až 2 věty!), např. 'Jasně, označil jsem ranní rozcvičku jako splněnou.'",
  "card": {
    "topic": "Dodatečné úkoly / Ranní rutina / Večerní rutina",
    "content": "Obsah plánu s odrážkami a checkboxy ve formátu Markdown.",
    "subject": "Denní plán / Ranní rutina / Večerní rutina",
    "osnova": "Program",
    "lessonPlan": [],
    "lessonIndex": 1,
    "targetDateStr": "${selectedDateStr || ""}"
  },
  "action": null
}
Pokud plánovací karta není pro konverzaci užitečná a uživatel nechce nic plánovat, měnit ani dokončovat, nastav klíč "card" na null.
Nevracej žádný jiný text než čistý JSON.`,
        config: {
          responseMimeType: "application/json",
          tools: [{ googleSearch: {} }]
        }
      });

      const text = response.text || "{}";
      console.log("Raw text response from Gemini chat model:", text);

      let parsed: any = {};
      try {
        parsed = JSON.parse(text);
      } catch (parseErr) {
        // Fallback cleanup
        let cleaned = text.trim();
        if (cleaned.startsWith("```json")) {
          cleaned = cleaned.replace(/^```json/, "").replace(/```$/, "").trim();
        } else if (cleaned.startsWith("```")) {
          cleaned = cleaned.replace(/^```/, "").replace(/```$/, "").trim();
        }
        try {
          parsed = JSON.parse(cleaned);
        } catch {
          parsed = { reply: text, card: null, action: null };
        }
      }

      res.json(parsed);
    } catch (err: any) {
      console.error("Text chat message endpoint failed:", err);
      res.status(500).json({ error: err.message || "Internal server error" });
    }
  });

  app.post("/api/analyze-image", async (req, res) => {
    try {
      const { image, mimeType } = req.body;
      if (!image) {
        return res.status(400).json({ error: "Nebyl poskytnut žádný obrázek" });
      }

      // Strip potential base64 HTML data-url prefix
      const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
      const finalMimeType = mimeType || "image/jpeg";

      console.log("Analyzing uploaded image using gemini-3.5-flash...");
      
      const activeAi = await getAiClient();
      const response = await activeAi.models.generateContent({
        model: "gemini-3.5-flash",
        contents: [
          {
            inlineData: {
              data: base64Data,
              mimeType: finalMimeType
            }
          },
          "Analyzuj tento obrázek (může to být učebnice, sešit, graf, tabulka nebo napsaný příklad) a vytvoř z něj přehledný, stručný studijní tahák (cheat sheet) v češtině. Výsledek vrať VÝHRADNĚ jako platný JSON objekt se třemi klíči: 'topic' (velmi stručný a výstižný název tématu odpovídající obsahu, například 'Lineární rovnice' nebo 'Slovní zásoba: Jídlo'), 'content' (přehledný obsah ve formě 4 až 6 bodů formátovaných v češtině pomocí Markdown s odrážkami a tučnými slovy) a 'subject' (krátký název školního předmětu, například 'Matematika', 'Chemie', 'Biologie', 'Informatika', 'Dějepis', 'Čeština', 'Cizí jazyky'). Nevracej žádný jiný text, žádné ```json formátování okolo, jen čistý validní JSON objekt."
        ],
        config: {
          responseMimeType: "application/json"
        }
      });

      const responseText = response.text || "{}";
      console.log("Gemini image analysis result text:", responseText);

      try {
        const parsed = JSON.parse(responseText);
        res.json({
          topic: parsed.topic || "Studijní materiál z fotky",
          content: parsed.content || "Nepodařilo se vygenerovat přehled z obrázku.",
          subject: parsed.subject || "Všeobecné"
        });
      } catch (parseError) {
        console.error("Failed to parse Gemini output, raw text was:", responseText);
        let cleaned = responseText.trim();
        if (cleaned.startsWith("```json")) {
          cleaned = cleaned.replace(/^```json/, "").replace(/```$/, "").trim();
        } else if (cleaned.startsWith("```")) {
          cleaned = cleaned.replace(/^```/, "").replace(/```$/, "").trim();
        }
        try {
          const parsed = JSON.parse(cleaned);
          res.json({
            topic: parsed.topic || "Studijní materiál z fotky",
            content: parsed.content || "Nepodařilo se vygenerovat přehled z obrázku.",
            subject: parsed.subject || "Všeobecné"
          });
        } catch {
          res.json({
            topic: "Analýza obrázku",
            content: responseText,
            subject: "Všeobecné"
          });
        }
      }
    } catch (err: any) {
      console.error("Failed to analyze image:", err);
      res.status(500).json({ error: err.message || "Internal server error" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
