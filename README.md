## 🚀 Project Setup Guide

This guide will help you set up and run the project on your local machine.

---

## 📥 Clone the Repository

```bash
git clone https://github.com/your-username/your-repo-name.git
cd your-repo-name
```

---

## 📦 Install Dependencies

```bash
npm install
```

---

## 🔐 Environment Setup

Create a `.env` file in the root directory:

```env
MONGO_URI=your_mongodb_atlas_connection_string
Copy from mongo db atlas(cloud) btw you can paste connection string of Mongo Db compass too 
```

Make sure `.env` is added to `.gitignore`.

---

## ▶️ Running the Project

Open **three separate terminals** and run the following:

---

### 🖥️ Terminal 1 — Backend

```bash
nodemon server.js
```

or

```bash
node server.js
```

---

### 🐍 Terminal 2 — Python Service

```bash
python app.py
```

---

### 🌐 Terminal 3 — Frontend

```bash
python -m http.server 8080
```

Open in browser:

```
http://localhost:8080
```

---

## 🔄 Pull Latest Changes

```bash
git pull origin main
```

---

## 📤 Push Changes

```bash
git add .
git commit -m "your message"
git push origin main
```

---

## 📁 Project Overview

* **Node.js** — Backend API and database
* **Python** — Simulation / processing logic
* **Frontend** — UI served on port 8080

---

## ✅ Ready to Go

Start all three services and the project will be up and running.
