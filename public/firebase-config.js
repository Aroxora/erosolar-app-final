// Public Firebase web config. These values are NOT secrets — they identify the
// project to the client SDK and are safe to ship. Real secrets (DeepSeek /
// Tavily API keys) live only in the Cloud Function via Secret Manager.
export const firebaseConfig = {
  apiKey: "AIzaSyBEe5oK47y79SQm1QBSriBcBn8j_3CdB2M",
  authDomain: "erosolar-coder-506ae.firebaseapp.com",
  projectId: "erosolar-coder-506ae",
  storageBucket: "erosolar-coder-506ae.firebasestorage.app",
  messagingSenderId: "331671595471",
  appId: "1:331671595471:web:79c2952f3644e6b5140aba",
  measurementId: "G-KPM6PF5XVT",
};

// The chat backend is called DIRECTLY at its Cloud Run URL rather than through
// the Firebase Hosting /api rewrite: Hosting buffers rewrite responses and caps
// them at ~60s, which prevents SSE streaming and 502s on long answers. Calling
// Cloud Run directly gives true token streaming and the function's 300s timeout.
// (CORS is enabled on the function; auth is still enforced via the ID token.)
export const apiBase = "https://api-jtgd5ydvyq-uc.a.run.app";
