# UT Dallas Software Engineering Capstone Project
## Group 8 – Fall 2025

# DOE Oracle LLM – Combinatorial Testing Research Assistant

> **A specialized AI system for querying Dr. Wong’s combinatorial testing research papers**

## Overview

The **DOE Oracle LLM** is an intelligent research assistant built using **Retrieval-Augmented Generation (RAG)**. It answers questions about combinatorial testing using only Dr. Wong’s published research papers. The system includes:

- A custom fine-tuned **CombinatorialExpert** model
- A vector database created from the research PDFs
- A Flask backend + React frontend
- Accurate, citation-backed responses pulled directly from indexed papers

## Key Features
- **Research-Grounded Answers** — Only uses provided research papers
- **Automatic Citations** — Includes page numbers and sources
- **Specialized Expert Model** — Tuned for combinatorial testing
- **Fast Local Inference** — Runs on your machine using Ollama
- **Modern UI** — React frontend with smooth interaction

---

# Quick Start Guide (UPDATED FOR FALL 2025 VERSION)

## Prerequisites
You must have:
- **Python 3.8+**
- **Git**
- **Node.js + npm**
- **Ollama installed**
- Works on Windows, macOS, or Linux

---

# 1. Clone the Updated Repository
```bash
git clone https://github.com/ShreyaaArun/DOE-LLM-App-Fall2025.git
cd DOE-LLM-App-Fall2025
```

---

# 2. Install Ollama (Critical Requirement)
Download from: https://ollama.com/download

Verify installation:
```bash
ollama --version
```

---

# 3. Download Required Models
```bash
ollama pull llama3.2
ollama pull nomic-embed-text
```

---

# 4. Set Up Python Environment

### macOS/Linux:
```bash
python3 -m venv venv
source venv/bin/activate
```

### Windows:
```cmd
python -m venv venv
venv\Scripts\activate
```

---

# 5. Install Dependencies
```bash
pip install -r requirements.txt
```

---

# 6. NEW REQUIRED INSTALLS (Fall 2025)
### Still inside DOE-LLM-App-Fall2025 root folder:
```bash
brew install ffmpeg
source venv/bin/activate
pip install flask flask-cors openai-whisper torch
```

---

# 7. Start Backend
```bash
flask --app doe run --debug
```

Backend runs at:
```
http://127.0.0.1:5000
```

---

# 8. Start Frontend (Updated Steps)
Go to the frontend folder:
```bash
cd doe-frontend
npm install
npm install lottie-react
npm run dev
```

Frontend runs at:
```
http://localhost:5173
```

---

# Usage

## Backend Only
```json
POST /api/search
{
  "query": "What is combinatorial testing?"
}
```

## Full Application
- Open **http://localhost:5173**
- Ask questions about combinatorial testing
- Receive citations with page numbers

---

# Project Structure
```
DOE-LLM-App-Fall2025/
├── doe/
├── doe-frontend/
├── instance/
│   ├── research_papers/
│   ├── vector_store/
│   └── knowledge/
├── rag_system.py
├── setup_combinatorial_model.py
├── requirements.txt
└── README.md
```

---

# Troubleshooting

### Ollama Not Found
```bash
ollama serve
```

### Model Missing
```bash
python setup_combinatorial_model.py
```

### Virtual Environment Not Activated
```bash
source venv/bin/activate
```

---

# Success Checklist
- [ ] Ollama installed
- [ ] Models downloaded
- [ ] CombinatorialExpert model created
- [ ] Virtual environment active
- [ ] Backend running on port 5000
- [ ] Frontend running on port 5173

<img width="432" height="640" alt="image" src="https://github.com/user-attachments/assets/45247c11-928b-4843-8016-679d1fecea58" />
