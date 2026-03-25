# ai-comic-grader

Personal CGC comic book grading and collection tracker. Built with Claude.

## Setup

### 1. Create a Google Account
Go to accounts.google.com and create a free Google account if you don't have one.

### 2. Create a Firebase Project
1. Go to **console.firebase.google.com**
2. Click **"Create a project"**
3. Name it `ai-comic-grader` (or anything you like)
4. Disable Google Analytics (not needed) → click **Create project**
5. Once created, click **"Web"** (the `</>` icon) to add a web app
6. Name it `ai-comic-grader` → click **Register app**
7. You'll see a `firebaseConfig` object — **copy the entire thing**

### 3. Enable Firestore
1. In the Firebase Console left sidebar, click **Firestore Database**
2. Click **Create database**
3. Choose **Start in test mode** → click **Next**
4. Choose a location (us-central1 is fine) → click **Done**

### 4. Add Firebase Config to the App
Open `index.html` and find this section near the top:

```javascript
const firebaseConfig = {
  apiKey: "REPLACE_WITH_YOUR_API_KEY",
  authDomain: "REPLACE_WITH_YOUR_AUTH_DOMAIN",
  projectId: "REPLACE_WITH_YOUR_PROJECT_ID",
  ...
};
```

Replace the entire object with the config you copied from Firebase.

### 5. Create GitHub Repository
1. Go to **github.com** and sign in
2. Click **"New repository"**
3. Name it `ai-comic-grader`
4. Set to **Public**
5. Click **Create repository**

### 6. Upload Files
Upload these files to your GitHub repo:
- `index.html`
- `manifest.json`
- `sw.js`
- `README.md`
- `icon-192.png` (optional — add a comic-themed icon)
- `icon-512.png` (optional)

To upload: on the repo page, click **"uploading an existing file"**, drag all files in, commit.

### 7. Enable GitHub Pages
1. In your repo, go to **Settings → Pages**
2. Under "Source", select **Deploy from a branch**
3. Select **main** branch, **/ (root)** folder
4. Click **Save**

Your app will be live at: `https://[your-github-username].github.io/ai-comic-grader`

It may take 1-2 minutes to deploy. Refresh until it appears.

### 8. Install to iPhone
1. Open the URL in Safari
2. Tap the **Share** button (box with arrow)
3. Tap **"Add to Home Screen"**
4. The app installs like a native app

## First Launch
On first launch, the app will seed all 114 books from the built-in data into your Firestore database. This takes about 30 seconds. After that, all data lives in Firebase and syncs across devices instantly.

## Adding New Books
Upload photos in Claude, get an assessment, confirm the grade — Claude will give you the entry data to add via the app's Add Book form, or push it directly to the JSX for the artifact version.
