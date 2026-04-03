// ── State ──
let recognition = null;
let isListening = false;
let fullTranscript = [];
let pendingText = '';

// ── DOM ──
const toggleBtn    = document.getElementById('toggle-btn');
const statusEl     = document.getElementById('status');
const transcriptEl = document.getElementById('transcript');
const interimEl    = document.getElementById('interim');
const answersEl    = document.getElementById('answers');
const claudeInput  = document.getElementById('claude-key');
const saveKeyBtn   = document.getElementById('save-key');
const autoAnswerCb = document.getElementById('auto-answer');
const langSelect   = document.getElementById('language');
const manualInput  = document.getElementById('manual-question');
const askBtn       = document.getElementById('ask-btn');

// ── Init ──
chrome.storage.local.get(['claudeKey', 'autoAnswer', 'language'], (data) => {
  if (data.claudeKey) claudeInput.value = data.claudeKey;
  if (data.autoAnswer !== undefined) autoAnswerCb.checked = data.autoAnswer;
  if (data.language) langSelect.value = data.language;
});

// ── Settings ──
saveKeyBtn.addEventListener('click', () => {
  chrome.storage.local.set({ claudeKey: claudeInput.value.trim() });
  saveKeyBtn.textContent = 'Saved!';
  setTimeout(() => saveKeyBtn.textContent = 'Save', 1500);
});

autoAnswerCb.addEventListener('change', () => {
  chrome.storage.local.set({ autoAnswer: autoAnswerCb.checked });
});

langSelect.addEventListener('change', () => {
  chrome.storage.local.set({ language: langSelect.value });
  if (isListening) { stopListening(); startListening(); }
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

// ── Start listening via mic ──
async function startListening() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    setStatus('Speech Recognition not supported', 'error');
    return;
  }

  setStatus('Requesting microphone...', '');

  // Request mic permission — this window CAN show the browser prompt
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop()); // just needed the permission
  } catch (err) {
    setStatus('Mic denied — click the camera icon in the address bar to allow', 'error');
    return;
  }

  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = langSelect.value;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    isListening = true;
    toggleBtn.textContent = 'Stop';
    toggleBtn.className = 'stop';
    setStatus('Listening — speak or play audio through speakers', 'listening');
  };

  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0].transcript.trim();
      if (result.isFinal) {
        processFinalText(text);
      } else {
        interim += text;
      }
    }
    interimEl.textContent = interim ? `...${interim}` : '';
  };

  recognition.onerror = (event) => {
    console.error('Speech error:', event.error);
    if (event.error === 'not-allowed') {
      setStatus('Mic blocked — check browser permissions', 'error');
      stopListening();
    } else if (event.error === 'no-speech') {
      setStatus('Listening (no speech detected yet)...', 'listening');
    } else if (event.error === 'network') {
      setStatus('Network error — check internet connection', 'error');
    } else {
      setStatus(`Error: ${event.error}`, 'error');
    }
  };

  recognition.onend = () => {
    // Auto-restart if still supposed to be listening
    if (isListening) {
      try { recognition.start(); } catch(e) {}
    }
  };

  try {
    recognition.start();
  } catch (e) {
    setStatus('Failed: ' + e.message, 'error');
  }
}

function stopListening() {
  isListening = false;
  if (recognition) {
    recognition.onend = null;
    recognition.stop();
    recognition = null;
  }
  toggleBtn.textContent = 'Start Transcribing';
  toggleBtn.className = 'start';
  interimEl.textContent = '';
  setStatus('Stopped', '');
}

function setStatus(text, className) {
  statusEl.textContent = text;
  statusEl.className = className || '';
}

// ── Process final text into sentences ──
function processFinalText(text) {
  if (!text) return;
  pendingText += (pendingText ? ' ' : '') + text;

  const sentenceEnd = /[.!?]$/;
  if (sentenceEnd.test(pendingText) || pendingText.length > 150) {
    flushPending();
  } else {
    clearTimeout(window._flushTimer);
    window._flushTimer = setTimeout(flushPending, 2000);
  }
}

function flushPending() {
  clearTimeout(window._flushTimer);
  const sentence = pendingText.trim();
  pendingText = '';
  if (!sentence) return;

  const isQuestion = detectQuestion(sentence);
  const entry = {
    time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    text: sentence,
    isQuestion
  };
  fullTranscript.push(entry);
  renderTranscriptLine(entry);

  if (isQuestion && autoAnswerCb.checked) {
    askClaude(sentence);
  }
}

// ── Question detection ──
function detectQuestion(text) {
  const lower = text.toLowerCase().trim();
  if (lower.endsWith('?')) return true;
  if (/^(what|why|how|when|where|who|which|can|could|would|should|is|are|do|does|did|will|have|has|tell me|explain|define|describe)\b/i.test(lower)) return true;
  if (/\b(what does|what is|what are|how do|how does|how can|what's|who's|where's|why is|why do|can you|could you|tell me about|what do you mean|what does .+ mean)\b/i.test(lower)) return true;
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
    updateAnswer(cardId, data.content[0].text);
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
