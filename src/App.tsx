/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  Phone, 
  PhoneOff, 
  Mic, 
  MicOff, 
  Volume2, 
  User, 
  ShieldCheck, 
  MessageSquare,
  History,
  Settings,
  X,
  Check,
  ArrowRight,
  Star,
  ThumbsUp,
  Ban,
  AlertTriangle
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleGenAI, Modality } from "@google/genai";
import Markdown from 'react-markdown';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// Utility for tailwind classes
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- Types ---
interface Message {
  role: 'user' | 'model' | 'system';
  text: string;
  timestamp: Date;
}

interface CallHistoryItem {
  id: string;
  number: string;
  timestamp: Date;
  transcript: Message[];
  rating: number | null;
}

// --- Constants ---
const DEFAULT_GREETING = "Hello, who are you? Aapko kis se baat karna hai?";
const getSystemInstruction = (greeting: string) => `You are a professional call screening assistant for an unknown caller. 
When the call is answered, you MUST start by saying: "${greeting}" 
Your tone should be polite but firm. You are screening this call for the owner. 
Ask the caller for their name and the purpose of their call. 
If they provide the information, summarize it and tell them you will check if the owner is available.
Speak in a natural mix of English and Hindi (Hinglish).`;

const MODEL_NAME = "gemini-2.5-flash-native-audio-preview-09-2025";

const PREDEFINED_GREETINGS = [
  { label: "Standard", text: "Hello, who are you? Aapko kis se baat karna hai?" },
  { label: "Formal", text: "Hello, this is an automated screening service. Please state your name and purpose of call." },
  { label: "Hindi Only", text: "Namaste, aap kaun hain aur aapko kis se baat karni hai?" },
  { label: "Security", text: "Security screening in progress. Identify yourself and your reason for calling." },
];

export default function App() {
  const [isCallIncoming, setIsCallIncoming] = useState(true);
  const [isCallActive, setIsCallActive] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [transcript, setTranscript] = useState<Message[]>([]);
  const [isMuted, setIsMuted] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isSpamBlocked, setIsSpamBlocked] = useState(false);
  const [rating, setRating] = useState<number | null>(null);
  const [isFeedbackSubmitted, setIsFeedbackSubmitted] = useState(false);
  const [spamList, setSpamList] = useState<string[]>(() => {
    return JSON.parse(localStorage.getItem('callSentrySpamList') || '[]');
  });
  const [volume, setVolume] = useState(() => {
    return parseFloat(localStorage.getItem('callSentryVolume') || '1.0');
  });
  const [callHistory, setCallHistory] = useState<CallHistoryItem[]>(() => {
    const saved = localStorage.getItem('callSentryHistory');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        return parsed.map((item: any) => ({
          ...item,
          timestamp: new Date(item.timestamp),
          transcript: item.transcript.map((m: any) => ({ ...m, timestamp: new Date(m.timestamp) }))
        }));
      } catch (e) {
        return [];
      }
    }
    return [];
  });
  const [customGreeting, setCustomGreeting] = useState(() => {
    return localStorage.getItem('callSentryGreeting') || DEFAULT_GREETING;
  });
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sessionRef = useRef<any>(null);
  const audioQueue = useRef<Int16Array[]>([]);
  const isPlaying = useRef(false);
  const playNextChunkRef = useRef<() => void>(() => {});

  // --- Audio Handling ---

  const processAudioChunk = useCallback((base64Data: string) => {
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const pcmData = new Int16Array(bytes.buffer);
    audioQueue.current.push(pcmData);
    
    if (!isPlaying.current) {
      playNextChunkRef.current();
    }
  }, []);

  const playNextChunk = useCallback(() => {
    if (audioQueue.current.length === 0 || !audioContextRef.current) {
      isPlaying.current = false;
      return;
    }

    isPlaying.current = true;
    const pcmData = audioQueue.current.shift()!;
    const floatData = new Float32Array(pcmData.length);
    for (let i = 0; i < pcmData.length; i++) {
      floatData[i] = pcmData[i] / 32768.0;
    }

    const buffer = audioContextRef.current.createBuffer(1, floatData.length, 24000);
    buffer.getChannelData(0).set(floatData);

    const source = audioContextRef.current.createBufferSource();
    source.buffer = buffer;
    
    if (!gainNodeRef.current) {
      gainNodeRef.current = audioContextRef.current.createGain();
      gainNodeRef.current.connect(audioContextRef.current.destination);
    }
    gainNodeRef.current.gain.value = volume;
    
    source.connect(gainNodeRef.current);
    source.onended = () => playNextChunkRef.current();
    source.start();
  }, [volume]);

  useEffect(() => {
    playNextChunkRef.current = playNextChunk;
  }, [playNextChunk]);

  const startCall = async () => {
    try {
      setIsConnecting(true);
      setIsCallIncoming(false);
      
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
      
      // Initialize Audio Context
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      // Get Microphone Access
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Connect to Live API
      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
          },
          systemInstruction: getSystemInstruction(customGreeting),
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            console.log("Live session opened");
            setIsCallActive(true);
            setIsConnecting(false);
            
            // Start sending audio
            const source = audioContextRef.current!.createMediaStreamSource(stream);
            const processor = audioContextRef.current!.createScriptProcessor(4096, 1, 1);
            processorRef.current = processor;

            processor.onaudioprocess = (e) => {
              if (isMuted) return;
              
              const inputData = e.inputBuffer.getChannelData(0);
              
              // Calculate audio level for UI
              let sum = 0;
              for (let i = 0; i < inputData.length; i++) {
                sum += inputData[i] * inputData[i];
              }
              setAudioLevel(Math.sqrt(sum / inputData.length));

              // Convert to PCM16
              const pcm16 = new Int16Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) {
                pcm16[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
              }
              
              const base64 = btoa(String.fromCharCode(...new Uint8Array(pcm16.buffer)));
              sessionRef.current?.sendRealtimeInput({
                media: { data: base64, mimeType: 'audio/pcm;rate=24000' }
              });
            };

            source.connect(processor);
            processor.connect(audioContextRef.current!.destination);
          },
          onmessage: (message) => {
            // Handle Audio Output
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio) {
              processAudioChunk(base64Audio);
            }

            // Handle Transcriptions
            if (message.serverContent?.modelTurn?.parts?.[0]?.text) {
              const text = message.serverContent.modelTurn.parts[0].text;
              setTranscript(prev => [...prev, { role: 'model', text, timestamp: new Date() }]);
            }

            // Handle User Transcription (if enabled)
            const userText = (message as any).serverContent?.userTurn?.parts?.[0]?.text;
            if (userText) {
              setTranscript(prev => [...prev, { role: 'user', text: userText, timestamp: new Date() }]);
            }

            // Handle Interruption
            if (message.serverContent?.interrupted) {
              audioQueue.current = [];
              // In a real app, we'd stop current playback node
            }
          },
          onclose: () => {
            endCall();
          },
          onerror: (err) => {
            console.error("Live session error:", err);
            endCall();
          }
        }
      });

      sessionRef.current = await sessionPromise;

    } catch (err) {
      console.error("Failed to start call:", err);
      setIsConnecting(false);
      setIsCallIncoming(true);
    }
  };

  const endCall = () => {
    // Save to history before clearing
    if (transcript.length > 0) {
      const newHistoryItem: CallHistoryItem = {
        id: Math.random().toString(36).substring(7),
        number: "+91 98765 43210", // In a real app, this would be dynamic
        timestamp: new Date(),
        transcript: [...transcript],
        rating: rating
      };
      const updatedHistory = [newHistoryItem, ...callHistory].slice(0, 20); // Keep last 20
      setCallHistory(updatedHistory);
      localStorage.setItem('callSentryHistory', JSON.stringify(updatedHistory));
    }

    setIsCallActive(false);
    setIsCallIncoming(false);
    
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    setTranscript([]);
    setRating(null);
    setIsFeedbackSubmitted(false);
    
    // Check if next simulated call should be blocked
    const nextNumber = "+91 98765 43210";
    const isNextSpam = spamList.includes(nextNumber);
    
    // Reset to incoming call for demo purposes after a delay
    setTimeout(() => {
      if (isNextSpam) {
        setIsSpamBlocked(true);
      } else {
        setIsCallIncoming(true);
      }
    }, 2000);
  };

  const toggleMute = () => setIsMuted(!isMuted);

  const saveGreeting = (newGreeting: string) => {
    setCustomGreeting(newGreeting);
    localStorage.setItem('callSentryGreeting', newGreeting);
    setIsSettingsOpen(false);
  };

  const updateVolume = (newVolume: number) => {
    setVolume(newVolume);
    localStorage.setItem('callSentryVolume', newVolume.toString());
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = newVolume;
    }
  };

  const clearHistory = () => {
    setCallHistory([]);
    localStorage.removeItem('callSentryHistory');
  };

  const toggleSpam = (number: string) => {
    const newList = spamList.includes(number) 
      ? spamList.filter(n => n !== number)
      : [...spamList, number];
    setSpamList(newList);
    localStorage.setItem('callSentrySpamList', JSON.stringify(newList));
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white font-sans selection:bg-emerald-500/30 flex items-center justify-center p-4 overflow-hidden">
      {/* Background Glow */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-emerald-500/10 blur-[120px] rounded-full" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-500/10 blur-[120px] rounded-full" />
      </div>

      <div className="relative w-full max-w-md aspect-[9/19] max-h-[850px] bg-[#141414] rounded-[3rem] border-8 border-[#262626] shadow-2xl overflow-hidden flex flex-col">
        {/* Notch */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-7 bg-[#262626] rounded-b-2xl z-50 flex items-center justify-center">
          <div className="w-12 h-1 bg-[#1a1a1a] rounded-full" />
        </div>

        {/* Settings Button */}
        {(isCallIncoming || isSpamBlocked) && (
          <div className="absolute top-12 right-6 z-50 flex gap-2">
            <button 
              onClick={() => setIsHistoryOpen(true)}
              className="w-10 h-10 bg-zinc-800/50 backdrop-blur-md rounded-full flex items-center justify-center hover:bg-zinc-700 transition-colors"
            >
              <History size={20} className="text-zinc-400" />
            </button>
            <button 
              onClick={() => setIsSettingsOpen(true)}
              className="w-10 h-10 bg-zinc-800/50 backdrop-blur-md rounded-full flex items-center justify-center hover:bg-zinc-700 transition-colors"
            >
              <Settings size={20} className="text-zinc-400" />
            </button>
          </div>
        )}

        {/* Content Area */}
        <div className="flex-1 flex flex-col pt-12 px-6 pb-8 relative">
          
          <AnimatePresence mode="wait">
            {isSpamBlocked && (
              <motion.div 
                key="blocked"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="flex-1 flex flex-col items-center justify-center text-center space-y-8 py-12"
              >
                <div className="relative">
                  <div className="w-24 h-24 bg-red-500/10 rounded-full flex items-center justify-center mx-auto ring-4 ring-red-500/20">
                    <Ban size={48} className="text-red-500" />
                  </div>
                  <motion.div 
                    animate={{ scale: [1, 1.2, 1] }}
                    transition={{ repeat: Infinity, duration: 2 }}
                    className="absolute -top-1 -right-1 w-8 h-8 bg-red-500 rounded-full flex items-center justify-center border-4 border-[#141414]"
                  >
                    <AlertTriangle size={14} className="text-white" />
                  </motion.div>
                </div>

                <div className="space-y-4">
                  <h2 className="text-3xl font-bold tracking-tight text-red-500">Spam Blocked</h2>
                  <div className="space-y-1">
                    <p className="text-zinc-500 font-medium">+91 98765 43210</p>
                    <p className="text-xs text-zinc-600">This number is in your block list.</p>
                  </div>
                </div>

                <div className="w-full space-y-4">
                  <button 
                    onClick={() => {
                      toggleSpam("+91 98765 43210");
                      setIsSpamBlocked(false);
                      setIsCallIncoming(true);
                    }}
                    className="w-full py-4 bg-zinc-800 rounded-2xl font-bold hover:bg-zinc-700 transition-colors"
                  >
                    Unblock Number
                  </button>
                  <button 
                    onClick={() => setIsSpamBlocked(false)}
                    className="w-full py-4 bg-red-500/10 text-red-500 rounded-2xl font-bold hover:bg-red-500/20 transition-colors"
                  >
                    Dismiss
                  </button>
                </div>
              </motion.div>
            )}

            {isCallIncoming && (
              <motion.div 
                key="incoming"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="flex-1 flex flex-col items-center justify-between py-12"
              >
                <div className="text-center space-y-4">
                  <div className="w-24 h-24 bg-zinc-800 rounded-full flex items-center justify-center mx-auto mb-6 ring-4 ring-zinc-800/50">
                    <User size={48} className="text-zinc-400" />
                  </div>
                  <h2 className="text-3xl font-semibold tracking-tight">Unknown Number</h2>
                  <p className="text-zinc-500 font-medium">+91 98765 43210</p>
                  <div className="inline-flex items-center gap-2 px-3 py-1 bg-emerald-500/10 text-emerald-400 rounded-full text-xs font-bold uppercase tracking-wider">
                    <ShieldCheck size={14} />
                    CallSentry Active
                  </div>
                </div>

                <div className="w-full space-y-8">
                  <div className="flex justify-around items-center">
                    <div className="flex flex-col items-center gap-2">
                      <button className="w-16 h-16 bg-zinc-800 rounded-full flex items-center justify-center hover:bg-zinc-700 transition-colors">
                        <MessageSquare size={24} className="text-zinc-300" />
                      </button>
                      <span className="text-xs text-zinc-500 font-medium">Message</span>
                    </div>
                    <div className="flex flex-col items-center gap-2">
                      <button className="w-16 h-16 bg-zinc-800 rounded-full flex items-center justify-center hover:bg-zinc-700 transition-colors">
                        <History size={24} className="text-zinc-300" />
                      </button>
                      <span className="text-xs text-zinc-500 font-medium">Remind Me</span>
                    </div>
                  </div>

                  <div className="flex justify-between items-center px-4">
                    <button 
                      onClick={() => setIsCallIncoming(false)}
                      className="w-20 h-20 bg-red-500 rounded-full flex items-center justify-center shadow-lg shadow-red-500/20 hover:scale-105 transition-transform active:scale-95"
                    >
                      <PhoneOff size={32} />
                    </button>
                    
                    <button 
                      onClick={startCall}
                      disabled={isConnecting}
                      className={cn(
                        "w-20 h-20 bg-emerald-500 rounded-full flex items-center justify-center shadow-lg shadow-emerald-500/20 hover:scale-105 transition-transform active:scale-95",
                        isConnecting && "animate-pulse opacity-70"
                      )}
                    >
                      <Phone size={32} />
                    </button>
                  </div>
                  <p className="text-center text-zinc-600 text-sm font-medium">
                    {isConnecting ? "Connecting to AI..." : "Swipe up to answer"}
                  </p>
                </div>
              </motion.div>
            )}

            {isCallActive && (
              <motion.div 
                key="active"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex-1 flex flex-col"
              >
                {/* Header */}
                <div className="flex items-center justify-between mb-8">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-emerald-500/10 rounded-full flex items-center justify-center">
                      <ShieldCheck size={20} className="text-emerald-500" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-sm">CallSentry Screening</h3>
                      <p className="text-xs text-zinc-500">Live AI Assistant</p>
                    </div>
                  </div>
                  <div className="px-2 py-1 bg-red-500/10 text-red-500 rounded-md text-[10px] font-bold uppercase tracking-widest">
                    Recording
                  </div>
                </div>

                {/* Transcript Area */}
                <div className="flex-1 bg-zinc-900/50 rounded-3xl p-4 mb-6 overflow-y-auto space-y-4 scrollbar-hide">
                  {transcript.length === 0 && (
                    <div className="h-full flex flex-col items-center justify-center text-center space-y-4 opacity-40">
                      <div className="w-12 h-12 bg-zinc-800 rounded-full flex items-center justify-center">
                        <Mic size={24} />
                      </div>
                      <p className="text-sm font-medium">Assistant is speaking...</p>
                    </div>
                  )}
                  {transcript.map((msg, i) => (
                    <motion.div 
                      key={i}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className={cn(
                        "max-w-[85%] rounded-2xl p-3 text-sm",
                        msg.role === 'user' ? "bg-zinc-800 ml-auto" : "bg-emerald-500/10 text-emerald-50 text-left"
                      )}
                    >
                      <div className="font-bold text-[10px] uppercase tracking-wider opacity-50 mb-1">
                        {msg.role === 'user' ? 'Caller' : 'Assistant'}
                      </div>
                      <Markdown>{msg.text}</Markdown>
                    </motion.div>
                  ))}
                </div>

                {/* Visualizer */}
                <div className="h-16 flex items-center justify-center gap-1 mb-8">
                  {[...Array(12)].map((_, i) => (
                    <motion.div
                      key={i}
                      animate={{ 
                        height: isMuted ? 4 : Math.max(4, audioLevel * 100 * (Math.random() * 0.5 + 0.5)) 
                      }}
                      className="w-1.5 bg-emerald-500 rounded-full"
                    />
                  ))}
                </div>

                {/* Controls */}
                <div className="grid grid-cols-3 gap-4">
                  <div className="flex flex-col items-center gap-2">
                    <button 
                      onClick={toggleMute}
                      className={cn(
                        "w-14 h-14 rounded-full flex items-center justify-center transition-colors",
                        isMuted ? "bg-red-500" : "bg-zinc-800 hover:bg-zinc-700"
                      )}
                    >
                      {isMuted ? <MicOff size={20} /> : <Mic size={20} />}
                    </button>
                    <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Mute</span>
                  </div>
                  
                  <div className="flex flex-col items-center gap-2">
                    <button 
                      onClick={endCall}
                      className="w-14 h-14 bg-red-500 rounded-full flex items-center justify-center hover:scale-105 transition-transform active:scale-95"
                    >
                      <PhoneOff size={24} />
                    </button>
                    <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">End</span>
                  </div>

                  <div className="flex flex-col items-center gap-2">
                    <button className="w-14 h-14 bg-zinc-800 rounded-full flex items-center justify-center hover:bg-zinc-700 transition-colors">
                      <Volume2 size={20} />
                    </button>
                    <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Speaker</span>
                  </div>
                </div>
              </motion.div>
            )}

            {!isCallIncoming && !isCallActive && !isConnecting && (
              <motion.div 
                key="summary"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                className="flex-1 flex flex-col items-center justify-center text-center space-y-6"
              >
                <div className="w-20 h-20 bg-emerald-500/10 rounded-full flex items-center justify-center mb-2">
                  <Check size={40} className="text-emerald-500" />
                </div>
                <div className="space-y-1">
                  <h2 className="text-2xl font-bold">Call Screened</h2>
                  <p className="text-zinc-400 text-sm">
                    The unknown caller was handled.
                  </p>
                </div>

                {/* Feedback Section */}
                <div className="w-full bg-zinc-900/50 rounded-3xl p-6 space-y-4 border border-zinc-800">
                  {!isFeedbackSubmitted ? (
                    <>
                      <p className="text-xs font-bold text-zinc-500 uppercase tracking-widest">Rate AI Performance</p>
                      <div className="flex justify-center gap-2">
                        {[1, 2, 3, 4, 5].map((star) => (
                          <button
                            key={star}
                            onClick={() => setRating(star)}
                            className="transition-transform active:scale-90"
                          >
                            <Star 
                              size={28} 
                              className={cn(
                                "transition-colors",
                                rating && star <= rating ? "fill-yellow-400 text-yellow-400" : "text-zinc-700"
                              )} 
                            />
                          </button>
                        ))}
                      </div>
                      <div className="flex gap-2">
                        <button 
                          disabled={!rating}
                          onClick={() => setIsFeedbackSubmitted(true)}
                          className={cn(
                            "flex-1 py-3 rounded-xl text-sm font-bold transition-all",
                            rating 
                              ? "bg-emerald-500 text-white shadow-lg shadow-emerald-500/20" 
                              : "bg-zinc-800 text-zinc-500 cursor-not-allowed"
                          )}
                        >
                          Submit
                        </button>
                        <button 
                          onClick={() => {
                            toggleSpam("+91 98765 43210");
                            setIsFeedbackSubmitted(true);
                          }}
                          className={cn(
                            "px-4 py-3 rounded-xl text-sm font-bold transition-all border",
                            spamList.includes("+91 98765 43210")
                              ? "bg-red-500/10 border-red-500 text-red-500"
                              : "bg-zinc-800 border-zinc-700 text-zinc-400 hover:bg-red-500/10 hover:border-red-500 hover:text-red-500"
                          )}
                        >
                          <Ban size={18} />
                        </button>
                      </div>
                    </>
                  ) : (
                    <motion.div 
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="py-4 space-y-2"
                    >
                      <ThumbsUp size={32} className="text-emerald-500 mx-auto mb-2" />
                      <p className="text-sm font-medium text-emerald-400">Thank you for your feedback!</p>
                      <p className="text-[10px] text-zinc-500">Your rating helps us improve CallSentry AI.</p>
                    </motion.div>
                  )}
                </div>

                <button 
                  onClick={() => setIsCallIncoming(true)}
                  className="px-6 py-3 bg-zinc-800 rounded-full text-sm font-bold hover:bg-zinc-700 transition-colors flex items-center gap-2"
                >
                  Back to Home <ArrowRight size={16} />
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          {/* History Modal */}
          <AnimatePresence>
            {isHistoryOpen && (
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0 z-[60] bg-[#141414] p-6 flex flex-col"
              >
                <div className="flex items-center justify-between mb-8">
                  <h3 className="text-xl font-bold">Call History</h3>
                  <button 
                    onClick={() => setIsHistoryOpen(false)}
                    className="w-10 h-10 bg-zinc-800 rounded-full flex items-center justify-center"
                  >
                    <X size={20} />
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto space-y-4 pr-2 scrollbar-hide">
                  {callHistory.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-center space-y-4 opacity-40">
                      <History size={48} />
                      <p className="text-sm font-medium">No call history yet</p>
                    </div>
                  ) : (
                    callHistory.map((item) => (
                      <div key={item.id} className="bg-zinc-900/50 border border-zinc-800 rounded-2xl p-4 space-y-3">
                        <div className="flex justify-between items-start">
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-bold">{item.number}</p>
                              {spamList.includes(item.number) && (
                                <span className="px-1.5 py-0.5 bg-red-500/10 text-red-500 rounded text-[8px] font-bold uppercase">Spam</span>
                              )}
                            </div>
                            <p className="text-[10px] text-zinc-500">
                              {item.timestamp.toLocaleDateString()} • {item.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            {item.rating && (
                              <div className="flex gap-0.5">
                                {[...Array(item.rating)].map((_, i) => (
                                  <Star key={i} size={10} className="fill-yellow-400 text-yellow-400" />
                                ))}
                              </div>
                            )}
                            <button 
                              onClick={() => toggleSpam(item.number)}
                              className={cn(
                                "w-6 h-6 rounded-full flex items-center justify-center transition-colors",
                                spamList.includes(item.number) ? "bg-red-500 text-white" : "bg-zinc-800 text-zinc-500 hover:text-red-500"
                              )}
                            >
                              <Ban size={12} />
                            </button>
                          </div>
                        </div>
                        <div className="space-y-2">
                          {item.transcript.slice(0, 2).map((msg, i) => (
                            <div key={i} className="text-[10px] text-zinc-400 line-clamp-1">
                              <span className="font-bold uppercase text-[8px] opacity-50 mr-1">
                                {msg.role === 'user' ? 'Caller:' : 'AI:'}
                              </span>
                              {msg.text}
                            </div>
                          ))}
                          {item.transcript.length > 2 && (
                            <p className="text-[8px] text-zinc-600 italic">+{item.transcript.length - 2} more messages</p>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>

                {callHistory.length > 0 && (
                  <button 
                    onClick={clearHistory}
                    className="w-full py-4 mt-4 bg-zinc-800 text-red-400 rounded-2xl font-bold hover:bg-zinc-700 transition-colors"
                  >
                    Clear History
                  </button>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Settings Modal */}
          <AnimatePresence>
            {isSettingsOpen && (
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0 z-[60] bg-[#141414] p-6 flex flex-col"
              >
                <div className="flex items-center justify-between mb-8">
                  <h3 className="text-xl font-bold">Settings</h3>
                  <button 
                    onClick={() => setIsSettingsOpen(false)}
                    className="w-10 h-10 bg-zinc-800 rounded-full flex items-center justify-center"
                  >
                    <X size={20} />
                  </button>
                </div>

                <div className="space-y-6 flex-1 overflow-y-auto pr-2 scrollbar-hide">
                  <div className="space-y-3">
                    <label className="text-xs font-bold text-zinc-500 uppercase tracking-widest">
                      Blocked Numbers ({spamList.length})
                    </label>
                    <div className="space-y-2">
                      {spamList.length === 0 ? (
                        <p className="text-[10px] text-zinc-600 italic px-2">No numbers blocked yet.</p>
                      ) : (
                        spamList.map(num => (
                          <div key={num} className="flex items-center justify-between bg-zinc-900 p-3 rounded-xl border border-zinc-800">
                            <span className="text-xs font-mono">{num}</span>
                            <button 
                              onClick={() => toggleSpam(num)}
                              className="text-[10px] font-bold text-red-500 uppercase tracking-wider hover:underline"
                            >
                              Unblock
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="space-y-3">
                    <label className="text-xs font-bold text-zinc-500 uppercase tracking-widest">
                      Volume Control
                    </label>
                    <div className="flex items-center gap-4 bg-zinc-900 p-4 rounded-2xl border border-zinc-800">
                      <Volume2 size={20} className="text-zinc-500" />
                      <input 
                        type="range" 
                        min="0" 
                        max="1" 
                        step="0.01" 
                        value={volume}
                        onChange={(e) => updateVolume(parseFloat(e.target.value))}
                        className="flex-1 accent-emerald-500 h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
                      />
                      <span className="text-xs font-mono text-zinc-500 w-8">{Math.round(volume * 100)}%</span>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <label className="text-xs font-bold text-zinc-500 uppercase tracking-widest">
                      Quick Select Greetings
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      {PREDEFINED_GREETINGS.map((g) => (
                        <button
                          key={g.label}
                          onClick={() => setCustomGreeting(g.text)}
                          className={cn(
                            "p-3 rounded-xl text-[10px] font-bold uppercase tracking-wider border transition-all text-center",
                            customGreeting === g.text 
                              ? "bg-emerald-500/10 border-emerald-500 text-emerald-500" 
                              : "bg-zinc-900 border-zinc-800 text-zinc-500 hover:border-zinc-700"
                          )}
                        >
                          {g.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-3">
                    <label className="text-xs font-bold text-zinc-500 uppercase tracking-widest">
                      Custom Greeting
                    </label>
                    <textarea 
                      value={customGreeting}
                      onChange={(e) => setCustomGreeting(e.target.value)}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-2xl p-4 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50 min-h-[120px] resize-none"
                      placeholder="Enter your custom greeting..."
                    />
                    <p className="text-[10px] text-zinc-600 leading-relaxed">
                      This is what the AI will say immediately when the call is answered. 
                      You can use English, Hindi, or a mix of both.
                    </p>
                  </div>

                  <div className="p-4 bg-emerald-500/5 rounded-2xl border border-emerald-500/10">
                    <h4 className="text-xs font-bold text-emerald-500 mb-1">Preview</h4>
                    <p className="text-sm italic text-zinc-400">"{customGreeting}"</p>
                  </div>
                </div>

                <button 
                  onClick={() => saveGreeting(customGreeting)}
                  className="w-full py-4 bg-emerald-500 rounded-2xl font-bold hover:bg-emerald-400 transition-colors shadow-lg shadow-emerald-500/20"
                >
                  Save Changes
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Bottom Bar */}
        <div className="h-1.5 w-32 bg-[#262626] rounded-full mx-auto mb-2" />
      </div>

      {/* Side Info (Desktop Only) */}
      <div className="hidden lg:flex flex-col ml-12 max-w-sm space-y-8">
        <div className="space-y-4">
          <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-emerald-500/20 to-blue-500/20 border border-emerald-500/20 flex items-center justify-center overflow-hidden shadow-2xl shadow-emerald-500/10">
            <img 
              src="/logo.png" 
              alt="CallSentry AI Logo" 
              className="w-full h-full object-cover"
              onError={(e) => {
                const target = e.target as HTMLImageElement;
                target.src = "https://picsum.photos/seed/callsentry-security/200/200";
              }}
              referrerPolicy="no-referrer"
            />
          </div>
          <div className="space-y-2">
            <h1 className="text-4xl font-bold tracking-tighter bg-gradient-to-r from-emerald-400 to-blue-500 bg-clip-text text-transparent">
              CallSentry AI
            </h1>
            <p className="text-zinc-500 leading-relaxed">
              Your personal AI gatekeeper for unknown calls. Using Gemini 2.5 Flash, 
              it interacts with callers in real-time to verify their identity and block spam calls automatically.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4">
          <section className="p-4 bg-zinc-900/50 rounded-2xl border border-zinc-800">
            <h2 className="text-xs font-bold text-emerald-500 uppercase tracking-widest mb-1">Smart Screening</h2>
            <p className="text-sm text-zinc-400">Automatically asks "Who are you?" and "Who do you want to talk to?" in English and Hindi (Hinglish).</p>
          </section>
          <section className="p-4 bg-zinc-900/50 rounded-2xl border border-zinc-800">
            <h2 className="text-xs font-bold text-blue-500 uppercase tracking-widest mb-1">Spam Blocking</h2>
            <p className="text-sm text-zinc-400">Identify telemarketers and block spam calls with a single tap. Keep your phone secure from unwanted interruptions.</p>
          </section>
          <section className="p-4 bg-zinc-900/50 rounded-2xl border border-zinc-800">
            <h2 className="text-xs font-bold text-purple-500 uppercase tracking-widest mb-1">Live Transcript</h2>
            <p className="text-sm text-zinc-400">Read what the caller is saying in real-time without picking up the phone. Full call history available.</p>
          </section>
        </div>

        <div className="flex items-center gap-4 pt-4">
          <div className="flex -space-x-2">
            {[1, 2, 3].map(i => (
              <div key={i} className="w-8 h-8 rounded-full border-2 border-[#0a0a0a] bg-zinc-800 flex items-center justify-center overflow-hidden">
                <img src={`https://picsum.photos/seed/user${i}/32/32`} alt="user" referrerPolicy="no-referrer" />
              </div>
            ))}
          </div>
          <p className="text-xs text-zinc-500 font-medium">Trusted by 10k+ users</p>
        </div>
      </div>
    </div>
  );
}
