// Web Speech API wrappers. The microphone starts only from an explicit click handler.
// Note: in Chrome, SpeechRecognition sends audio to the browser vendor's speech service.
// It is not run by this project. Text input is always available.
type Recognition = {
  lang: string
  interimResults: boolean
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
}
type RecognitionCtor = new () => Recognition

const Ctor = (window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor })
const RecognitionImpl = Ctor.SpeechRecognition ?? Ctor.webkitSpeechRecognition

export const canListen = RecognitionImpl !== undefined
export const canSpeak = 'speechSynthesis' in window

export function listen(handlers: { onText: (text: string) => void; onError: (message: string) => void; onEnd: () => void }): () => void {
  if (!RecognitionImpl) {
    handlers.onError('Speech recognition is not supported in this browser. Type your request instead.')
    handlers.onEnd()
    return () => {}
  }
  const rec = new RecognitionImpl()
  rec.lang = 'en-US'
  rec.interimResults = false
  rec.onresult = (e) => handlers.onText(e.results[0]?.[0]?.transcript ?? '')
  rec.onerror = (e) =>
    handlers.onError(e.error === 'not-allowed' ? 'Microphone permission was denied. Type your request instead.' : `Speech recognition error: ${e.error}. Type your request instead.`)
  rec.onend = handlers.onEnd
  rec.start()
  return () => rec.stop()
}

export function speak(text: string, onEnd: () => void): void {
  if (!canSpeak) return onEnd()
  speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(text)
  u.onend = onEnd
  u.onerror = onEnd
  speechSynthesis.speak(u)
}

export function stopSpeaking(): void {
  if (canSpeak) speechSynthesis.cancel()
}
