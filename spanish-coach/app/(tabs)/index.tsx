// app/(tabs)/index.tsx
import React, { useEffect, useReducer, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Platform,
  ScrollView,
} from "react-native";
import { Audio } from "expo-av";

const API_URL = "https://nonlethally-ostracizable-janey.ngrok-free.dev/api/turn";

type State = "idle" | "listening" | "uploading" | "speaking" | "error";
type Event =
  | { type: "PRESS_DOWN" }
  | { type: "PRESS_UP" }
  | { type: "UPLOAD_START" }
  | { type: "UPLOAD_OK" }
  | { type: "UPLOAD_ERR" }
  | { type: "PLAY_END" }
  | { type: "CANCEL" };

type ChatMsg = { role: "user" | "assistant"; content: string };

function reducer(state: State, ev: Event): State {
  switch (state) {
    case "idle":
      return ev.type === "PRESS_DOWN" ? "listening" : state;
    case "listening":
      if (ev.type === "PRESS_UP") return "uploading";
      if (ev.type === "CANCEL") return "idle";
      return state;
    case "uploading":
      if (ev.type === "UPLOAD_OK") return "speaking";
      if (ev.type === "UPLOAD_ERR") return "error";
      return state;
    case "speaking":
      return ev.type === "PLAY_END" ? "idle" : state;
    case "error":
      return ev.type === "CANCEL" ? "idle" : state;
  }
}

export default function Home() {
  const [state, dispatch] = useReducer(reducer, "idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [history, setHistory] = useState<ChatMsg[]>([]);
  const [isReplayDisabled, setIsReplayDisabled] = useState(true);
  const [chatVisible, setChatVisible] = useState(true);

  const recordingRef = useRef<Audio.Recording | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    (async () => {
      await Audio.requestPermissionsAsync();
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        shouldDuckAndroid: true,
        staysActiveInBackground: false,
      });
    })();
  }, []);

  // auto-scroll chat to bottom on new messages
  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [history]);

  async function startRecording() {
    try {
      dispatch({ type: "PRESS_DOWN" });
      const rec = new Audio.Recording();
      await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await rec.startAsync();
      recordingRef.current = rec;
    } catch (e: any) {
      setErrorMsg(e?.message ?? "Failed to start recording");
      dispatch({ type: "CANCEL" });
    }
  }

  async function stopAndSend() {
    try {
      if (!recordingRef.current) return;
      await recordingRef.current.stopAndUnloadAsync();
      const uri = recordingRef.current.getURI();
      recordingRef.current = null;

      dispatch({ type: "PRESS_UP" });
      if (!uri) throw new Error("No recording URI");

      const filename =
        uri.split("/").pop() ??
        `turn.${Platform.OS === "ios" ? "caf" : "m4a"}`;
      const file: any = {
        uri,
        name: filename,
        type: Platform.OS === "ios" ? "audio/caf" : "audio/m4a",
      };

      const form = new FormData();
      form.append("audio", file as any);
      form.append("history", JSON.stringify(history.slice(-6))); // keep it lean

      setErrorMsg(null);
      dispatch({ type: "UPLOAD_START" });

      const resp = await fetch(API_URL, { method: "POST", body: form });
      if (!resp.ok) throw new Error(`Backend ${resp.status}: ${await resp.text()}`);

      const { audioBase64, transcript, replyText } = (await resp.json()) as {
        audioBase64: string;
        transcript?: string;
        replyText?: string;
      };
      if (!audioBase64) throw new Error("No audioBase64 in response");

      // update chat history (cap to last 8 messages)
      if (transcript != null) {
        setHistory((prev) => {
          const next: ChatMsg[] = [
            ...prev,
            { role: "user", content: transcript ?? "" } as const,
            { role: "assistant", content: replyText ?? "" } as const,
          ];
          return next.length > 12 ? next.slice(-12) : next;
        });
      }

      // play directly from base64 (no file writes)
      if (soundRef.current) {
        try {
          await soundRef.current.stopAsync();
        } catch {}
        try {
          await soundRef.current.unloadAsync();
        } catch {}
        soundRef.current = null;
      }
      const { sound } = await Audio.Sound.createAsync({
        uri: `data:audio/mpeg;base64,${audioBase64}`,
      });
      soundRef.current = sound;

      dispatch({ type: "UPLOAD_OK" });
      setIsReplayDisabled(false);
      await sound.playAsync();
      sound.setOnPlaybackStatusUpdate((st: any) => {
        if (st?.didJustFinish) dispatch({ type: "PLAY_END" });
      });
    } catch (e: any) {
      setErrorMsg(e?.message ?? "Upload/play error");
      dispatch({ type: "UPLOAD_ERR" });
    }
  }

  async function replayAudio() {
    try {
      if (!soundRef.current) return;
      await soundRef.current.stopAsync();
      await soundRef.current.playAsync();
      soundRef.current.setOnPlaybackStatusUpdate((st: any) => {
        // Just silently finish, don't dispatch to avoid interfering with state
      });
    } catch (e: any) {
      setErrorMsg(e?.message ?? "Replay error");
    }
  }

  return (
    <View style={styles.container}>

      {/* Chat history wrapper - always takes flex space */}
      <View style={styles.chatContainer}>
        {chatVisible && (
          <View style={styles.historyWrap}>
            <ScrollView ref={scrollRef} contentContainerStyle={styles.historyContent}>
              {history.map((m, i) => (
                <Text
                  key={i}
                  style={[styles.msg, m.role === "user" ? styles.user : styles.assistant]}
                >
                  <Text style={styles.role}>{m.role === "user" ? "Tú" : "Asistente"}: </Text>
                  {m.content}
                </Text>
              ))}
            </ScrollView>
          </View>
        )}
      </View>

      <View style={styles.buttonContainer}>
        <Pressable
          style={[
            styles.replayButton,
            isReplayDisabled && styles.replayButtonDisabled,
          ]}
          onPress={() => !isReplayDisabled && replayAudio()}
          disabled={isReplayDisabled}
        >
          <Text style={styles.replayButtonText}>↻</Text>
        </Pressable>

        <Pressable
          style={[
            styles.button,
            state === "listening" && styles.buttonActive,
            state !== "idle" && state !== "listening" && styles.buttonDisabled,
          ]}
          onPressIn={() => state === "idle" && startRecording()}
          onPressOut={() => state === "listening" && stopAndSend()}
        >
          <Text style={styles.buttonText}>
            {state === "idle" && "Hold to Talk"}
            {state === "listening" && "Release to Send"}
            {state === "uploading" && "Sending…"}
            {state === "speaking" && "Playing…"}
            {state === "error" && "Error – Tap to reset"}
          </Text>
        </Pressable>

        <Pressable
          style={[
            styles.toggleButton,
          ]}
          onPress={() => setChatVisible(!chatVisible)}
        >
          <Text style={styles.toggleButtonText}>{chatVisible ? "▤" : "▢"}</Text>
        </Pressable>
      </View>

      {state === "uploading" && <ActivityIndicator style={{ marginTop: 8 }} />}
      {errorMsg && <Text style={styles.error}>{errorMsg}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, paddingTop: 42, gap: 12, backgroundColor: "#000000", justifyContent: "space-between" },
  title: { fontSize: 22, fontWeight: "700", color: "#ffffff" },

  chatContainer: {
    flex: 1,
    justifyContent: "flex-start",
  },

  historyWrap: {
    flex: 1,
    alignSelf: "stretch",
    borderWidth: 1,
    borderColor: "#1f2937",
    borderRadius: 12,
    padding: 12,
    backgroundColor: "#0a0a0a",
  },
  historyContent: { paddingBottom: 8 },
  msg: { marginBottom: 8, lineHeight: 20 },
  role: { fontWeight: "700", color: "#9ca3af" }, // subtle label tint
  user: { color: "#ffffff" },                    // user = white
  assistant: { color: "#2563eb" },               // assistant = blue

  buttonContainer: {
    flexDirection: "row",
    gap: 12,
    justifyContent: "center",
    alignItems: "center",
  },

  replayButton: {
    backgroundColor: "#111827",
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#1f2937",
  },
  replayButtonDisabled: { opacity: 0.4 },
  replayButtonText: { color: "#ffffff", fontSize: 18, fontWeight: "600" },

  button: {
    alignSelf: "center",
    backgroundColor: "#111827",
    paddingHorizontal: 28,
    paddingVertical: 18,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#1f2937",
  },
  buttonActive: { backgroundColor: "#2563eb" },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: "#ffffff", fontSize: 16, fontWeight: "600" },

  toggleButton: {
    backgroundColor: "#111827",
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#1f2937",
  },
  toggleButtonText: { color: "#ffffff", fontSize: 18, fontWeight: "600" },

  error: { color: "#f87171", textAlign: "center" },
});

