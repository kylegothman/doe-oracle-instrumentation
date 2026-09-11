/**
 * SimliAvatar.tsx — updated for simli-client v3.x
 *
 * Parent usage:
 *   const avatarRef = useRef<SimliAvatarHandle>(null);
 *   <SimliAvatar ref={avatarRef} isThinking={loading} />
 *   avatarRef.current?.speak("response text here");
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  SimliClient,
  generateSimliSessionToken,
  generateIceServers,
} from "simli-client";

export interface SimliAvatarHandle {
  speak: (text: string) => Promise<void>;
}

interface SimliAvatarProps {
  isThinking?: boolean;
  isListening?: boolean;
  onReady?: () => void;
  size?: number;
}

// Send N seconds of silent PCM to prime the video pipeline after connect
function sendSilence(client: SimliClient, seconds = 2) {
  const CHUNK_MS    = 100;
  const CHUNK_BYTES = (16000 * CHUNK_MS) / 1000 * 2;
  const totalChunks = (seconds * 1000) / CHUNK_MS;
  let sent = 0;
  const id = setInterval(() => {
    if (sent >= totalChunks) { clearInterval(id); return; }
    client.sendAudioData(new Uint8Array(CHUNK_BYTES).fill(0));
    sent++;
  }, CHUNK_MS);
  return id;
}

const SimliAvatar = forwardRef<SimliAvatarHandle, SimliAvatarProps>(
  ({ isThinking = false, isListening = false, onReady, size = 320 }, ref) => {
    const videoRef        = useRef<HTMLVideoElement>(null);
    const audioRef        = useRef<HTMLAudioElement>(null);
    const clientRef       = useRef<SimliClient | null>(null);
    const initializedRef  = useRef(false);
    const isReadyRef      = useRef(false);
    const silenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    type Status = "connecting" | "ready" | "speaking" | "error";
    const [status,   setStatus]   = useState<Status>("connecting");
    const [errorMsg, setErrorMsg] = useState("");

    // ── Init ─────────────────────────────────────────────────────────────────
    useEffect(() => {
      if (initializedRef.current) return;
      initializedRef.current = true;

      const apiKey = import.meta.env.VITE_SIMLI_API_KEY as string | undefined;
      const faceID = import.meta.env.VITE_SIMLI_FACE_ID as string | undefined;

      if (!apiKey || !faceID) {
        setErrorMsg("Missing VITE_SIMLI_API_KEY or VITE_SIMLI_FACE_ID in doe-frontend/.env");
        setStatus("error");
        return;
      }

      let client: SimliClient | null = null;

      const init = async () => {
        try {
          // 1. Exchange API key + face config for a session token
          const { session_token } = await generateSimliSessionToken({
            apiKey,
            config: {
              faceId: faceID,
              handleSilence: true,
              maxSessionLength: 3600,
              maxIdleTime: 600,
            },
          });

          // 2. Fetch ICE servers
          const iceServers = await generateIceServers(apiKey);

          if (!videoRef.current || !audioRef.current) return;

          // 3. Instantiate and connect
          client = new SimliClient(
            session_token,
            videoRef.current,
            audioRef.current,
            iceServers,
          );
          clientRef.current = client;

          await client.start();

          // 4. Mark ready and prime the video pipeline with silence.
          //    Delay onReady until silence priming is done so speak() can
          //    stream audio immediately without interleaving zero-PCM chunks.
          isReadyRef.current = true;
          setStatus("ready");
          const SILENCE_SECONDS = 2;
          silenceTimerRef.current = sendSilence(client, SILENCE_SECONDS);
          setTimeout(() => onReady?.(), SILENCE_SECONDS * 1000);

        } catch (err) {
          setErrorMsg(String(err));
          setStatus("error");
        }
      };

      init();

      return () => {
        initializedRef.current = false;
        isReadyRef.current = false;
        if (silenceTimerRef.current) clearInterval(silenceTimerRef.current);
        try { client?.stop(); } catch (_) {}
        clientRef.current = null;
      };
    }, []);

    // ── speak(): fetch PCM from backend → send to Simli for lip-sync ─────────
    const speak = async (text: string) => {
      const client = clientRef.current;
      if (!client || status === "error") return;

      // Stop any in-flight silence priming so speech audio isn't interleaved
      // with zero-PCM chunks, which would break lip sync.
      if (silenceTimerRef.current) {
        clearInterval(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }

      // Wait up to 10 s for the connection to become ready
      if (!isReadyRef.current) {
        await new Promise<void>((resolve, reject) => {
          const deadline = Date.now() + 10_000;
          const poll = setInterval(() => {
            if (isReadyRef.current) {
              clearInterval(poll);
              resolve();
            } else if (Date.now() > deadline) {
              clearInterval(poll);
              reject(new Error("Simli connection timed out"));
            }
          }, 200);
        }).catch((e) => {
          console.warn("[SimliAvatar] speak() aborted:", e);
          return Promise.reject(e);
        });
      }

      setStatus("speaking");

      try {
        const backendUrl = import.meta.env.VITE_API_URL || 'http://127.0.0.1:5000';

        const response = await fetch(`${backendUrl}/api/tts`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ text }),
        });

        if (!response.ok) throw new Error(`TTS API error: ${response.status}`);

        const arrayBuffer = await response.arrayBuffer();
        const pcmData     = new Uint8Array(arrayBuffer);

        // Stream to Simli in 100 ms chunks for smooth lip-sync
        const CHUNK_BYTES = (16000 * 100) / 1000 * 2;
        const activeClient = clientRef.current;
        if (!activeClient) return;
        for (let offset = 0; offset < pcmData.length; offset += CHUNK_BYTES) {
          const chunk = pcmData.slice(offset, offset + CHUNK_BYTES);
          activeClient.sendAudioData(chunk);
          await new Promise(r => setTimeout(r, 10));
        }

      } catch (err) {
        console.error("[SimliAvatar] speak() error:", err);
        if (window.speechSynthesis) {
          const utter = new SpeechSynthesisUtterance(text);
          window.speechSynthesis.cancel();
          window.speechSynthesis.speak(utter);
        }
      } finally {
        setStatus("ready");
      }
    };

    useImperativeHandle(ref, () => ({ speak }));

    // ── Render ────────────────────────────────────────────────────────────────
    return (
      <div className="relative flex flex-col items-center justify-center w-full h-full">
        <div
          className="relative rounded-2xl overflow-hidden"
          style={{ width: size, height: size }}
        >
          {/* Animated glow border */}
          <div
            className={`
              absolute inset-0 rounded-2xl z-10 pointer-events-none border-2
              transition-all duration-300
              ${isListening
                ? "border-green-400/90 shadow-[0_0_30px_rgba(74,222,128,0.6)] animate-pulse"
                : isThinking
                ? "border-blue-400/80 shadow-[0_0_30px_rgba(59,130,246,0.6)] animate-pulse"
                : status === "speaking"
                ? "border-purple-400/80 shadow-[0_0_20px_rgba(168,85,247,0.5)]"
                : "border-blue-500/30"}
            `}
          />

          {/* Avatar video — always in DOM so WebRTC can attach */}
          <video
            ref={videoRef}
            autoPlay
            playsInline
            className="w-full h-full object-cover rounded-2xl bg-gray-900"
          />
          <audio ref={audioRef} autoPlay hidden />

          {status === "connecting" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-900/85 rounded-2xl">
              <div className="w-10 h-10 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mb-3" />
              <p className="text-blue-300 text-sm tracking-wide">Connecting avatar…</p>
            </div>
          )}

          {status === "error" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-900/90 rounded-2xl p-4">
              <p className="text-red-400 text-xs text-center leading-relaxed">{errorMsg}</p>
            </div>
          )}
        </div>

        <div className="mt-3 px-3 py-1 rounded-full bg-gray-800/80 border border-gray-700/50 text-xs tracking-wide">
          {isListening
            ? <span className="text-green-400">Listening…</span>
            : isThinking
            ? <span className="text-blue-400">Thinking…</span>
            : status === "connecting"
            ? <span className="text-gray-400">Connecting…</span>
            : status === "speaking"
            ? <span className="text-purple-300">Speaking…</span>
            : status === "error"
            ? <span className="text-red-400">Error — check .env</span>
            : <span className="text-green-400">Ready</span>}
        </div>
      </div>
    );
  }
);

SimliAvatar.displayName = "SimliAvatar";
export default SimliAvatar;
