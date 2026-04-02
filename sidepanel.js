// ── State ──
let isListening = false;
let mediaStream = null;
let micStream = null;
let mixedStream = null;
let audioCtx = null;
let mediaRecorder = null;
let dgSocket = null;
let fullTranscript = [];  // Array of {time, text, isQuestion}

// ── DOM ──
const toggleBtn     = document.getElementById('toggle-btn');
const statusEl      = document.getElementById('status');
const transcriptEl  = document.getElementById('transcript');
const interimEl     = document.getElementById('interim');
const answersEl     = document.getElementById('answers');
const deepgramInput = document.getElementById('deepgram-key');
const claudeInput   = document.getElementById('claude-key');
const saveKeysBtn   = document.getElementById('save-keys');
const autoAnswerCb  = document.getElementById('auto-answer');
const langSelect    = document.getElementById('language');
const manualInput   = document.getElementById('manual-question');
const askBtn        = document.getElementById('ask-btn');
const infoBanner    = document.getElementById('info-banner');

// ── Init ──
chrome.storage.local.get(['deepgramKey', 'claudeKey', 'autoAnswer', 'language'], (data) => {
  if (data.deepgramKey) deepgramInput.value = data.deepgramKey;
  if (data.claudeKey) claudeInput.value = data.claudeKey;
  if (data.autoAnswer !== undefined) autoAnswerCb.checked = data.autoAnswer;
  if (data.language) langSelect.value = data.language;
});

// ── Settings ──
saveKeysBtn.addEventListener('click', () => {
  chrome.storage.local.set({
    deepgramKey: deepgramInput.value.trim(),
    claudeKey: claudeInput.value.trim()
  });
  saveKeysBtn.textContent = 'Saved!';
  setTimeout(() => saveKeysBtn.textContent = 'Save', 1500);
});

autoAnswerCb.addEventListener('change', () => {
  chrome.storage.local.set({ autoAnswer: autoAnswerCb.checked });
});

langSelect.addEventListener('change', () => {
  chrome.storage.local.set({ language: langSelect.value });
});

// ── Toggle ──
toggleBtn.addEventListener('click', () => {
  if (isListening) stopListening();
  else startListening();
});

// ── Manual question ──
askBtn.addEventListener('click', () => sendManualQuestion());
manualInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendManualQuestion();
});

function sendManualQuestion() {
  const q = manualInput.value.trim();
  if (!q) return;
  manualInput.value = '';
  askClaude(q);
}

// ── Start: capture system audio + connect Deepgram ──
async function startListening() {
  const dgKey = deepgramInput.value.trim();
  if (!dgKey) {
    setStatus('Enter your Deepgram API key first', 'error');
    return;
  }

  // Show instructions
  infoBanner.style.display = 'block';
  setStatus('Select audio source...', '');

  try {
    // Capture system/tab audio via screen share picker
    mediaStream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: { width: 1, height: 1 }  // minimal video (required by API)
    });

    // Stop the video track — we only need audio
    mediaStream.getVideoTracks().forEach(t => t.stop());

    // Check we actually got an audio track
    const systemAudioTracks = mediaStream.getAudioTracks();
    if (systemAudioTracks.length === 0) {
      setStatus('No audio captured — make sure "Share audio" was checked!', 'error');
      infoBanner.style.display = 'block';
      return;
    }

    infoBanner.style.display = 'none';
    setStatus('Requesting microphone...', '');

    // Also capture mic so the user can speak/ask questions
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (micErr) {
      console.warn('Mic not available, using system audio only:', micErr);
      micStream = null;
    }

    // Mix system audio + mic into one stream
    audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();

    const systemSource = audioCtx.createMediaStreamSource(mediaStream);
    systemSource.connect(dest);

    if (micStream) {
      const micSource = audioCtx.createMediaStreamSource(micStream);
      micSource.connect(dest);
    }

    mixedStream = dest.stream;

    setStatus('Connecting to Deepgram...', '');

    // Connect to Deepgram WebSocket
    const lang = langSelect.value;
    const dgUrl = `wss://api.deepgram.com/v1/listen?model=nova-2&language=${lang}&smart_format=true&interim_results=true&utterance_end_ms=1500&vad_events=true&endpointing=300`;

    dgSocket = new WebSocket(dgUrl, ['token', dgKey]);

    dgSocket.onopen = () => {
      isListening = true;
      toggleBtn.textContent = 'Stop';
      toggleBtn.className = 'stop';
      setStatus(micStream ? 'Listening (speaker + mic)...' : 'Listening (speaker only)...', 'listening');

      // Start recording the mixed stream and streaming to Deepgram
      mediaRecorder = new MediaRecorder(mixedStream, {
        mimeType: 'audio/webm;codecs=opus'
      });

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0 && dgSocket && dgSocket.readyState === WebSocket.OPEN) {
          dgSocket.send(e.data);
        }
      };

      mediaRecorder.start(250);  // Send chunks every 250ms for real-time feel
    };

    dgSocket.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === 'Results') {
        const alt = data.channel?.alternatives?.[0];
        if (!alt) return;

        const text = alt.transcript?.trim();
        if (!text) return;

        if (data.is_final) {
          // Final result — add to transcript
          const isQuestion = detectQuestion(text);
          const entry = {
            time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
            text,
            isQuestion
          };
          fullTranscript.push(entry);
          renderTranscriptLine(entry);
          interimEl.textContent = '';

          // Auto-answer questions
          if (isQuestion && autoAnswerCb.checked) {
            askClaude(text);
          }
        } else {
          // Interim result — show as preview
          interimEl.textContent = `...${text}`;
        }
      }
    };

    dgSocket.onerror = (err) => {
      console.error('Deepgram WebSocket error:', err);
      setStatus('Deepgram connection error — check API key', 'error');
    };

    dgSocket.onclose = (event) => {
      console.log('Deepgram closed:', event.code, event.reason);
      if (isListening) {
        setStatus('Deepgram disconnected — click Start to reconnect', 'error');
        stopListening();
      }
    };

    // Handle stream ending (user stops sharing)
    systemAudioTracks[0].onended = () => {
      setStatus('Audio sharing stopped', '');
      stopListening();
    };

  } catch (err) {
    console.error('Capture error:', err);
    if (err.name === 'NotAllowedError') {
      setStatus('Audio capture cancelled', '');
    } else {
      setStatus('Error: ' + err.message, 'error');
    }
    infoBanner.style.display = 'none';
  }
}

function stopListening() {
  isListening = false;

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  mediaRecorder = null;

  if (dgSocket) {
    // Send close message to Deepgram
    if (dgSocket.readyState === WebSocket.OPEN) {
      dgSocket.send(JSON.stringify({ type: 'CloseStream' }));
    }
    dgSocket.close();
    dgSocket = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }

  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
  }

  if (audioCtx) {
    audioCtx.close();
    audioCtx = null;
  }

  mixedStream = null;

  toggleBtn.textContent = 'Start Transcribing';
  toggleBtn.className = 'start';
  interimEl.textContent = '';
  infoBanner.style.display = 'none';
  if (statusEl.className !== 'error') {
    setStatus('Stopped', '');
  }
}

function setStatus(text, className) {
  statusEl.textContent = text;
  statusEl.className = className || '';
}

// ── Question detection ──
function detectQuestion(text) {
  const lower = text.toLowerCase().trim();
  if (lower.endsWith('?')) return true;

  const questionStarts = /^(what|why|how|when|where|who|which|can|could|would|should|is|are|do|does|did|will|have|has|tell me|explain|define|describe)\b/i;
  if (questionStarts.test(lower)) return true;

  const questionPhrases = /\b(what does|what is|what are|how do|how does|how can|what's|who's|where's|why is|why do|can you|could you|tell me about|what do you mean|what does .+ mean)\b/i;
  if (questionPhrases.test(lower)) return true;

  return false;
}

// ── Render transcript line ──
function renderTranscriptLine(entry) {
  const div = document.createElement('div');
  div.className = 'transcript-line' + (entry.isQuestion ? ' question' : '');
  div.innerHTML = `<span class="time">${entry.time}</span>${escapeHtml(entry.text)}`;
  transcriptEl.appendChild(div);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// ── Ask Claude ──
async function askClaude(question) {
  const apiKey = claudeInput.value.trim();
  if (!apiKey) {
    addAnswer(question, 'Enter your Claude API key to get AI answers.');
    return;
  }

  const cardId = addAnswer(question, 'Thinking...', true);

  // Build context from recent transcript
  const recentLines = fullTranscript.slice(-40).map(e => `[${e.time}] ${e.text}`).join('\n');

  const systemPrompt = `You are a helpful AI assistant listening to a live conversation/audio.
You have access to the recent transcript below. Answer questions concisely and clearly.
If the question is about something said in the conversation, reference the relevant part.
Keep answers brief (2-4 sentences) unless more detail is needed.
If asked "what does X mean", give a clear definition.`;

  const userMessage = `Recent transcript:\n${recentLines}\n\nQuestion: "${question}"\n\nProvide a helpful answer.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || `API error ${response.status}`);
    }

    const data = await response.json();
    const answer = data.content[0].text;
    updateAnswer(cardId, answer);
  } catch (err) {
    updateAnswer(cardId, `Error: ${err.message}`);
  }
}

// ── Answer UI ──
let answerCounter = 0;

function addAnswer(question, text, loading = false) {
  const id = `answer-${++answerCounter}`;
  const card = document.createElement('div');
  card.className = 'answer-card' + (loading ? ' loading' : '');
  card.id = id;
  card.innerHTML = `
    <div class="question-text">Q: ${escapeHtml(question)}</div>
    <div class="answer-text">${escapeHtml(text)}</div>
  `;
  answersEl.insertBefore(card, answersEl.firstChild);
  return id;
}

function updateAnswer(id, text) {
  const card = document.getElementById(id);
  if (!card) return;
  card.classList.remove('loading');
  card.querySelector('.answer-text').innerHTML = formatAnswer(text);
}

function formatAnswer(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
