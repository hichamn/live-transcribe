# Live Transcribe & AI Answer

Chrome extension that transcribes any audio from your computer in real-time and automatically answers questions using Claude AI.

## Features

- **Real-time transcription** — uses Chrome's built-in Speech Recognition (free)
- **Two audio sources** — Microphone (picks up speakers) or direct Tab Audio capture
- **Auto question detection** — detects questions by `?`, question words, and common phrases
- **AI-powered answers** — uses Claude Haiku 4.5 for fast, affordable answers
- **Manual questions** — ask your own questions about the conversation
- **Multi-language** — English, French, Spanish, Arabic, German
- **Dark theme** side panel UI

## Use Cases

- Teams/Zoom calls — get instant answers to technical questions
- YouTube videos — ask about concepts being discussed
- Lectures — real-time note-taking with AI explanations
- Meetings — automatic Q&A from spoken questions

## Install

1. Clone this repo or download as ZIP
2. Open Chrome → `chrome://extensions/`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** → select this folder

## Setup

1. Click the extension icon to open the side panel
2. Enter your [Claude API key](https://console.anthropic.com/) and click **Save**
3. Choose audio source (Mic or Tab)
4. Click **Start Transcribing**

## Requirements

- Google Chrome (or Chromium-based browser)
- Claude API key from [Anthropic Console](https://console.anthropic.com/)
