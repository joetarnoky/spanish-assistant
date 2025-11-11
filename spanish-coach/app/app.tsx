import React, { useEffect, useReducer, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator, Platform } from "react-native";
import { Audio } from "expo-av";
// import * as FileSystem from "expo-file-system";

// ⬅️ Paste your backend URL (ngrok or Vercel)
// e.g. "https://nonlethally-ostracizable-janey.ngrok-free.dev/api/turn"
const API_URL = "https://nonlethally-ostracizable-janey.ngrok-free.dev/api/turn";

// --- Tiny FSM ---
type State = "idle" | "listening" | "uploading" | "speaking" | "error";
type Event =
  | { type: "PRESS_DOWN" }
  | { type: "PRESS_UP" }
  | { type: "UPLOAD_START" }
  | { type: "UPLOAD_OK" }
  | { type: "UPLOAD_ERR" }
  | { type: "PLAY_END" }
  | { type: "CANCEL" };

function reducer(state: State, ev: Event): State {
  switch (state) {
    case "idle":
      if (ev.type === "PRESS_DOWN") return "listening";
      return state;
    case "listening":
      if (ev.type === "PRESS_UP") return "uploading";
      if (ev.type === "CANCEL") return "idle";
      return state;
    case "uploading":
      if (ev.type === "UPLOAD_OK") return "speaking";
      if (ev.type === "UPLOAD_ERR") return "error";
      return state;
    case "speaking":
      if (ev.type === "PLAY_END") return "idle";
      return state;
    case "error":
      if (ev.type === "CANCEL") return "idle";
      return state;
  }
}

// --- Component ---
export default function App() {
  const [state, dispatch] = useReducer(reducer, "idle");
  const recordingRef = useRef<Audio.Recording | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    // Ask mic permission once
    (async () => {
      await Audio.requestPermissionsAsync();
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: true,
      });
    })();
  }, []);

  async function startRecording() {
    try {
      dispatch({ type: "PRESS_DOWN" });
      const rec = new Audio.Recording();
      await rec.prepareToRecordAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );
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

      // Build multipart form (React Native needs a cast for file objects)
      const filename =
        uri.split("/").pop() ?? `turn.${Platform.OS === "ios" ? "caf" : "m4a"}`;

      const file: any = {
        uri,
        name: filename,
        type: Platform.OS === "ios" ? "audio/caf" : "audio/m4a",
      };

      const form = new FormData();
      form.append("audio", file);

      setErrorMsg(null);
      dispatch({ type: "UPLOAD_START" });

      // IMPORTANT: don't set Content-Type manually; let RN set the boundary
      const resp = await fetch(API_URL, {
        method: "POST",
        body: form,
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Backend ${resp.status}: ${text}`);
      }

      const json = await resp.json();
      const base64 = json.audioBase64 as string;
      if (!base64) throw new Error("No audioBase64 in response");

      // Play directly from base64 as a data URI (no disk write needed)
      if (soundRef.current) {
        try { await soundRef.current.stopAsync(); } catch {}
        try { await soundRef.current.unloadAsync(); } catch {}
        soundRef.current = null;
      }

      const { sound } = await Audio.Sound.createAsync({
        uri: `data:audio/mpeg;base64,${base64}`,
      });
      soundRef.current = sound;

      dispatch({ type: "UPLOAD_OK" });
      await sound.playAsync();
      sound.setOnPlaybackStatusUpdate((status: any) => {
        if (status?.didJustFinish) dispatch({ type: "PLAY_END" });
      });
    } catch (e: any) {
      setErrorMsg(e?.message ?? "Upload/play error");
      dispatch({ type: "UPLOAD_ERR" });
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Spanish Coach (v1)</Text>

      <Pressable
        style={[
          styles.button,
          state === "listening" ? styles.buttonActive : undefined,
          state !== "idle" && state !== "listening" ? styles.buttonDisabled : undefined,
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

      {state === "uploading" && <ActivityIndicator style={{ marginTop: 16 }} />}
      {errorMsg && <Text style={styles.error}>{errorMsg}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 16 },
  title: { fontSize: 20, fontWeight: "600" },
  button: {
    backgroundColor: "#111827",
    paddingHorizontal: 24,
    paddingVertical: 16,
    borderRadius: 999,
  },
  buttonActive: { backgroundColor: "#2563eb" },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: "white", fontSize: 16, fontWeight: "600" },
  error: { color: "#ef4444", textAlign: "center", marginTop: 12 },
});
