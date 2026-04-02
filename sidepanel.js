// ── State ──
let recognition = null;
let isListening = false;
let fullTranscript = [];  // Array of {time, text, isQuestion}
let pendingText = '';
let audioSource = 'mic';  // 'mic' or 'tab'
let tabStream = null;

// ── DOM ──
const toggleBtn    = document.getElementById('toggle-btn');
const statusEl     = document.getElementById('status');
const transcriptEl = document.getElementById('transcript');
const interimEl    = document.getElementById('interim');
const answersEl    = document.getElementById('answers');
const apiKeyInput  = document.getElementById('api-key');
const saveKeyBtn   = document.getElementById('save-key');
const autoAnswerCb = document.getElementById('auto-answer');
const langSelect   = document.getElementById('language');
const manualInput  = document.getElementById('manual-question');
const askBtn       = document.getElementById('ask-btn');
const srcMicBtn    = document.getElementById('src-mic');
const srcTabBtn    = document.getElementById('src-tab');

// ── Init ──
chrome.storage.local.get(['apiKey', 'autoAnswer', 'language', 'audioSource'], (data) => {
  if (data.apiKey) apiKeyInput.value = data.apiKey;
  if (data.autoAnswer !== undefined) autoAnswerCb.checked = data.autoAnswer;
  if (data.language) langSelect.value = data.language;
  if (data.audioSource) {
    audioSource = data.audioSource;
    srcMicBtn.classList.toggle('active', audioSource === 'mic');
    srcTabBtn.classList.toggle('active', audioSource === 'tab');
  }
});

// ── Settings handlers ──
saveKeyBtn.addEventListener('click', () => {
  chrome.storage.local.set({ apiKey: apiKeyInput.value.trim() });
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

srcMicBtn.addEventListener('click', () => {
  audioSource = 'mic';
  srcMicBtn.classList.add('active');
  srcTabBtn.classList.remove('active');
  chrome.storage.local.set({ audioSource: 'mic' });
  if (isListening) { stopListening(); startListening(); }
});

srcTabBtn.addEventListener('click', () => {
  audioSource = 'tab';
  srcTabBtn.classList.add('active');
  srcMicBtn.classList.remove('active');
  chrome.storage.local.set({ audioSource: 'tab' });
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
  askClaude(q, true);
}

// ── Start listening ──
async function startListening() {
  if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
    statusEl.textContent = 'Speech Recognition not supported in this browser';
    return;
  }

  // Request microphone permission first — side panel won't get it otherwise
  statusEl.textContent = 'Requesting microphone access...';
  try {
    const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Stop the stream immediately — we just needed the permission grant
    micStream.getTracks().forEach(t => t.stop());
  } catch (err) {
    statusEl.textContent = 'Microphone access denied — check browser permissions';
    console.error('Mic permission error:', err);
    return;
  }

  // If tab mode, capture tab audio first
  if (audioSource === 'tab') {
    try {
      // Request tab capture via background
      const streamId = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: 'captureTab' }, (response) => {
          if (response && response.streamId) resolve(response.streamId);
          else reject(new Error(response?.error || 'Tab capture failed'));
        });
      });

      tabStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId
          }
        }
      });

      // We need to play the tab audio back so the user still hears it
      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(tabStream);
      source.connect(audioCtx.destination);

    } catch (err) {
      console.error('Tab capture error:', err);
      statusEl.textContent = 'Tab capture failed - using mic';
      audioSource = 'mic';
      srcMicBtn.classList.add('active');
      srcTabBtn.classList.remove('active');
    }
  }

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = langSelect.value;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    isListening = true;
    toggleBtn.textContent = 'Stop';
    toggleBtn.className = 'stop';
    statusEl.textContent = 'Listening...';
    statusEl.className = 'listening';
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
      statusEl.textContent = 'Microphone access denied';
      stopListening();
    } else if (event.error === 'no-speech') {
      // Auto-restart on silence
      statusEl.textContent = 'No speech detected...';
    } else {
      statusEl.textContent = `Error: ${event.error}`;
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
    statusEl.textContent = 'Starting...';
  } catch (e) {
    statusEl.textContent = 'Failed to start: ' + e.message;
    console.error('Recognition start error:', e);
    isListening = false;
  }
}

function stopListening() {
  isListening = false;
  if (recognition) {
    recognition.onend = null;
    recognition.stop();
    recognition = null;
  }
  if (tabStream) {
    tabStream.getTracks().forEach(t => t.stop());
    tabStream = null;
  }
  toggleBtn.textContent = 'Start Transcribing';
  toggleBtn.className = 'start';
  statusEl.textContent = 'Stopped';
  statusEl.className = '';
  interimEl.textContent = '';
}

// ── Process final transcript text ──
function processFinalText(text) {
  if (!text) return;

  // Accumulate into sentences
  pendingText += (pendingText ? ' ' : '') + text;

  // Check if we have a complete sentence
  const sentenceEnd = /[.!?]$/;
  if (sentenceEnd.test(pendingText) || pendingText.length > 200) {
    const sentence = pendingText.trim();
    pendingText = '';

    const isQuestion = detectQuestion(sentence);
    const entry = {
      time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      text: sentence,
      isQuestion
    };
    fullTranscript.push(entry);
    renderTranscriptLine(entry);

    // Auto-answer questions
    if (isQuestion && autoAnswerCb.checked) {
      askClaude(sentence, false);
    }
  } else {
    // Still accumulating - show as a line anyway after a pause
    clearTimeout(window._flushTimer);
    window._flushTimer = setTimeout(() => {
      if (pendingText.trim()) {
        const sentence = pendingText.trim();
        pendingText = '';
        const isQuestion = detectQuestion(sentence);
        const entry = {
          time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          text: sentence,
          isQuestion
        };
        fullTranscript.push(entry);
        renderTranscriptLine(entry);
        if (isQuestion && autoAnswerCb.checked) {
          askClaude(sentence, false);
        }
      }
    }, 3000);
  }
}

// ── Question detection ──
function detectQuestion(text) {
  const lower = text.toLowerCase().trim();

  // Ends with question mark
  if (lower.endsWith('?')) return true;

  // Starts with question words
  const questionStarts = /^(what|why|how|when|where|who|which|can|could|would|should|is|are|do|does|did|will|have|has|tell me|explain|define|describe)\b/i;
  if (questionStarts.test(lower)) return true;

  // Contains question phrases
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
async function askClaude(question, isManual) {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    addAnswer(question, 'Please enter your Claude API key first.');
    return;
  }

  const cardId = addAnswer(question, 'Thinking...', true);

  // Build context from recent transcript
  const recentLines = fullTranscript.slice(-30).map(e => `[${e.time}] ${e.text}`).join('\n');

  const systemPrompt = `You are a helpful AI assistant listening to a live conversation/audio.
You have access to the recent transcript below. Answer questions concisely and clearly.
If the question is about something said in the conversation, reference the relevant part.
Keep answers brief (2-4 sentences) unless more detail is needed.
If asked "what does X mean", give a clear definition.`;

  const userMessage = isManual
    ? `Recent transcript:\n${recentLines}\n\nUser question: ${question}`
    : `Recent transcript:\n${recentLines}\n\nA question was just asked in the conversation: "${question}"\n\nProvide a helpful answer.`;

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
  // Basic markdown-like formatting
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
