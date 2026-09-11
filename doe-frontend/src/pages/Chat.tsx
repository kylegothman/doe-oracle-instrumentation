// src/components/Chat.tsx
import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { HandThumbUpIcon, HandThumbDownIcon } from '@heroicons/react/24/outline';
import {
  MicrophoneIcon,
  PaperAirplaneIcon,
  TableCellsIcon,
} from '@heroicons/react/24/outline';
import SimliAvatar, { SimliAvatarHandle } from '../components/SimliAvatar';

interface Message {
  sender: 'system' | 'bot' | 'user';
  text: string;
  isSearchResult?: boolean;
  searchResults?: SearchResultItem[];
  searchSummary?: string;
  originalQuery?: string;
}

interface SearchResultItem {
  quote: string;
  source: string;
  page: string;
  supports: string;
}

const Chat = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [searchInput, setSearchInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [placeholder, setPlaceholder] = useState('Ask DOE anything...');

  // states for structured test input through form
  const [testCaseForm, setTestCaseForm] = useState(false);
  const [systemName, setSystemName] = useState('');
  const [testType, setTestType] = useState('');
  const [constraints, setConstraints] = useState('');
  const [requirements, setRequirements] = useState('');

  // STT / recording state
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  const inputRef = useRef<HTMLInputElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const avatarRef = useRef<SimliAvatarHandle>(null);
  const greetingFiredRef = useRef(false);

  const GREETING = "Hello! I'm the DOE Oracle. Ask me anything about software testing.";

  const handleAvatarReady = () => {
    if (greetingFiredRef.current) return;
    greetingFiredRef.current = true;
    setMessages((prev) => [...prev, { sender: 'bot', text: GREETING }]);
    avatarRef.current?.speak(GREETING);
  };

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, testCaseForm]);

  useEffect(() => {
    if (!loading) {
      inputRef.current?.focus();
    }
  }, [loading]);

  // ----- Search / RAG call -----
  const handleSearch = async (query?: string) => {
    const userQuery = query ?? searchInput;
    if (!userQuery.trim()) return;

    setMessages((prev) => [...prev, { sender: 'user', text: userQuery, originalQuery: userQuery }]);
    setSearchInput('');
    setLoading(true);
    setError(null);

    let responseClone: Response | null = null;

    try {
      const backendUrl = import.meta.env.VITE_API_URL || 'http://127.0.0.1:5000';
      const response = await fetch(`${backendUrl}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: userQuery }),
      });

      responseClone = response.clone();
      const data = await response.json();

      if (!response.ok || data.error) {
        throw new Error(data.error || `Server error: ${response.status}`);
      }

      setMessages((prev) => [
        ...prev,
        {
          sender: 'bot',
          text: '',
          isSearchResult: true,
          searchSummary: data.summary,
          searchResults: data.results,
          originalQuery: userQuery,
        },
      ]);

      avatarRef.current?.speak(data.summary);

    } catch (err) {
      console.error('Search Error:', err);

      if (responseClone) {
        try {
          const rawText = await responseClone.text();
          console.error('Raw response text:', rawText);
        } catch (textErr) {
          console.error('Could not get raw response text:', textErr);
        }
      } else {
        console.error('Response object was not available for reading raw text.');
      }

      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred during search.';
      if (err instanceof SyntaxError && responseClone?.status === 404) {
        setError(`API endpoint not found (404). Please check the server route.`);
        setMessages((prev) => [...prev, { sender: 'system', text: `Error: API endpoint /api/search not found (404).` }]);
      } else {
        setError(errorMessage);
        setMessages((prev) => [...prev, { sender: 'system', text: `Error searching for "${userQuery}": ${errorMessage}` }]);
      }
    } finally {
      setLoading(false);
    }
  };

  // ----- Clipboard / feedback helpers -----
  const handleCopy = (textToCopy: string) => {
    navigator.clipboard.writeText(textToCopy)
      .then(() => console.log('Text copied to clipboard!'))
      .catch(err => console.error('Failed to copy text: ', err));
  };

  const handleFeedback = (messageContent: string, rating: 'up' | 'down') => {
    console.log(`Feedback received: ${rating} for message starting with: "${messageContent.substring(0, 50)}..."`);
  };

  // ----- STT: start / stop / send -----
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunksRef.current = [];
      const mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: mediaRecorder.mimeType });
        await sendAudioToBackend(audioBlob);
        stream.getTracks().forEach((t) => t.stop());
      };

      mediaRecorder.start();
      setIsRecording(true);
      setPlaceholder('Listening...');
    } catch (err) {
      console.error('Error starting recording:', err);
      setPlaceholder('Ask DOE anything...');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      try {
        mediaRecorderRef.current.stop();
      } catch (err) {
        console.error('Error stopping media recorder:', err);
      }
    }
    setIsRecording(false);
    setTimeout(() => setPlaceholder('Ask DOE anything...'), 500);
  };

  const toggleRecording = async () => {
    if (isRecording) {
      stopRecording();
    } else {
      await startRecording();
    }
  };

  const sendAudioToBackend = async (blob: Blob) => {
    const backendUrl = import.meta.env.VITE_API_URL || 'http://127.0.0.1:5000';
    console.log("Sent audio blob:", blob.type, blob.size);

    const formData = new FormData();
    formData.append("audio", blob, "recording.webm");

    try {
      const response = await fetch(`${backendUrl}/api/stt`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const bodyText = await response.text();
        console.error('STT server error:', response.status, bodyText);
        setError('Speech-to-text failed.');
        return;
      }

      const data = await response.json();
      if (data?.text) {
        setSearchInput(data.text);
      } else {
        console.warn('No transcription text returned from server.');
      }
    } catch (err) {
      console.error('STT Error:', err);
      setError('Speech-to-text error occurred.');
    }
  };

  // ----- Render -----
  return (
    <div className="flex flex-col" style={{ minHeight: 'calc(100vh - 120px)' }}>

      {/* Avatar section — centered, takes remaining vertical space */}
      <div className="flex-1 flex flex-col items-center justify-center relative pb-6 pt-0">
        {/* Radial glow for depth */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-[600px] h-[600px] rounded-full bg-purple-950/30 blur-3xl" />
        </div>

        {/* Avatar — no card wrapper so it sits directly in the scene */}
        <div className="relative z-10 flex flex-col items-center">
          <SimliAvatar ref={avatarRef} isThinking={loading} isListening={isRecording} onReady={handleAvatarReady} size={380} />
        </div>
      </div>

      {/* Bottom section: scrollable chat + input */}
      <div className="flex flex-col w-full max-w-6xl mx-auto px-4 pb-6 space-y-4">

        {/* Single scrollable message container */}
        <div
          ref={scrollContainerRef}
          className="h-52 overflow-y-scroll space-y-3 px-1 pr-3"
        >
          {messages.map((message, index) =>
            message.sender === 'user' ? (
              <motion.div
                key={`${index}-user`}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2 }}
                className="flex justify-end"
              >
                <div className="bg-purple-700/60 border border-purple-600/30 rounded-2xl rounded-br-sm px-4 py-3 max-w-2xl backdrop-blur-sm">
                  <p className="text-white text-sm leading-relaxed">{message.text}</p>
                </div>
              </motion.div>
            ) : message.sender === 'bot' ? (
              <motion.div
                key={`${index}-bot`}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2 }}
                className="flex items-start space-x-2"
              >
                <div className="w-5 h-5 flex-shrink-0 flex items-center justify-center text-purple-400 mt-1">
                  <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 fill-current">
                    <path d="M12 1L15.5 8.5H23L17 13.5L19.5 21L12 16.5L4.5 21L7 13.5L1 8.5H8.5L12 1Z" />
                  </svg>
                </div>
                <div className="bg-gray-800/70 border border-gray-700/40 rounded-2xl rounded-bl-sm px-4 py-3 max-w-2xl backdrop-blur-sm">
                  <p className="text-gray-100 text-sm leading-relaxed">
                    {message.searchSummary || message.text}
                  </p>
                  {message.searchResults && message.searchResults.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-gray-700/50 space-y-0.5">
                      {message.searchResults.map((result, ri) => (
                        <p key={ri} className="text-xs text-blue-400">
                          📄 {result.source} · p.{result.page}
                        </p>
                      ))}
                    </div>
                  )}
                  <div className="mt-2 flex items-center space-x-2">
                    <button
                      onClick={() => handleCopy(message.searchSummary || message.text)}
                      className="text-gray-500 hover:text-gray-300 transition-colors"
                      title="Copy"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    </button>
                    <button
                      onClick={() => handleFeedback(message.searchSummary || message.text, 'up')}
                      className="text-gray-500 hover:text-green-400 transition-colors"
                      title="Helpful"
                    >
                      <HandThumbUpIcon className="h-3 w-3" />
                    </button>
                    <button
                      onClick={() => handleFeedback(message.searchSummary || message.text, 'down')}
                      className="text-gray-500 hover:text-red-400 transition-colors"
                      title="Not helpful"
                    >
                      <HandThumbDownIcon className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              </motion.div>
            ) : (
              <div key={`${index}-sys`} className="text-center text-xs text-gray-500 italic py-1">
                {message.text}
              </div>
            )
          )}

          {/* Test case form — appears at the bottom when active */}
          <AnimatePresence>
            {testCaseForm && (
              <motion.div
                key="test-case-form"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 6 }}
                transition={{ duration: 0.25 }}
                className="flex justify-end"
              >
                <div className="bg-[#0e0c1e] border border-purple-800/40 rounded-2xl p-4 space-y-2 w-full max-w-2xl">
                  <h3 className="text-white font-semibold text-sm mb-3">Generate Test Cases</h3>
                  <input
                    type="text"
                    placeholder="Name of System"
                    value={systemName}
                    onChange={(e) => setSystemName(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-gray-800/60 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-purple-600 border border-gray-700/40"
                  />
                  <input
                    type="text"
                    placeholder="Type of Test"
                    value={testType}
                    onChange={(e) => setTestType(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-gray-800/60 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-purple-600 border border-gray-700/40"
                  />
                  <textarea
                    placeholder="Requirements"
                    value={requirements}
                    onChange={(e) => setRequirements(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-gray-800/60 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-purple-600 border border-gray-700/40 resize-none"
                    rows={2}
                  />
                  <textarea
                    placeholder="Constraints"
                    value={constraints}
                    onChange={(e) => setConstraints(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-gray-800/60 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-purple-600 border border-gray-700/40 resize-none"
                    rows={2}
                  />
                  <div className="flex space-x-2 pt-1">
                    <button
                      onClick={async () => {
                        const userText = `Generate test cases:\nSystem: ${systemName}\nTest Type: ${testType}\nRequirements: ${requirements}\nConstraints: ${constraints}`;
                        setMessages(prev => [...prev, { sender: 'user', text: userText }]);
                        setTestCaseForm(false);
                        setSystemName(''); setTestType(''); setRequirements(''); setConstraints('');
                        setLoading(true);
                        setError(null);
                        try {
                          const backendUrl = import.meta.env.VITE_API_URL || 'http://127.0.0.1:5000';
                          const response = await fetch(`${backendUrl}/api/generate-test-cases`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ systemName, testType, requirements, constraints }),
                          });
                          const data = await response.json();
                          if (!response.ok || data.error) throw new Error(data.error || `Server error: ${response.status}`);
                          setMessages(prev => [...prev, {
                            sender: 'bot',
                            text: '',
                            isSearchResult: true,
                            searchSummary: data.summary,
                            searchResults: data.evidence ?? [],
                            originalQuery: userText,
                          }]);
                          avatarRef.current?.speak(data.summary);
                        } catch (err) {
                          const msg = err instanceof Error ? err.message : 'Unknown error';
                          setError(msg);
                          setMessages(prev => [...prev, { sender: 'system', text: `Error generating test cases: ${msg}` }]);
                        } finally {
                          setLoading(false);
                        }
                      }}
                      className="flex-1 bg-purple-600 hover:bg-purple-700 text-white text-sm px-4 py-2 rounded-lg transition-colors font-medium"
                    >
                      Generate
                    </button>
                    <button
                      onClick={() => setTestCaseForm(false)}
                      className="px-4 py-2 bg-gray-700/60 hover:bg-gray-700 text-white text-sm rounded-lg transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

        </div>

        {/* Error display */}
        {error && (
          <p className="text-red-400 text-xs text-center px-2">{error}</p>
        )}

        {/* Input bar */}
        <div className="flex items-center space-x-2 bg-[#0e0c1e] border border-purple-900/30 rounded-full px-3 py-2 shadow-lg">
          {/* Generate Test Cases pill button */}
          <button
            onClick={() => setTestCaseForm(v => !v)}
            className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-colors flex-shrink-0 ${
              testCaseForm
                ? 'bg-purple-600 text-white'
                : 'bg-gray-700/50 text-gray-300 hover:bg-gray-600/60'
            }`}
          >
            <TableCellsIcon className="h-4 w-4" />
            <span>Generate Test Cases</span>
          </button>

          {/* Text input */}
          <input
            ref={inputRef}
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={placeholder}
            className="flex-1 bg-transparent text-white text-sm placeholder-gray-500 focus:outline-none min-w-0"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSearch(searchInput);
              }
            }}
            disabled={loading}
          />

          {/* Microphone button */}
          <button
            onClick={toggleRecording}
            className={`w-10 h-10 flex-shrink-0 rounded-full flex items-center justify-center transition-all ${
              isRecording
                ? 'bg-blue-600 ring-2 ring-blue-400/50 text-white'
                : 'bg-gray-700/50 hover:bg-gray-600/60 text-gray-300'
            }`}
            title={isRecording ? 'Stop recording' : 'Start recording'}
          >
            <MicrophoneIcon className="h-4 w-4" />
          </button>

          {/* Send button */}
          <button
            onClick={() => handleSearch(searchInput)}
            disabled={loading || !searchInput.trim()}
            className="w-10 h-10 flex-shrink-0 rounded-full bg-purple-600 hover:bg-purple-700 flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? (
              <svg className="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            ) : (
              <PaperAirplaneIcon className="h-4 w-4 text-white" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default Chat;
