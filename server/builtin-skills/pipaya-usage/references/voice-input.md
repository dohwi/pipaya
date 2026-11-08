# Voice input (dictation)

The client can record from the microphone and put the transcript into the message box at the caret. It is built into
the app (no extension needed) and **off until it is set up**.

## Where the settings are

Settings > **Voice input** (a server section: the settings belong to that server and every device sees them). The key
is stored on the server and never sent back; the screen only says whether one is saved.

| Field | What it is |
|---|---|
| Use voice input | the on/off switch |
| Server address | the transcription server's origin, e.g. `https://api.openai.com` (no path) |
| Path | the request path; empty means `/v1/audio/transcriptions`. Gateways often mount it elsewhere (`/v0/management/audio/transcriptions`) |
| Model | e.g. `whisper-1`, `voxtral-mini-latest`; empty sends no model |
| Language | optional hint (`ko`); empty lets the server decide. `gpt-transcribe` is sent `languages[]` instead |
| API key | written once, never shown again; saving it empty removes it |

Any OpenAI-compatible transcription endpoint works: the server posts `multipart/form-data` with `file`, `model` and
`language` (or `languages[]`) and reads `{ "text": "..." }`.

## When the microphone shows

Three states:

- **Off** — the switch is off: no microphone in the message box.
- **Needs setup / error** — on, but no address or key, the last connection test failed, or the browser cannot record
  (an insecure page, no `MediaRecorder`). No microphone either; Settings > Voice input says what is missing.
- **Ready** — on and the last **Check connection** passed: the microphone appears next to the send button at once.

So after changing the address, path, model or key, press **Check connection**. A test sends half a second of silence;
an empty transcript counts as a pass (silence has nothing to say), while a rejected key, a wrong path or an unknown
model is reported as that specific problem. The result is kept per server on the device, so a restart does not hide a
working button.

A recording that fails while in use shows the reason in a chip beside the microphone (and as a toast). A settings
problem (rejected key, wrong path, server error) also turns the microphone off until it is checked again; a passing
network problem leaves it on.

## Recording

- **Tap** the microphone to start, tap again to stop. **Hold** it to record while held. The same two gestures work from
  the shortcut.
- While recording, a pill shows the elapsed time, a small waveform and a cancel button; it never covers the draft.
- The recording goes through the pipaya server to the transcription server; the server does not store it. The text is
  inserted at the caret and is **not** sent: review it and send it yourself.
- A recording is at most five minutes; shorter than 0.4 s counts as a tap.

## Shortcut

Settings > **Shortcuts** > **Voice input**: not bound by default (Alt+M and similar are often taken). Tap toggles,
holding records while held. The app's own shortcuts win, and a shortcut the app already uses cannot be given to it.

## Limits and platform notes

- The microphone needs a secure context: an https page, `localhost`, or the desktop app. A phone on a plain `http://`
  address cannot record (the settings screen says so).
- **Android**: the app declares `RECORD_AUDIO`; the first recording asks for the permission. Only the app's own page
  may use the microphone, and only for audio.
- **macOS**: the app declares the microphone in its Info.plist, so the system asks on the first recording.
- The extension `voice-input` (the earlier microphone button) is superseded by this. If it is still installed, disable
  or remove it: two microphone buttons with two different settings would be confusing.
